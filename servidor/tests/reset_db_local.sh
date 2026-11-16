#!/usr/bin/env bash
# Solo para pruebas locales: recrea la base vacía. NUNCA usar en producción.
mysql -uroot -e "DROP DATABASE IF EXISTS revision; CREATE DATABASE revision CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -uroot revision < "$(dirname "$0")/../sql/01_esquema.sql"
sed "s/CAMBIAR_CLAVE/clave_local_pruebas/; s/ON \([a-z_]*\) TO/ON revision.\1 TO/" "$(dirname "$0")/../sql/02_usuario_app.sql" | mysql -uroot revision
