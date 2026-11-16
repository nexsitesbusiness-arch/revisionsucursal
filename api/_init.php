<?php
// Arranque común de cada endpoint de la API.
declare(strict_types=1);
$lib = is_file(__DIR__ . '/../servidor/lib.php') ? __DIR__ . '/../servidor/lib.php' : __DIR__ . '/../../servidor/lib.php';
require $lib;
security_headers();
start_session();
if (method() !== 'GET') require_csrf();
