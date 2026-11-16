<?php
// Primera configuración: crea el administrador. Solo funciona si no hay usuarios.
declare(strict_types=1);
require __DIR__ . '/_init.php';
if (method() !== 'POST') fail('Método no permitido.', 405);
if ((int) q('SELECT COUNT(*) AS c FROM usuarios')->fetch()['c'] > 0) fail('La app ya está configurada. Inicia sesión.', 409);
$in = json_in();
$nombre = trim((string) ($in['nombre'] ?? ''));
$usuario = mb_strtolower(trim((string) ($in['usuario'] ?? '')));
$clave = (string) ($in['clave'] ?? '');
if ($nombre === '' || !preg_match('/^[a-z0-9._\-@]{2,64}$/', $usuario)) fail('Completa el nombre y un usuario válido (letras sin tilde, números, punto, guion o @).');
if ($p = pass_problem($clave, $usuario)) fail($p);
db()->beginTransaction();
$n = (int) q('SELECT COUNT(*) AS c FROM usuarios FOR UPDATE')->fetch()['c'];
if ($n > 0) { db()->rollBack(); fail('La app ya está configurada. Inicia sesión.', 409); }
$id = rand_id();
q('INSERT INTO usuarios (id, usuario, nombre, rol, sucursal, clave_hash) VALUES (?, ?, ?, "admin", "", ?)', [$id, $usuario, mb_substr($nombre, 0, 120), password_hash($clave, PASSWORD_DEFAULT)]);
db()->commit();
session_regenerate_id(true);
$_SESSION['uid'] = $id;
$u = me(true);
audit_server('Configuró la app y creó el administrador', ['detalle' => $usuario]);
audit_server('Inicio de sesión');
out(['ok' => true, 'usuario' => user_public($u), 'csrf' => $_SESSION['csrf']]);
