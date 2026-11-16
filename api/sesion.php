<?php
// Devuelve el usuario con sesión y el token CSRF para las siguientes solicitudes.
declare(strict_types=1);
require __DIR__ . '/_init.php';
$u = me();
out(['ok' => true, 'usuario' => $u ? user_public($u) : null, 'csrf' => $_SESSION['csrf']]);
