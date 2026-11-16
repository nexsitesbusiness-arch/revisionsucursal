<?php
// Pedidos e inventarios. Los permisos se validan aquí, no solo en la app:
// - Auxiliar: solo lee la lista de productos (sin cantidades del sistema) y guarda su conteo.
// - QF: además revisa, hace revisiones aleatorias, aprueba y reabre.
// - Administrador: todo, incluido crear y eliminar.
declare(strict_types=1);
require __DIR__ . '/_init.php';
$u = require_login();
$m = method();

// Campos que cada rol puede cambiar en un documento.
const CAMPOS_CONTEO = ['counts', 'extras', 'evid', 'log', 'startedAt', 'venc'];
const CAMPOS_QF = ['review', 'recount', 'recountBy', 'samples'];

function load_doc(string $id): ?array {
    $r = q('SELECT id, tipo, sucursal, version, datos FROM documentos WHERE id = ?', [$id])->fetch();
    return $r ?: null;
}
function save_doc(array $d, array $u, int $version): int {
    $estado = doc_estado($d);
    unset($d['_version']);
    $res = doc_resumen($d);
    $d = doc_fix_maps($d);
    $st = q('UPDATE documentos SET nombre = ?, sucursal = ?, estado = ?, datos = ?, resumen = ?, version = version + 1, actualizado_por = ? WHERE id = ? AND version = ?',
        [mb_substr((string) ($d['nombre'] ?? ''), 0, 200), mb_substr((string) ($d['sucursal'] ?? ''), 0, 120), $estado, json_encode($d, JSON_UNESCAPED_UNICODE), json_encode($res, JSON_UNESCAPED_UNICODE), $u['id'], $d['id'], $version]);
    if ($st->rowCount() !== 1) return 0;
    return $version + 1;
}
function clean_doc(array $d): array {
    // Quita datos auxiliares que la app calcula y no deben guardarse.
    foreach ($d['items'] ?? [] as $k => $it) unset($d['items'][$k]['_hay']);
    unset($d['_version']);
    return $d;
}

if ($m === 'GET') {
    if (!empty($_GET['id'])) {
        $r = load_doc((string) $_GET['id']);
        if (!$r) fail('Documento no encontrado.', 404);
        $d = doc_row_to_obj($r);
        if (!can_see_doc($u, $d)) { audit_server('Acceso denegado a documento', ['resultado' => 'denegado', 'doc_id' => $r['id']]); fail('Documento no encontrado.', 404); }
        out(['ok' => true, 'documento' => doc_for_user($d, $u)]);
    }
    // Lista liviana: solo el resumen de cada documento (el detalle se pide al abrirlo).
    $rows = q('SELECT id, sucursal, version, resumen FROM documentos ORDER BY creado_en DESC LIMIT 500')->fetchAll();
    $list = [];
    foreach ($rows as $r) {
        if (!can_see_doc($u, ['sucursal' => $r['sucursal']])) continue;
        $res = $r['resumen'] ? (json_decode($r['resumen'], true) ?: []) : doc_resumen(doc_row_to_obj(load_doc($r['id'])));
        $list[] = ['id' => $r['id'], '_version' => (int) $r['version'], '_resumen' => true] + resumen_for_user($res, $u);
    }
    out(['ok' => true, 'documentos' => $list]);
}

$in = json_in();

if ($m === 'POST') {
    // Pedidos: solo el administrador. Inventarios: también la QF (sube el reporte de existencias de SPOS).
    require_role(['admin', 'qf']);
    $d = clean_doc($in['documento'] ?? []);
    if ($u['rol'] === 'qf') {
        if (($d['tipo'] ?? '') !== 'inventario') { audit_server('Intento de crear pedido sin permiso', ['resultado' => 'denegado']); fail('Solo el administrador puede cargar pedidos.', 403); }
        if (($d['sucursal'] ?? '') === '') $d['sucursal'] = $u['sucursal'];
        if (!can_see_doc($u, $d)) { audit_server('Intento de crear inventario de otra sucursal', ['resultado' => 'denegado', 'sucursal' => $d['sucursal']]); fail('Este reporte es de otra sucursal.', 403); }
    }
    if (empty($d['id']) || !preg_match('/^[A-Za-z0-9_\-]{6,40}$/', (string) $d['id'])) fail('Documento no válido.');
    if (!in_array($d['tipo'] ?? '', ['pedido', 'inventario'], true) || !is_array($d['items'] ?? null) || !$d['items']) fail('El documento no tiene productos.');
    if (count($d['items']) > 20000) fail('El documento tiene demasiados productos.');
    if (load_doc($d['id'])) fail('El documento ya existe.', 409);
    $d['creadoPor'] = $u['nombre'];
    $res = doc_resumen($d);
    $d = doc_fix_maps($d);
    q('INSERT INTO documentos (id, tipo, nombre, sucursal, estado, datos, resumen, creado_por, actualizado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$d['id'], $d['tipo'], mb_substr((string) ($d['nombre'] ?? ''), 0, 200), mb_substr((string) ($d['sucursal'] ?? ''), 0, 120), doc_estado($d), json_encode($d, JSON_UNESCAPED_UNICODE), json_encode($res, JSON_UNESCAPED_UNICODE), $u['id'], $u['id']]);
    out(['ok' => true, 'documento' => doc_fix_maps(doc_row_to_obj(load_doc($d['id'])))]);
}

$id = (string) ($_GET['id'] ?? '');
$r = load_doc($id);
if (!$r) fail('Documento no encontrado.', 404);
$srv = doc_row_to_obj($r);
if (!can_see_doc($u, $srv)) { audit_server('Acceso denegado a documento', ['resultado' => 'denegado', 'doc_id' => $id]); fail('Documento no encontrado.', 404); }

if ($m === 'DELETE') {
    // La QF puede eliminar un inventario mal cargado mientras nadie ha contado.
    $sinConteo = ($srv['tipo'] ?? '') === 'inventario' && empty($srv['finishedAt']) && empty((array) ($srv['counts'] ?? [])) && empty($srv['extras'] ?? []);
    if (!($u['rol'] === 'admin' || ($u['rol'] === 'qf' && $sinConteo))) { audit_server('Intento de eliminar documento sin permiso', ['resultado' => 'denegado', 'doc_id' => $id]); fail('No puedes eliminar este documento.', 403); }
    audit_server('Eliminó documento', ['doc_id' => $id, 'doc' => $srv['nombre'] ?? null, 'sucursal' => $srv['sucursal'] ?? null]);
    q('DELETE FROM evidencias WHERE documento_id = ?', [$id]);
    q('DELETE FROM documentos WHERE id = ?', [$id]);
    out(['ok' => true]);
}

if ($m === 'PUT') {
    $cli = clean_doc($in['documento'] ?? []);
    $version = (int) ($in['version'] ?? 0);
    if ($version !== (int) $r['version']) out(['ok' => false, 'error' => 'Otro equipo modificó este documento.', 'conflicto' => true, 'documento' => doc_for_user($srv, $u)], 409);
    $new = $srv;
    $rol = $u['rol'];
    $abierto = empty($srv['finishedAt']);
    $aprobado = !empty($srv['verifiedAt']);

    if ($rol === 'admin') {
        // El administrador puede corregir todo menos el identificador.
        $new = $cli;
        $new['id'] = $id;
        if (!empty($new['verifiedAt']) && empty($srv['verifiedAt'])) $new['verifiedBy'] = $u['nombre'];
    } else {
        // Conteo: solo mientras el documento está abierto.
        if ($abierto) {
            foreach (CAMPOS_CONTEO as $k) if (array_key_exists($k, $cli)) $new[$k] = $cli[$k];
            if (!empty($cli['finishedAt'])) { $new['finishedAt'] = now_ms(); $new['contadoPor'] = $u['nombre']; }
        } elseif (array_key_exists('counts', $cli) && $cli['counts'] != $srv['counts']) {
            fail('El conteo ya fue finalizado y no se puede cambiar.', 403);
        }
        if ($rol === 'qf') {
            // Las evidencias se pueden agregar también en la revisión.
            if (!$abierto && array_key_exists('evid', $cli)) $new['evid'] = $cli['evid'];
            if (!$aprobado) {
                foreach (CAMPOS_QF as $k) if (array_key_exists($k, $cli)) $new[$k] = $cli[$k];
                if (!empty($cli['verifiedAt']) && !$abierto) {
                    // Aprobar exige que todo esté revisado: lo verifica el servidor.
                    $pend = pending_reviews($new);
                    if ($pend > 0) fail("Faltan $pend productos por revisar.", 409);
                    $new['verifiedAt'] = now_ms();
                    $new['verifiedBy'] = $u['nombre'];
                }
                if (array_key_exists('finishedAt', $cli) && $cli['finishedAt'] === null && !$abierto) {
                    $new['finishedAt'] = null;
                    $new['reopened'] = (int) ($srv['reopened'] ?? 0) + 1;
                }
            }
        }
    }
    $nv = save_doc($new, $u, $version);
    if (!$nv) out(['ok' => false, 'error' => 'Otro equipo modificó este documento.', 'conflicto' => true], 409);
    $new['_version'] = $nv;
    out(['ok' => true, 'documento' => doc_for_user($new, $u)]);
}
fail('Método no permitido.', 405);

// Desviaciones y muestras sin revisión del QF (misma regla que la app).
function pending_reviews(array $d): int { return doc_resumen($d)['pendientes']; }
