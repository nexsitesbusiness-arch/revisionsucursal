#!/usr/bin/env bash
# Arma la carpeta _site con SOLO los archivos de la app (modo sin servidor).
# La usan GitHub Pages y Cloudflare Pages. El código PHP, SQL, pruebas y documentación no se publican.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site
mkdir _site
cp -r index.html styles.css app.js gs1.js importar.js bitacora.js desplegable.js sw.js manifest.webmanifest icons vendor ejemplo-pedido.* .nojekyll _headers _site/
# Dentro de vendor solo van el lector y su licencia (sin el LEEME interno).
rm -f _site/vendor/zxing/LEEME.md
echo "Sitio listo en _site: $(find _site -type f | wc -l) archivos"
