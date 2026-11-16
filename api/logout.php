<?php
declare(strict_types=1);
require __DIR__ . '/_init.php';
if (method() !== 'POST') fail('Método no permitido.', 405);
if (me()) audit_server('Cierre de sesión');
$_SESSION = [];
session_destroy();
out(['ok' => true]);
