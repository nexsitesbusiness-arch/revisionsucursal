<?php
// Fotos de evidencia. Se guardan en la base y solo se entregan a quien puede ver el documento.
declare(strict_types=1);
require __DIR__ . '/_init.php';
$u = require_login();
$m = method();

function doc_access(array $u, string $docId): array {
    $r = q('SELECT id, sucursal, estado FROM documentos WHERE id = ?', [$docId])->fetch();
    if (!$r || !can_see_doc($u, $r)) fail('Documento no encontrado.', 404);
    return $r;
}

if ($m === 'GET') {
    $ev = q('SELECT id, documento_id, mime, contenido FROM evidencias WHERE id = ?', [(string) ($_GET['id'] ?? '')])->fetch();
    if (!$ev) fail('Foto no encontrada.', 404);
    doc_access($u, $ev['documento_id']);
    header('Content-Type: ' . $ev['mime']);
    header('Content-Disposition: inline; filename="evidencia.jpg"');
    header('Cache-Control: private, max-age=86400');
    echo $ev['contenido'];
    exit;
}
if ($m === 'POST') {
    $docId = (string) ($_GET['doc'] ?? '');
    doc_access($u, $docId);
    $raw = file_get_contents('php://input') ?: '';
    if ($raw === '' || strlen($raw) > MAX_FOTO_BYTES) fail('La foto no es válida o pesa más de 5 MB.');
    // Se valida el tipo real por el contenido, no por el nombre.
    $mime = (new finfo(FILEINFO_MIME_TYPE))->buffer($raw);
    if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) fail('Solo se aceptan fotos JPG, PNG o WebP.');
    $id = rand_id();
    q('INSERT INTO evidencias (id, documento_id, mime, tamano, contenido, creado_por) VALUES (?, ?, ?, ?, ?, ?)', [$id, $docId, $mime, strlen($raw), $raw, $u['id']]);
    out(['ok' => true, 'id' => $id]);
}
if ($m === 'DELETE') {
    $ev = q('SELECT id, documento_id FROM evidencias WHERE id = ?', [(string) ($_GET['id'] ?? '')])->fetch();
    if (!$ev) out(['ok' => true]);
    $d = doc_access($u, $ev['documento_id']);
    if ($u['rol'] === 'auxiliar' && $d['estado'] !== 'abierto') fail('El conteo ya fue finalizado.', 403);
    q('DELETE FROM evidencias WHERE id = ?', [$ev['id']]);
    out(['ok' => true]);
}
fail('Método no permitido.', 405);
