<?php
// Maestro de productos. Todos lo leen (para escanear); solo el administrador lo cambia.
// Al auxiliar no se le envían los costos.
declare(strict_types=1);
require __DIR__ . '/_init.php';
$u = require_login();
if (method() === 'GET') {
    $r = q('SELECT valor FROM configuracion WHERE clave = "catalogo"')->fetch();
    $c = $r ? (json_decode($r['valor'], true) ?: ['items' => []]) : ['items' => []];
    if ($u['rol'] === 'auxiliar') foreach ($c['items'] as $k => $p) unset($c['items'][$k]['precio']);
    out(['ok' => true, 'catalogo' => $c]);
}
if (method() === 'PUT') {
    require_role(['admin']);
    $in = json_in();
    $items = [];
    foreach (($in['catalogo']['items'] ?? []) as $p) {
        if (!is_array($p)) continue;
        $items[] = [
            'sku' => mb_substr(trim((string) ($p['sku'] ?? '')), 0, 64), 'nombre' => mb_substr(trim((string) ($p['nombre'] ?? '')), 0, 255),
            'ean' => preg_match('/^\d{6,14}$/', (string) ($p['ean'] ?? '')) ? (string) $p['ean'] : '',
            'unidad' => mb_substr(trim((string) ($p['unidad'] ?? '')), 0, 20), 'grupo' => mb_substr(trim((string) ($p['grupo'] ?? '')), 0, 120),
            'precio' => is_numeric($p['precio'] ?? null) ? max(0, (float) $p['precio']) : 0,
        ];
    }
    if (count($items) > 100000) fail('El maestro tiene demasiados productos.');
    $c = ['items' => $items, 'actualizado' => now_ms(), 'archivo' => mb_substr((string) ($in['catalogo']['archivo'] ?? ''), 0, 200), 'precios' => mb_substr((string) ($in['catalogo']['precios'] ?? ''), 0, 200)];
    q('INSERT INTO configuracion (clave, valor, actualizado_por) VALUES ("catalogo", ?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor), actualizado_por = VALUES(actualizado_por)', [json_encode($c, JSON_UNESCAPED_UNICODE), $u['id']]);
    out(['ok' => true, 'catalogo' => $c]);
}
fail('Método no permitido.', 405);
