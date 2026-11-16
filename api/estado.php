<?php
// Indica a la app que hay servidor y si ya está configurado. No requiere sesión.
declare(strict_types=1);
require __DIR__ . '/_init.php';
$n = (int) q('SELECT COUNT(*) AS c FROM usuarios WHERE activo = 1')->fetch()['c'];
out(['ok' => true, 'modo' => 'servidor', 'configurado' => $n > 0, 'version' => 1]);
