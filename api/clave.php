<?php
// Cambio de la propia contraseña.
declare(strict_types=1);
require __DIR__ . '/_init.php';
if (method() !== 'POST') fail('Método no permitido.', 405);
$u = require_login();
$in = json_in();
if (!password_verify((string) ($in['actual'] ?? ''), $u['clave_hash'])) {
    audit_server('Cambio de contraseña fallido', ['resultado' => 'denegado', 'detalle' => 'contraseña actual incorrecta']);
    fail('La contraseña actual no es correcta.');
}
$nueva = (string) ($in['nueva'] ?? '');
if ($p = pass_problem($nueva, $u['usuario'])) fail($p);
q('UPDATE usuarios SET clave_hash = ? WHERE id = ?', [password_hash($nueva, PASSWORD_DEFAULT), $u['id']]);
session_regenerate_id(true);
audit_server('Cambió su contraseña');
out(['ok' => true, 'csrf' => $_SESSION['csrf']]);
