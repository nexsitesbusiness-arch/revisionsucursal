<?php
// Solo pruebas locales: carga volumen realista para medir rendimiento.
// Uso: DB_USER=root php servidor/tests/generar_volumen.php <inventarios> <registros_bitacora>
declare(strict_types=1);
require __DIR__ . '/../lib.php';
$nDocs = (int) ($argv[1] ?? 50);
$nLog = (int) ($argv[2] ?? 100000);
$admin = q('SELECT id FROM usuarios WHERE rol = "admin" LIMIT 1')->fetch()['id'] ?? null;
$sucursales = ['CL0099 CENTRO', 'CL0098 PONIENTE', 'CL0097 NORTE', 'CL0096 ORIENTE', 'CL0095 SUR'];
for ($k = 0; $k < $nDocs; $k++) {
    $items = []; $counts = [];
    for ($i = 0; $i < 1219; $i++) {
        $id = "it$k-$i";
        $items[] = ['id' => $id, 'sku' => 'CH' . (5000 + $i), 'codigo' => (string) (7800000000000 + $i), 'producto' => "PRODUCTO DE PRUEBA $i 500MG 30COMP", 'categoria' => 'MEDICAMENTOS', 'cantidad' => ($i % 40) + 1, 'lote' => '', 'precio' => 0, 'vencimiento' => ''];
        if ($i % 3) $counts[$id] = ($i % 40) + ($i % 7 === 0 ? 0 : 1);
    }
    $d = ['id' => "vol$k", 'tipo' => 'inventario', 'nombre' => "Inventario volumen $k", 'sucursal' => $sucursales[$k % 5], 'creado' => now_ms(), 'items' => $items, 'counts' => $counts, 'extras' => [], 'evid' => new stdClass(), 'log' => [], 'finishedAt' => $k % 2 ? now_ms() : null];
    q('INSERT INTO documentos (id, tipo, nombre, sucursal, estado, datos, resumen, creado_por) VALUES (?, "inventario", ?, ?, ?, ?, ?, ?)', [$d['id'], $d['nombre'], $d['sucursal'], doc_estado($d), json_encode($d), json_encode(doc_resumen($d)), $admin]);
}
$prev = q('SELECT n, hash FROM bitacora ORDER BY n DESC LIMIT 1')->fetch();
$n = $prev ? (int) $prev['n'] : 0; $h = $prev ? $prev['hash'] : '';
$acc = ['Registró cantidad', 'Revisó producto', 'Abrió conteo', 'Inicio de sesión', 'Abrió reporte de desviaciones'];
$t0 = now_ms() - $nLog * 1000;
db()->beginTransaction();
$batch = [];
for ($i = 0; $i < $nLog; $i++) {
    $n++;
    $r = ['n' => $n, 'ts_ms' => $t0 + $i * 1000, 'usuario_id' => null, 'usuario' => 'aux' . ($i % 40), 'nombre' => 'Auxiliar ' . ($i % 40), 'rol' => 'auxiliar', 'accion' => $acc[$i % 5],
        'doc_id' => 'vol' . ($i % $nDocs), 'doc' => 'Inventario volumen ' . ($i % $nDocs), 'sucursal' => $sucursales[$i % 5], 'producto' => "PRODUCTO DE PRUEBA " . ($i % 1219), 'sku' => 'CH' . (5000 + $i % 1219),
        'detalle' => '0 → ' . ($i % 30), 'duracion_seg' => $i % 5 === 1 ? 20 + $i % 60 : null, 'resultado' => 'ok', 'equipo' => 'iPad · Safari', 'ip' => '10.0.0.' . ($i % 200)];
    $r['hash_anterior'] = $h; $r['hash'] = $h = hash('sha256', $h . audit_canon($r));
    $batch[] = $r;
    if (count($batch) === 1000 || $i === $nLog - 1) {
        $cols = array_keys($batch[0]);
        $sql = 'INSERT INTO bitacora (' . implode(',', $cols) . ') VALUES ' . implode(',', array_fill(0, count($batch), '(' . implode(',', array_fill(0, count($cols), '?')) . ')'));
        $vals = []; foreach ($batch as $b) foreach ($cols as $c) $vals[] = $b[$c];
        q($sql, $vals); $batch = [];
    }
}
db()->commit();
echo "Cargados $nDocs inventarios y $nLog registros de bitácora\n";
