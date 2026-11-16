<?php
// Bitácora central. Todos los usuarios con sesión pueden AGREGAR eventos de su propia actividad;
// solo administrador y QF pueden VERLA. El usuario, la hora, la IP y el equipo los pone el servidor.
declare(strict_types=1);
require __DIR__ . '/_init.php';
$u = require_login();
$m = method();

if ($m === 'POST') {
    $in = json_in();
    $ev = array_slice(is_array($in['eventos'] ?? null) ? $in['eventos'] : [], 0, 200);
    $now = now_ms();
    foreach ($ev as $e) {
        if (!is_array($e) || empty($e['accion'])) continue;
        // La hora del equipo se acepta solo si es razonable (eventos encolados sin conexión, máx. 3 días).
        $ts = (int) ($e['ts'] ?? $now);
        if ($ts > $now + 60000 || $ts < $now - 3 * 86400000) $ts = $now;
        audit_server((string) $e['accion'], [
            'ts_ms' => $ts, 'doc_id' => $e['docId'] ?? null, 'doc' => $e['doc'] ?? null, 'sucursal' => $e['sucursal'] ?? null,
            'producto' => $e['producto'] ?? null, 'sku' => $e['sku'] ?? null, 'detalle' => $e['detalle'] ?? null,
            'duracion_seg' => $e['duracionSeg'] ?? null, 'resultado' => $e['resultado'] ?? 'ok',
        ]);
    }
    out(['ok' => true, 'guardados' => count($ev)]);
}

if ($m === 'GET') {
    if (!in_array($u['rol'], ['admin', 'qf'], true)) {
        audit_server('Intento de ver la bitácora', ['resultado' => 'denegado']);
        fail('No tienes permiso para ver la bitácora.', 403);
    }
    if (!empty($_GET['verificar'])) {
        // Recalcula toda la cadena sin cargarla entera en memoria.
        db()->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
        $prev = '';
        $n = 0;
        $st = q('SELECT ' . implode(', ', AUDIT_FIELDS) . ', hash_anterior, hash FROM bitacora ORDER BY n ASC');
        $bad = null;
        while ($r = $st->fetch()) {
            $n++;
            if ((int) $r['n'] !== $n) { $bad = ['motivo' => 'falta un registro', 'ts' => (int) $r['ts_ms']]; break; }
            if ($r['hash_anterior'] !== $prev || hash('sha256', $prev . audit_canon($r)) !== $r['hash']) { $bad = ['motivo' => 'el registro fue modificado', 'ts' => (int) $r['ts_ms']]; break; }
            $prev = $r['hash'];
        }
        $st->closeCursor();
        db()->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
        out($bad ? ['ok' => true, 'integra' => false, 'total' => $n] + $bad : ['ok' => true, 'integra' => true, 'total' => $n]);
    }

    // Filtros (todos en el servidor, con índices) y paginación por número de registro.
    $where = [];
    $p = [];
    if ($u['rol'] === 'qf' && $u['sucursal'] !== '') { $where[] = '(sucursal = ? OR usuario_id = ? OR sucursal IS NULL)'; $p[] = $u['sucursal']; $p[] = $u['id']; }
    if (!empty($_GET['doc'])) { $where[] = 'doc_id = ?'; $p[] = (string) $_GET['doc']; }
    if (!empty($_GET['usuario_id'])) { $where[] = 'usuario_id = ?'; $p[] = (string) $_GET['usuario_id']; }
    if (!empty($_GET['usuario'])) { $where[] = 'usuario = ?'; $p[] = (string) $_GET['usuario']; }
    if (!empty($_GET['accion'])) { $where[] = 'accion = ?'; $p[] = (string) $_GET['accion']; }
    // Fechas en hora de Santiago (aaaa-mm-dd) convertidas a rango de milisegundos.
    $tz = new DateTimeZone('America/Santiago');
    if (!empty($_GET['desde']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $_GET['desde'])) { $where[] = 'ts_ms >= ?'; $p[] = (new DateTime($_GET['desde'] . ' 00:00:00', $tz))->getTimestamp() * 1000; }
    if (!empty($_GET['hasta']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $_GET['hasta'])) { $where[] = 'ts_ms < ?'; $p[] = ((new DateTime($_GET['hasta'] . ' 00:00:00', $tz))->getTimestamp() + 86400) * 1000; }
    if (isset($_GET['texto']) && trim((string) $_GET['texto']) !== '') {
        $t = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_substr(trim((string) $_GET['texto']), 0, 80)) . '%';
        $where[] = '(producto LIKE ? OR sku LIKE ? OR detalle LIKE ? OR doc LIKE ? OR nombre LIKE ?)';
        array_push($p, $t, $t, $t, $t, $t);
    }
    $W = $where ? ' WHERE ' . implode(' AND ', $where) : '';

    // Opciones para los filtros (usuarios, acciones y documentos que existen).
    if (!empty($_GET['opciones'])) {
        // Se leen de las tablas pequeñas (usuarios y documentos), no de toda la bitácora.
        $docs = q('SELECT id AS doc_id, nombre AS doc, sucursal FROM documentos ORDER BY creado_en DESC LIMIT 300')->fetchAll();
        if ($u['rol'] === 'qf' && $u['sucursal'] !== '') $docs = array_values(array_filter($docs, fn($d) => can_see_doc($u, $d)));
        out(['ok' => true,
            'usuarios' => q('SELECT usuario, nombre FROM usuarios ORDER BY nombre')->fetchAll(),
            'acciones' => array_column(q('SELECT DISTINCT accion FROM bitacora ORDER BY accion')->fetchAll(), 'accion'),
            'documentos' => array_map(fn($d) => ['doc_id' => $d['doc_id'], 'doc' => $d['doc']], $docs),
        ]);
    }

    $limit = max(1, min(50000, (int) ($_GET['limite'] ?? 200)));
    $pp = $p;
    $sql = 'SELECT n, ts_ms, usuario_id, usuario, nombre, rol, accion, doc_id, doc, sucursal, producto, sku, detalle, duracion_seg, resultado, equipo, ip, hash FROM bitacora' . $W;
    if (!empty($_GET['antes_de'])) { $sql .= ($W ? ' AND' : ' WHERE') . ' n < ?'; $pp[] = (int) $_GET['antes_de']; }
    $rows = q($sql . " ORDER BY n DESC LIMIT $limit", $pp)->fetchAll();
    $stats = null;
    if (empty($_GET['antes_de'])) {
        // Indicadores del filtro completo (no solo de la página).
        $stats = q("SELECT COUNT(*) AS registros, COUNT(DISTINCT usuario) AS usuarios,
            SUM(accion IN ('Revisó producto','Modificó revisión de producto')) AS revisiones,
            AVG(CASE WHEN accion IN ('Revisó producto','Modificó revisión de producto') THEN duracion_seg END) AS seg_revision,
            SUM(resultado = 'denegado') AS denegados FROM bitacora$W", $p)->fetch();
        $stats['total'] = (int) q('SELECT COUNT(*) c FROM bitacora')->fetch()['c'];
        if (empty($_GET['exportar'])) audit_server('Vio la bitácora', ['doc_id' => $_GET['doc'] ?? null, 'detalle' => $W ? 'con filtros' : null]);
    }
    if (!empty($_GET['exportar'])) audit_server('Exportó la bitácora', ['detalle' => count($rows) . ' registros' . ($W ? ' · con filtros' : '')]);
    out(['ok' => true, 'registros' => $rows, 'stats' => $stats]);
}
fail('Método no permitido.', 405);
