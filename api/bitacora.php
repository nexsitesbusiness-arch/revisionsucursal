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
        // Recalcula toda la cadena: si alguien alteró un registro directo en la base, se detecta.
        $prev = '';
        $n = 0;
        $st = q('SELECT * FROM bitacora ORDER BY n ASC');
        while ($r = $st->fetch()) {
            $n++;
            if ((int) $r['n'] !== $n) out(['ok' => true, 'integra' => false, 'total' => $n, 'motivo' => 'falta un registro', 'ts' => (int) $r['ts_ms']]);
            if ($r['hash_anterior'] !== $prev || hash('sha256', $prev . audit_canon($r)) !== $r['hash']) out(['ok' => true, 'integra' => false, 'total' => $n, 'motivo' => 'el registro fue modificado', 'ts' => (int) $r['ts_ms']]);
            $prev = $r['hash'];
        }
        out(['ok' => true, 'integra' => true, 'total' => $n]);
    }
    $where = [];
    $p = [];
    // El QF con sucursal asignada solo ve la actividad de su sucursal y la propia.
    if ($u['rol'] === 'qf' && $u['sucursal'] !== '') { $where[] = '(sucursal = ? OR usuario_id = ? OR sucursal IS NULL)'; $p[] = $u['sucursal']; $p[] = $u['id']; }
    if (!empty($_GET['doc'])) { $where[] = 'doc_id = ?'; $p[] = (string) $_GET['doc']; }
    $limit = max(1, min(20000, (int) ($_GET['limite'] ?? 5000)));
    $sql = 'SELECT n, ts_ms, usuario_id, usuario, nombre, rol, accion, doc_id, doc, sucursal, producto, sku, detalle, duracion_seg, resultado, equipo, ip, hash FROM bitacora'
        . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . " ORDER BY n DESC LIMIT $limit";
    $rows = q($sql, $p)->fetchAll();
    $total = (int) q('SELECT COUNT(*) c FROM bitacora')->fetch()['c'];
    audit_server('Vio la bitácora', ['doc_id' => $_GET['doc'] ?? null]);
    out(['ok' => true, 'registros' => $rows, 'total' => $total]);
}
fail('Método no permitido.', 405);
