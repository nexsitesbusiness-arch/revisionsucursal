-- Usuario de la app con permisos mínimos. Cambia 'CAMBIAR_CLAVE' por una clave segura
-- (guárdala en Secret Manager, nunca en el código).
CREATE USER IF NOT EXISTS 'revision_app'@'%' IDENTIFIED BY 'CAMBIAR_CLAVE';
GRANT SELECT, INSERT, UPDATE, DELETE ON usuarios TO 'revision_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON intentos_login TO 'revision_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sesiones TO 'revision_app'@'%';
GRANT SELECT, INSERT, UPDATE ON configuracion TO 'revision_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON documentos TO 'revision_app'@'%';
GRANT SELECT, INSERT, DELETE ON evidencias TO 'revision_app'@'%';
-- Bitácora: solo leer e insertar.
GRANT SELECT, INSERT ON bitacora TO 'revision_app'@'%';
