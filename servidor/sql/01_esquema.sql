-- Esquema de Revisión de Pedidos e Inventarios (MySQL 8 / MariaDB 10.6+).
-- Ejecutar con un usuario administrador de la base de datos, no con el usuario de la app.

CREATE TABLE IF NOT EXISTS usuarios (
  id CHAR(32) NOT NULL PRIMARY KEY,
  usuario VARCHAR(64) NOT NULL UNIQUE,
  nombre VARCHAR(120) NOT NULL,
  rol ENUM('admin','qf','auxiliar') NOT NULL,
  sucursal VARCHAR(120) NOT NULL DEFAULT '',
  clave_hash VARCHAR(255) NOT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Intentos de inicio de sesión (bloqueo temporal tras 5 fallidos).
CREATE TABLE IF NOT EXISTS intentos_login (
  usuario VARCHAR(64) NOT NULL PRIMARY KEY,
  intentos INT NOT NULL DEFAULT 0,
  bloqueado_hasta BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sesiones en la base (permite varias instancias del servidor, por ejemplo en Cloud Run).
CREATE TABLE IF NOT EXISTS sesiones (
  id VARCHAR(128) NOT NULL PRIMARY KEY,
  datos MEDIUMTEXT NOT NULL,
  actualizado BIGINT NOT NULL,
  INDEX (actualizado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Configuración general (por ejemplo, el maestro de productos).
CREATE TABLE IF NOT EXISTS configuracion (
  clave VARCHAR(64) NOT NULL PRIMARY KEY,
  valor LONGTEXT NOT NULL,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  actualizado_por CHAR(32) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pedidos e inventarios. "datos" guarda el documento completo en JSON.
CREATE TABLE IF NOT EXISTS documentos (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  tipo ENUM('pedido','inventario') NOT NULL,
  nombre VARCHAR(200) NOT NULL,
  sucursal VARCHAR(120) NOT NULL DEFAULT '',
  estado ENUM('abierto','finalizado','aprobado') NOT NULL DEFAULT 'abierto',
  version INT NOT NULL DEFAULT 1,
  datos LONGTEXT NOT NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  creado_por CHAR(32) NULL,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  actualizado_por CHAR(32) NULL,
  INDEX (sucursal), INDEX (estado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fotos de evidencia.
CREATE TABLE IF NOT EXISTS evidencias (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  documento_id VARCHAR(40) NOT NULL,
  mime VARCHAR(40) NOT NULL,
  tamano INT NOT NULL,
  contenido MEDIUMBLOB NOT NULL,
  creado_por CHAR(32) NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (documento_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bitácora de auditoría: solo inserción, encadenada con SHA-256.
CREATE TABLE IF NOT EXISTS bitacora (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  n BIGINT NOT NULL UNIQUE,
  ts_ms BIGINT NOT NULL,
  usuario_id CHAR(32) NULL,
  usuario VARCHAR(64) NULL,
  nombre VARCHAR(120) NULL,
  rol VARCHAR(20) NULL,
  accion VARCHAR(120) NOT NULL,
  doc_id VARCHAR(40) NULL,
  doc VARCHAR(200) NULL,
  sucursal VARCHAR(120) NULL,
  producto VARCHAR(255) NULL,
  sku VARCHAR(64) NULL,
  detalle TEXT NULL,
  duracion_seg INT NULL,
  resultado VARCHAR(20) NOT NULL DEFAULT 'ok',
  equipo VARCHAR(80) NULL,
  ip VARCHAR(45) NULL,
  hash_anterior CHAR(64) NOT NULL,
  hash CHAR(64) NOT NULL,
  INDEX (ts_ms), INDEX (usuario), INDEX (doc_id), INDEX (accion)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nadie puede modificar ni borrar la bitácora, ni siquiera por error desde la app.
DROP TRIGGER IF EXISTS bitacora_sin_update;
DROP TRIGGER IF EXISTS bitacora_sin_delete;
CREATE TRIGGER bitacora_sin_update BEFORE UPDATE ON bitacora FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La bitacora no se puede modificar';
CREATE TRIGGER bitacora_sin_delete BEFORE DELETE ON bitacora FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La bitacora no se puede borrar';
