<?php
// Biblioteca común de la API: conexión, sesión segura, permisos, CSRF y bitácora.
// La configuración se lee de variables de entorno (nunca credenciales en el código):
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS  (o DB_SOCKET para Cloud SQL)
declare(strict_types=1);

date_default_timezone_set('America/Santiago');
ini_set('display_errors', '0');
error_reporting(E_ALL);

const IDLE_SECONDS = 1800;          // cierre de sesión tras 30 min sin uso
const MAX_INTENTOS = 5;             // intentos fallidos antes de bloquear
const BLOQUEO_MS = 5 * 60 * 1000;   // bloqueo de 5 minutos
const MAX_FOTO_BYTES = 5 * 1024 * 1024;

// ---------- Respuestas ----------
function security_headers(): void {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
    if (is_https()) header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
}
function is_https(): bool {
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
}
function out($data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(string $msg, int $code = 400, array $extra = []): never {
    out(['ok' => false, 'error' => $msg] + $extra, $code);
}
function json_in(): array {
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > 30 * 1024 * 1024) fail('La solicitud es demasiado grande.', 413);
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}
function method(): string { return $_SERVER['REQUEST_METHOD'] ?? 'GET'; }
function now_ms(): int { return (int) round(microtime(true) * 1000); }
function rand_id(int $bytes = 16): string { return bin2hex(random_bytes($bytes)); }
function str_limit($v, int $n): ?string {
    if ($v === null) return null;
    $s = trim((string) $v);
    return $s === '' ? null : mb_substr($s, 0, $n);
}

// Errores inesperados: al cliente un mensaje genérico; el detalle va al log del servidor.
set_exception_handler(function (Throwable $e) {
    error_log('[revision] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    if (!headers_sent()) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); }
    echo json_encode(['ok' => false, 'error' => 'Ocurrió un error en el servidor. Intenta de nuevo.']);
});

// ---------- Base de datos ----------
function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $name = getenv('DB_NAME') ?: 'revision';
    $dsn = getenv('DB_SOCKET')
        ? 'mysql:unix_socket=' . getenv('DB_SOCKET') . ";dbname=$name;charset=utf8mb4"
        : 'mysql:host=' . (getenv('DB_HOST') ?: '127.0.0.1') . ';port=' . (getenv('DB_PORT') ?: '3306') . ";dbname=$name;charset=utf8mb4";
    $pdo = new PDO($dsn, getenv('DB_USER') ?: 'revision_app', getenv('DB_PASS') ?: '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $pdo->exec("SET time_zone = '-03:00'");
    return $pdo;
}
function q(string $sql, array $p = []): PDOStatement { $st = db()->prepare($sql); $st->execute($p); return $st; }

// ---------- Sesión guardada en la base ----------
class DbSession implements SessionHandlerInterface {
    public function open($path, $name): bool { return true; }
    public function close(): bool { return true; }
    public function read($id): string|false {
        $r = q('SELECT datos FROM sesiones WHERE id = ?', [$id])->fetch();
        return $r ? $r['datos'] : '';
    }
    public function write($id, $data): bool {
        q('INSERT INTO sesiones (id, datos, actualizado) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE datos = VALUES(datos), actualizado = VALUES(actualizado)', [$id, $data, time()]);
        return true;
    }
    public function destroy($id): bool { q('DELETE FROM sesiones WHERE id = ?', [$id]); return true; }
    public function gc($max): int|false { return q('DELETE FROM sesiones WHERE actualizado < ?', [time() - IDLE_SECONDS * 2])->rowCount(); }
}
function start_session(): void {
    session_set_save_handler(new DbSession(), true);
    session_name('REVSESS');
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => is_https(), 'httponly' => true, 'samesite' => 'Strict']);
    ini_set('session.use_strict_mode', '1');
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor', '100');
    session_start();
    // Cierre por inactividad, validado en el servidor.
    if (!empty($_SESSION['uid']) && time() - ($_SESSION['ultimo'] ?? 0) > IDLE_SECONDS) {
        $u = $_SESSION['uid'];
        $_SESSION = [];
        session_regenerate_id(true);
        audit_server('Sesión cerrada por inactividad', ['usuario_id' => $u]);
    }
    $_SESSION['ultimo'] = time();
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = rand_id(32);
}

// ---------- Usuario actual y permisos ----------
function user_public(array $u): array {
    return ['id' => $u['id'], 'usuario' => $u['usuario'], 'nombre' => $u['nombre'], 'rol' => $u['rol'], 'sucursal' => $u['sucursal']];
}
function me(bool $reset = false): ?array {
    static $cache = false;
    if ($reset) $cache = false;
    if ($cache !== false) return $cache;
    $uid = $_SESSION['uid'] ?? null;
    $cache = $uid ? (q('SELECT * FROM usuarios WHERE id = ? AND activo = 1', [$uid])->fetch() ?: null) : null;
    return $cache;
}
function require_login(): array {
    $u = me();
    if (!$u) fail('Tu sesión terminó. Vuelve a entrar.', 401);
    return $u;
}
function require_role(array $roles): array {
    $u = require_login();
    if (!in_array($u['rol'], $roles, true)) {
        audit_server('Acceso denegado', ['resultado' => 'denegado', 'detalle' => basename($_SERVER['SCRIPT_NAME'] ?? '') . ' ' . method()]);
        fail('No tienes permiso para esta acción.', 403);
    }
    return $u;
}
// Todo cambio (POST/PUT/DELETE) debe traer el token CSRF de la sesión.
function require_csrf(): void {
    $t = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($t) || !hash_equals($_SESSION['csrf'] ?? '', $t)) fail('La solicitud no es válida. Recarga la página.', 403);
}
// Un usuario con sucursal asignada solo ve documentos de su sucursal (o sin sucursal).
function can_see_doc(array $u, array $doc): bool {
    if ($u['rol'] === 'admin' || $u['sucursal'] === '' || ($doc['sucursal'] ?? '') === '') return true;
    return mb_strtolower(trim($u['sucursal'])) === mb_strtolower(trim($doc['sucursal']));
}

// ---------- Contraseñas ----------
function pass_problem(string $p, string $usuario = ''): string {
    $common = ['123456', '1234567', '12345678', '123456789', '111111', '000000', 'password', 'contraseña', 'contrasena', 'qwerty', 'abc123', 'admin', 'admin123', 'farmacia', 'sucursal'];
    if (mb_strlen($p) < 6) return 'La contraseña debe tener al menos 6 caracteres.';
    if (in_array(mb_strtolower($p), $common, true) || ($usuario !== '' && str_contains(mb_strtolower($p), mb_strtolower($usuario)))) return 'Esa contraseña es muy fácil de adivinar. Usa otra.';
    return '';
}

// ---------- Bitácora (solo inserción, encadenada) ----------
const AUDIT_FIELDS = ['n', 'ts_ms', 'usuario_id', 'usuario', 'nombre', 'rol', 'accion', 'doc_id', 'doc', 'sucursal', 'producto', 'sku', 'detalle', 'duracion_seg', 'resultado', 'equipo', 'ip'];
function audit_canon(array $r): string {
    $vals = [];
    foreach (AUDIT_FIELDS as $f) {
        $v = $r[$f] ?? null;
        if (in_array($f, ['n', 'ts_ms', 'duracion_seg'], true) && $v !== null) $v = (int) $v;
        $vals[] = $v;
    }
    return json_encode($vals, JSON_UNESCAPED_UNICODE);
}
function client_ip(): string {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    return mb_substr($ip, 0, 45);
}
function equipo(): string {
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
    $os = preg_match('/iPad/', $ua) ? 'iPad' : (preg_match('/iPhone/', $ua) ? 'iPhone' : (preg_match('/Android/', $ua) ? 'Android' : (preg_match('/Windows/', $ua) ? 'Windows' : (preg_match('/Mac/', $ua) ? 'Mac' : (preg_match('/Linux/', $ua) ? 'Linux' : 'Otro')))));
    $br = preg_match('/Edg\//', $ua) ? 'Edge' : (preg_match('/Chrome\//', $ua) ? 'Chrome' : (preg_match('/Safari\//', $ua) ? 'Safari' : (preg_match('/Firefox\//', $ua) ? 'Firefox' : 'Navegador')));
    return "$os · $br";
}
// Inserta un registro. Quién y desde dónde lo decide el servidor, no el cliente.
function audit_server(string $accion, array $e = []): void {
    $u = me();
    $uid = $e['usuario_id'] ?? ($u['id'] ?? null);
    if ($uid && !$u) $u = q('SELECT * FROM usuarios WHERE id = ?', [$uid])->fetch() ?: null;
    $row = [
        'ts_ms' => $e['ts_ms'] ?? now_ms(),
        'usuario_id' => $u['id'] ?? null,
        'usuario' => $u['usuario'] ?? str_limit($e['usuario'] ?? null, 64),
        'nombre' => $u['nombre'] ?? null,
        'rol' => $u['rol'] ?? null,
        'accion' => mb_substr($accion, 0, 120),
        'doc_id' => str_limit($e['doc_id'] ?? null, 40),
        'doc' => str_limit($e['doc'] ?? null, 200),
        'sucursal' => str_limit($e['sucursal'] ?? null, 120),
        'producto' => str_limit($e['producto'] ?? null, 255),
        'sku' => str_limit($e['sku'] ?? null, 64),
        'detalle' => str_limit($e['detalle'] ?? null, 2000),
        'duracion_seg' => isset($e['duracion_seg']) && $e['duracion_seg'] !== null ? max(0, min(86400 * 7, (int) $e['duracion_seg'])) : null,
        'resultado' => in_array($e['resultado'] ?? 'ok', ['ok', 'denegado', 'error'], true) ? ($e['resultado'] ?? 'ok') : 'ok',
        'equipo' => equipo(),
        'ip' => client_ip(),
    ];
    $pdo = db();
    // Un registro a la vez, para que la cadena de hash no se cruce.
    $lock = q("SELECT GET_LOCK('revision_bitacora', 10) AS l")->fetch();
    try {
        $prev = q('SELECT n, hash FROM bitacora ORDER BY n DESC LIMIT 1')->fetch();
        $row['n'] = $prev ? ((int) $prev['n'] + 1) : 1;
        $row['hash_anterior'] = $prev ? $prev['hash'] : '';
        $row['hash'] = hash('sha256', $row['hash_anterior'] . audit_canon($row));
        $cols = array_keys($row);
        q('INSERT INTO bitacora (' . implode(',', $cols) . ') VALUES (' . implode(',', array_fill(0, count($cols), '?')) . ')', array_values($row));
    } finally {
        if ($lock) q("SELECT RELEASE_LOCK('revision_bitacora')");
    }
}

// ---------- Documentos ----------
// Los mapas (por id de producto) deben viajar como objetos {} aunque estén vacíos;
// PHP los convertiría en listas [] y la app perdería lo registrado.
const DOC_MAPS = ['counts', 'evid', 'review', 'recount'];
function doc_fix_maps(array $d): array {
    foreach (DOC_MAPS as $k) {
        if (!array_key_exists($k, $d) || $d[$k] === null) continue;
        $d[$k] = (is_array($d[$k]) && $d[$k] === []) ? new stdClass() : (object) $d[$k];
    }
    return $d;
}
function doc_row_to_obj(array $r): array {
    $d = json_decode($r['datos'], true) ?: [];
    $d['id'] = $r['id'];
    $d['_version'] = (int) $r['version'];
    return $d;
}
// El auxiliar cuenta a ciegas: el servidor no le envía cantidades del sistema, precios ni revisiones.
function doc_for_user(array $d, array $u): array {
    if ($u['rol'] !== 'auxiliar') return doc_fix_maps($d);
    foreach ($d['items'] ?? [] as $k => $it) {
        $d['items'][$k]['cantidad'] = null;
        $d['items'][$k]['precio'] = 0;
    }
    unset($d['review'], $d['recount'], $d['samples'], $d['recountBy']);
    return doc_fix_maps($d);
}
function doc_estado(array $d): string {
    if (!empty($d['verifiedAt'])) return 'aprobado';
    if (!empty($d['finishedAt'])) return 'finalizado';
    return 'abierto';
}
