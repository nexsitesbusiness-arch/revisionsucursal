# Contexto para la IA o el desarrollador que siga

App web (español de Chile) para **revisar pedidos que llegan a sucursales de farmacia** y **contar inventarios a ciegas**, con revisión del Químico Farmacéutico (QF) y bitácora de auditoría inalterable.

Antes de cambiar algo, usar las skills **estandares-bastian**, **cambios-sin-romper**, **revision-seguridad**, **proteccion-datos-chile**, **qa-rendimiento** y **documentacion-traspaso**. Actualizar `CAMBIOS.md` en cada entrega.

## Stack

| Parte | Tecnología |
|---|---|
| Front-end | HTML + CSS + JavaScript sin framework ni compilación (`index.html`, `app.js`, `styles.css`) |
| Librerías (CDN con SRI) | xlsx 0.18.5, lz-string 1.5.0; a pedido: mammoth 1.6.0 (Word), pdf.js 3.11.174, tesseract.js 5.1.1 (OCR) |
| Lector de códigos (incluido) | `vendor/zxing/`: zxing-wasm 3.1.5 (ZXing-C++ en WebAssembly). Se carga al abrir la cámara o leer una foto, y el service worker lo guarda para usarlo sin internet. Ver `vendor/zxing/LEEME.md` |
| Servidor (opcional) | PHP 8.3 + Apache (imagen `php:8.3-apache`), PDO MySQL, OPcache |
| Base de datos | MySQL 8 (Cloud SQL) o MariaDB 10.6+ en local |
| Nube | Google Cloud Run + Cloud SQL + Secret Manager, región `southamerica-west1` |

## Dos modos (la app los detecta sola)

- **Sin servidor** (GitHub Pages, demo): todo vive en el navegador de cada tablet (localStorage + IndexedDB). Sirve para probar o una sucursal sola.
- **Con servidor**: si responde `api/estado.php`, la app usa la API. Nada de documentos queda en la tablet; permisos, sesión y bitácora los valida el servidor. Las clases CSS `.local-only` se ocultan en este modo.

## Estructura

```
index.html        Todas las vistas (login, usuarios, maestro, inicio, carga, conteo, resultados, bitácora)
app.js            Lógica de la app (un IIFE). Funciones clave: api(), audit(), renderCount(), computeResults(), classifyABC(), openReview()
styles.css        Estilo "Ejecutivo/Marino", solo tema claro, Roboto
desplegable.js    Reemplaza TODO <select> por un desplegable propio (con buscador si hay > 8 opciones)
bitacora.js       Bitácora local (IndexedDB, cadena SHA-256) para el modo sin servidor
vendor/zxing/     Lector de códigos ZXing-C++ (WASM). Escáner en app.js: startScanner() (cámara, lee la zona del recuadro cada 90 ms) y decodeImage() (también para "Leer desde foto")
gs1.js            Lee GTIN, lote (10) y vencimiento (17) de códigos DataMatrix / GS1-128
importar.js       Lee Word, PDF, fotos (OCR) y el reporte de inventario en PDF
sw.js             Service worker (funciona sin internet). Subir CACHE ('revision-vN') en cada cambio de archivos estáticos
api/*.php         Endpoints JSON. Todos parten con require '_init.php'
servidor/lib.php  Conexión, sesiones en BD, CSRF, permisos, bitácora del servidor, resumen de documentos
servidor/sql/     01_esquema.sql (tablas y triggers), 02_usuario_app.sql (permisos mínimos), 99_reversa.sql
servidor/tests/   smoke_api.sh (40 pruebas de la API), reset_db_local.sh, generar_volumen.php
```

## Patrones

- **Conexión:** `db()` en `servidor/lib.php`, datos desde variables de entorno (`DB_SOCKET` o `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`). Nunca credenciales en el código.
- **Consultas:** siempre `q($sql, $params)` con parámetros, nunca concatenar datos del usuario.
- **Permisos:** `require_login()`, `require_role([...])`, `can_see_doc($u, $doc)` (QF y auxiliar solo ven su sucursal). Toda petición que cambia datos exige el encabezado `X-CSRF-Token`.
- **Documentos:** se guardan completos como JSON en `documentos.datos`, con `version` para detectar choques entre tablets (409). `resumen` guarda los totales para la lista liviana.
- **Rareza de PHP:** un objeto JSON vacío `{}` vuelve como lista `[]`. Por eso existen `doc_fix_maps()` (servidor) y `normDoc()` (app) para `counts`, `evid`, `review`, `recount` y `venc`. No quitarlos.
- **Bitácora:** en la app, todo pasa por `audit(accion, extra)`. En el servidor, `audit_server()`, que pone usuario, IP y equipo; la app no puede falsificarlos.

## Reglas de negocio que no son obvias

0. **Quién carga qué:** el **inventario** lo carga la **QF** desde el reporte de inventario que descarga de **SPOS** (PDF, ver `Importar.parseExistencias`). Los **pedidos** y la configuración (usuarios, maestro, costos) son del **administrador**. La QF solo puede crear inventarios de su sucursal (`same_branch()` compara el código tipo CL0007) y eliminarlos mientras nadie haya contado.

1. **El auxiliar cuenta a ciegas.** Nunca debe recibir `cantidad` ni `precio` del sistema: el servidor los quita en `doc_for_user()`. Al finalizar ve solo "Conteo finalizado", sin totales ni avisos de correcto o incorrecto (tampoco "lote distinto").
2. **Clase ABC:** se ordenan las desviaciones por valor absoluto. A son las que suman el primer 80 % del valor, B el siguiente 15 % y C el resto. Sin costos, se calcula por unidades.
3. **El QF debe revisar TODO** lo que tiene diferencia y lo que salió en la muestra aleatoria. Por cada uno marca "correcta" o "corregida" (con la cantidad real) y deja una observación. **Aprobar** se bloquea en la app y en el servidor (`pending_reviews`) mientras quede algo pendiente.
4. **Revisión aleatoria:** el QF elige el estrato (caros, medios o baratos) y N productos; el azar usa `crypto.getRandomValues`.
5. **Tiempo del conteo (tramos y pausas):** cada registro del conteo extiende el tramo actual (`o.tramos = [{ini, fin, n, por}]`, ver `markActivity()`); si pasan más de `PAUSA_MIN` (5) minutos sin registrar, lo siguiente abre un tramo nuevo y la diferencia es una pausa. El reporte del QF muestra inicio, fin, tiempo total, tiempo contando, pausas y cada tramo; también va al Excel (hoja "Tiempo del conteo") y a la bitácora ("Retomó el conteo tras una pausa").
5a. **Tiempos del proceso:** el reporte muestra los hitos carga (`creado`) → inicio del conteo (primer tramo) → fin (`finishedAt`, lo pone el servidor) → inicio de la revisión (`revisionIni`, la primera vez que la QF abre el reporte; solo QF/admin pueden guardarlo) → aprobación (`verifiedAt`), con las esperas y duraciones entre cada uno y el total. Si un reloj está mal y una duración da negativa, se muestra "—".
5c. **Cierre:** al aprobar, la QF escribe una **observación general** obligatoria (`obsCierre`, máx. 1000 caracteres; el servidor la recorta y solo la acepta de QF/admin). El reporte muestra inicio del documento (inicio del conteo), término (aprobación), quién cerró y la observación; también va al Excel y a la bitácora.
5b. **Tiempo por producto:** se mide cuánto tiempo estuvo abierta la revisión de cada producto (`seg`) y queda en la bitácora.
6. **Vencimiento (lo audita la QF):** si el código trae vencimiento y faltan ≤ 90 días (`VENC_DIAS`), se guarda en `o.venc`. Al auxiliar no se le avisa ni se le muestran vencimientos (tampoco los recibe del servidor); la QF y el administrador los ven en el conteo, en el reporte y en el Excel.
7. **Fechas:** dd-mm-aaaa, hora de `America/Santiago`. Montos en CLP sin decimales.

## Zonas peligrosas

- **Tabla `bitacora`:** solo inserción. Tiene triggers que impiden UPDATE y DELETE, y el usuario de la app solo tiene SELECT e INSERT. No cambiar `AUDIT_FIELDS` ni `audit_canon()`, porque rompería la verificación de toda la cadena histórica.
- **`doc_for_user()`:** si se agrega un campo con cantidades o costos al documento, hay que quitarlo para el auxiliar.
- **`documentos.php` (PUT):** decide qué campos puede cambiar cada rol (`CAMPOS_CONTEO`, `CAMPOS_QF`). Un error aquí deja que un auxiliar se apruebe a sí mismo.
- **Nunca** `DROP`, `TRUNCATE` ni `DELETE` masivo en producción sin respaldo y confirmación.
- **Datos reales:** el reporte de inventario de SPOS y el maestro del cliente son confidenciales. No subirlos al repositorio ni a la demo publicada.

## Cómo probar

```bash
bash servidor/tests/reset_db_local.sh                 # solo base LOCAL de pruebas
DB_USER=revision_app DB_PASS=clave_local_pruebas php -S 127.0.0.1:8780 -t . &
BASE=http://127.0.0.1:8780 bash servidor/tests/smoke_api.sh   # debe decir "0 con falla"
python3 -m http.server 8765                           # modo sin servidor
```

Las pruebas de navegador (Playwright) cubren tres tablets en modo servidor (admin, auxiliar y QF), la vista en celular, XSS, importación, modo sin conexión, vencimiento, privacidad y rendimiento con 1.219 productos.
