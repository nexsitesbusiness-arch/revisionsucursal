<?php
// Inicio de sesión con bloqueo tras intentos fallidos. Mensaje igual exista o no el usuario.
declare(strict_types=1);
require __DIR__ . '/_init.php';
if (method() !== 'POST') fail('Método no permitido.', 405);
$in = json_in();
$usuario = mb_strtolower(trim((string) ($in['usuario'] ?? '')));
$clave = (string) ($in['clave'] ?? '');
if ($usuario === '' || $clave === '') fail('Ingresa usuario y contraseña.');
$usuario = mb_substr($usuario, 0, 64);
$lk = q('SELECT intentos, bloqueado_hasta FROM intentos_login WHERE usuario = ?', [$usuario])->fetch() ?: ['intentos' => 0, 'bloqueado_hasta' => 0];
if ((int) $lk['bloqueado_hasta'] > now_ms()) {
    audit_server('Inicio de sesión bloqueado', ['usuario' => $usuario, 'resultado' => 'denegado', 'detalle' => 'demasiados intentos fallidos']);
    fail('Demasiados intentos fallidos. Espera ' . (int) ceil(((int) $lk['bloqueado_hasta'] - now_ms()) / 60000) . ' min y vuelve a intentar.', 429);
}
$u = q('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1', [$usuario])->fetch();
// Se verifica igual aunque el usuario no exista, para no revelar cuáles existen por el tiempo de respuesta.
$ok = password_verify($clave, $u['clave_hash'] ?? '$2y$10$jYDFi/XL3rNALvRzoQpCZO7qJ3PXvfx8I6Q629dYC71/4isL0Wl6.');
if (!$u || !$ok) {
    $n = (int) $lk['intentos'] + 1;
    $hasta = $n >= MAX_INTENTOS ? now_ms() + BLOQUEO_MS : 0;
    q('INSERT INTO intentos_login (usuario, intentos, bloqueado_hasta) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE intentos = VALUES(intentos), bloqueado_hasta = VALUES(bloqueado_hasta)', [$usuario, $n >= MAX_INTENTOS ? 0 : $n, $hasta]);
    audit_server('Inicio de sesión fallido', ['usuario' => $usuario, 'resultado' => 'denegado', 'detalle' => "intento $n" . ($hasta ? ' · bloqueado 5 min' : '')]);
    fail($hasta ? 'Demasiados intentos fallidos. Espera 5 min y vuelve a intentar.' : 'Usuario o contraseña incorrectos.', 401);
}
q('DELETE FROM intentos_login WHERE usuario = ?', [$usuario]);
if (password_needs_rehash($u['clave_hash'], PASSWORD_DEFAULT)) q('UPDATE usuarios SET clave_hash = ? WHERE id = ?', [password_hash($clave, PASSWORD_DEFAULT), $u['id']]);
session_regenerate_id(true);
$_SESSION['uid'] = $u['id'];
$_SESSION['csrf'] = rand_id(32);
me(true);
audit_server('Inicio de sesión');
out(['ok' => true, 'usuario' => user_public($u), 'csrf' => $_SESSION['csrf']]);
