<?php
// Administración de usuarios (solo administrador).
declare(strict_types=1);
require __DIR__ . '/_init.php';
$me = require_role(['admin']);
$m = method();
$ROLES = ['admin', 'qf', 'auxiliar'];
function valid_user(array $in, array $roles): array {
    $nombre = trim((string) ($in['nombre'] ?? ''));
    $usuario = mb_strtolower(trim((string) ($in['usuario'] ?? '')));
    $rol = (string) ($in['rol'] ?? '');
    $sucursal = mb_substr(trim((string) ($in['sucursal'] ?? '')), 0, 120);
    if ($nombre === '' || !preg_match('/^[a-z0-9._\-@]{2,64}$/', $usuario)) fail('Completa el nombre y un usuario válido (letras sin tilde, números, punto, guion o @).');
    if (!in_array($rol, $roles, true)) fail('Rol no válido.');
    return [mb_substr($nombre, 0, 120), $usuario, $rol, $sucursal];
}
if ($m === 'GET') {
    $rows = q('SELECT id, usuario, nombre, rol, sucursal FROM usuarios WHERE activo = 1 ORDER BY nombre')->fetchAll();
    out(['ok' => true, 'usuarios' => $rows]);
}
$in = json_in();
if ($m === 'POST') {
    [$nombre, $usuario, $rol, $sucursal] = valid_user($in, $ROLES);
    $clave = (string) ($in['clave'] ?? '');
    if ($p = pass_problem($clave, $usuario)) fail($p);
    if (q('SELECT 1 FROM usuarios WHERE usuario = ?', [$usuario])->fetch()) fail("Ya existe el usuario $usuario.", 409);
    q('INSERT INTO usuarios (id, usuario, nombre, rol, sucursal, clave_hash) VALUES (?, ?, ?, ?, ?, ?)', [rand_id(), $usuario, $nombre, $rol, $sucursal, password_hash($clave, PASSWORD_DEFAULT)]);
    audit_server('Creó usuario', ['detalle' => "$usuario · $rol" . ($sucursal ? " · $sucursal" : '')]);
    out(['ok' => true]);
}
$id = (string) ($_GET['id'] ?? '');
$u = q('SELECT id, usuario, nombre, rol, sucursal FROM usuarios WHERE id = ? AND activo = 1', [$id])->fetch();
if (!$u) fail('Usuario no encontrado.', 404);
if ($m === 'PUT' && isset($in['clave'])) {
    $clave = (string) $in['clave'];
    if ($p = pass_problem($clave, $u['usuario'])) fail($p);
    q('UPDATE usuarios SET clave_hash = ? WHERE id = ?', [password_hash($clave, PASSWORD_DEFAULT), $id]);
    // Cierra las sesiones abiertas de ese usuario.
    q("DELETE FROM sesiones WHERE datos LIKE ?", ['%uid|s:' . strlen($id) . ':"' . $id . '"%']);
    audit_server('Cambió la contraseña de otro usuario', ['detalle' => $u['usuario']]);
    out(['ok' => true]);
}
if ($m === 'PUT') {
    [$nombre, $usuario, $rol, $sucursal] = valid_user($in, $ROLES);
    if ($id === $me['id'] && $rol !== 'admin') fail('No puedes quitarte el rol de administrador a ti mismo.');
    if (q('SELECT 1 FROM usuarios WHERE usuario = ? AND id <> ?', [$usuario, $id])->fetch()) fail("Ya existe el usuario $usuario.", 409);
    q('UPDATE usuarios SET nombre = ?, usuario = ?, rol = ?, sucursal = ? WHERE id = ?', [$nombre, $usuario, $rol, $sucursal, $id]);
    audit_server('Editó usuario', ['detalle' => "{$u['usuario']} · {$u['rol']} → $usuario · $rol" . ($sucursal ? " · $sucursal" : '')]);
    out(['ok' => true]);
}
if ($m === 'DELETE') {
    if ($id === $me['id']) fail('No puedes eliminar tu propio usuario.');
    if ($u['rol'] === 'admin' && (int) q('SELECT COUNT(*) c FROM usuarios WHERE rol = "admin" AND activo = 1')->fetch()['c'] < 2) fail('Debe quedar al menos un administrador.');
    // Se desactiva (no se borra) para conservar la trazabilidad de sus conteos y la bitácora.
    q('UPDATE usuarios SET activo = 0, usuario = CONCAT(usuario, "#", ?) WHERE id = ?', [substr(rand_id(4), 0, 8), $id]);
    q("DELETE FROM sesiones WHERE datos LIKE ?", ['%uid|s:' . strlen($id) . ':"' . $id . '"%']);
    audit_server('Eliminó usuario', ['detalle' => "{$u['usuario']} · {$u['rol']}"]);
    out(['ok' => true]);
}
fail('Método no permitido.', 405);
