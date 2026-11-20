# Cambios

Formato: fecha (dd-mm-aaaa) · qué cambió en simple · decisiones y por qué.

## 20-11-2026 · Corrección: costos con separador de miles

- Un Excel con costos con formato de moneda (por ejemplo "$ 3,990") se leía como **3,99** en vez de 3.990, y el reporte mostraba montos mil veces menores. Ahora un número con un solo separador seguido de exactamente 3 dígitos ("3.990", "3,990") o con separadores repetidos ("1.250.000") se lee como miles; "2,5" y "3.99" siguen siendo decimales.
- Se detectó al grabar la guía con el maestro de `ejemplos/`. Se agregó la prueba correspondiente.

## 20-11-2026 · Contar por foto (varios códigos a la vez)

- El botón **Foto** del conteo ahora lee **todos los códigos de una foto** (hasta 120). Si hay más de uno, muestra cuántas cajas de cada producto encontró y los códigos que no están en la lista (esos no se suman). Al tocar **Sumar al conteo** se registran todas; respeta "Unidades por escaneo". Queda en la bitácora ("Contó desde foto").
  - *Decisión:* cuenta cajas con código visible, no adivina cajas tapadas; por eso pide revisar antes de sumar.
- Probado con una foto de 9 etiquetas (5 Cefalmin, 3 Naproxeno, 1 desconocida): detectó las 9 y sumó bien.

## 20-11-2026 · Naproxeno (EAN 7800007176394)

- Se agrega **Naproxeno comprimidos** (EAN 7800007176394) al ejemplo de la app (maestro, inventario con 15 en el sistema y pedido con lote NX2501), a las planillas de `ejemplos/`, a la hoja de códigos para imprimir y a la página de prueba de cámara (que ahora cuenta cada producto por separado y muestra cualquier otro código leído).
  - Código confirmado con la **cámara del teléfono sobre una caja real**: **7800007176394** (el entregado a mano tenía 12 dígitos; faltaba un 0 en el medio).

## 20-11-2026 · Página de prueba de cámara (Cefalmin)

- Nueva `prueba-camara.html`: sin usuarios ni datos guardados. Abre la cámara y dice al tiro si leyó Cefalmin (EAN 7800038041210), en cuánto tiempo, y si leyó otro código. También acepta foto y DataMatrix GS1. Sirve para comprobar que la cámara de cada teléfono lee bien antes de usar la app.

## 20-11-2026 · Botón "Cargar ejemplo con Cefalmin"

- En la app real, con la lista vacía, el administrador puede cargar con un toque el maestro con costos, un inventario de CL0099 CENTRO y un pedido de ejemplo (Cefalmin con EAN real). Funciona con y sin servidor.

## 20-11-2026 · Limpieza antes de hacer público el repositorio

- Se reemplazaron las menciones a sucursales reales y a códigos de productos reales (en ejemplos de texto, pruebas y README) por datos ficticios (CL0099 CENTRO, etc.).
  - *Motivo:* el repositorio pasa a ser público para publicarlo con GitHub Pages (cámara en vivo con https). Se revisó todo el historial: nunca se subieron el reporte real ni el maestro real.

## 20-11-2026 · Planillas de ejemplo con Cefalmin (EAN real 7800038041210)

- Nueva carpeta `ejemplos/`: maestro, inventario (PDF formato SPOS y Excel), pedido (Excel y CSV) y hoja de códigos para imprimir.
- La demo usa el EAN real de Cefalmin, para poder escanear una caja real.
- Verificado: la app carga las cuatro planillas, y los 10 códigos de la hoja impresa se leen (incluido el DataMatrix con lote y vencimiento).

## 20-11-2026 · Demo: entrar con un toque y datos de ejemplo

- En la demo (solo con `REVISION_DEMO`), la pantalla de ingreso tiene botones **Administrador**, **QF** y **Auxiliar** para entrar con un toque.
- La demo trae listos un **maestro con costos**, un **inventario de CL0099 CENTRO** (9 productos, incluido Cefalmin) y un **pedido que llega** (con lotes y vencimientos). Los códigos EAN son válidos, para poder imprimirlos y escanearlos.
- El botón "Cargar pedido de ejemplo" de la app normal no cambia.

## 20-11-2026 · Publicación en Cloudflare Pages

- Nuevo `servidor/publicar-estatico.sh`: arma `_site` solo con los archivos de la app. Lo usan GitHub Pages y Cloudflare Pages.
- Nuevo `_headers`: cabeceras de seguridad y tipo `application/wasm` en Cloudflare.
  - *Motivo:* el repositorio es privado y GitHub Pages no se puede usar sin plan pago; Cloudflare Pages sí publica desde repositorios privados gratis. Pasos en `DEPLOY.md`.

## 20-11-2026 · Prueba con Cefalmin y ajuste de la cámara

- Prueba de punta a punta en el servidor con un producto Cefalmin de ejemplo (cámara en vivo, foto de DataMatrix, revisión y cierre de la QF): todo correcto.
- **Corrección:** al escanear con la cámara abierta, la pantalla bajaba hasta el producto contado y la cámara quedaba tapada bajo la barra superior. Ahora, con la cámara abierta, la pantalla no se mueve: el producto se marca y el aviso dice cuál fue.

## 17-11-2026 · Escáner nuevo: ZXing-C++ (WebAssembly)

- El escáner usa **zxing-wasm 3.1.5** (ZXing-C++) en lugar de html5-qrcode 2.3.8.
  - *Motivo:* html5-qrcode usa un ZXing antiguo en JavaScript que lee mal los DataMatrix y en iPhone no tiene alternativa. En 20 imágenes difíciles, el nuevo leyó 20 y el anterior 12.
  - *Decisión:* el lector va **incluido en la app** (`vendor/zxing/`, ~1 MB, verificado contra npm) para funcionar sin internet y no depender de un CDN.
- Cámara propia: alta resolución, lectura de la zona del recuadro, enfoque continuo y linterna.
- Un código cuenta **una vez mientras siga a la vista** (antes se repetía cada 1,5 s si la cámara se quedaba quieta sobre el código).
- Nuevo botón **Foto**: lee el código desde una foto si la cámara en vivo no está disponible.
- Apache entrega los `.wasm` con su tipo correcto; se quitó `unpkg.com` de la política de seguridad (ya no se usa).
- Ojo: los códigos de los archivos de ejemplo (`ejemplo-pedido.csv`, maestro de ejemplo) no tienen dígito verificador válido; sirven para escribir, pero no existen como códigos impresos reales.

## 17-11-2026 · Cierre con fecha de inicio, término y observación general

- Al **aprobar**, la QF escribe una **observación general del cierre** (obligatoria; puede ser "Sin observaciones").
  - *Decisión:* obligatoria, para que todo cierre deje constancia.
- El reporte muestra arriba: **inicio** del inventario (fecha y hora en que se empezó a contar), **término** (fecha y hora de aprobación), **quién cerró** y la observación. También en el Excel y en la bitácora.
- El servidor guarda la observación solo si viene de la QF o del administrador, y la recorta a 1000 caracteres.

## 17-11-2026 · Tiempos del proceso completo

- El reporte muestra **Tiempos del proceso**: PDF (o pedido) cargado → inicio del conteo → fin del conteo → inicio de la revisión de la QF → aprobado, con la espera o duración entre cada hito y el **total**. Lo pendiente se ve "en curso".
- Se guarda la hora en que la QF abre el reporte por primera vez (`revisionIni`) y queda en la bitácora ("Inició la revisión del conteo"). El servidor solo deja guardarla a la QF o al administrador.
- También va al Excel (hoja Resumen).
- Duraciones de 1 hora o más se muestran como "1 h" o "1 h 15 min".

## 17-11-2026 · Tiempo del conteo con tramos y pausas; "reporte de inventario"

- El reporte de la QF muestra el **tiempo del conteo**: inicio, fin, tiempo total, tiempo contando, cuántas **pausas** hubo y cuánto duró cada **tramo** (ej. 10 min, pausa, 4 min, pausa, 30 min), con una línea de tiempo.
  - *Decisión:* es pausa cuando pasan más de **5 minutos** sin registrar nada (`PAUSA_MIN`, se puede ajustar).
  - Va también al Excel (hoja "Tiempo del conteo") y a la bitácora ("Retomó el conteo tras una pausa").
- Los textos dicen **"reporte de inventario"** de SPOS en vez de "reporte de existencias" (pedido de Bastian).
- Las horas de los tramos se muestran en formato de 24 horas.

## 16-11-2026 · La QF carga el inventario desde SPOS

- La **QF** crea el inventario subiendo el reporte de inventario en PDF que descarga de **SPOS**. Antes lo hacía solo el administrador.
  - *Decisión de Bastian:* el inventario lo inicia la QF de la sucursal; el administrador queda para la configuración y los pedidos.
- La QF solo puede cargar reportes de **su sucursal**: la app y el servidor lo validan comparando el código (ej. CL0007), sin importar mayúsculas ni espacios.
- La QF puede **eliminar un inventario mal cargado** mientras nadie haya empezado a contar. El auxiliar nunca puede eliminar. Todo queda en la bitácora.
- Nuevas pruebas: 7 en la API (permisos de crear y eliminar) y una prueba de navegador del flujo completo.

## 16-11-2026 · Corrección: escaneo de DataMatrix en inventarios

- Al escanear una caja con DataMatrix (trae lote) en un inventario, el producto quedaba como "Lote distinto" y sin contar, porque los inventarios no tienen lote cargado. Ahora, si el producto no tiene lote en el documento, se cuenta normal.
- El auxiliar ya no ve el motivo "Lote distinto al enviado" en los productos que agrega (conteo a ciegas). El QF y el administrador sí lo ven.
- Se detectó al grabar la guía en video con la app real.
- El auxiliar ya no ve el precio de los productos en la lista del pedido (modo sin servidor; con servidor ya se quitaba).
- El vencimiento de cada producto se muestra en formato dd-mm-aaaa.
- **Vencimiento solo para la QF (auditora):** al auxiliar ya no se le avisa ni se le muestran vencimientos, y el servidor no se los envía. La fecha leída del código se guarda igual y la QF la ve en el reporte y el Excel.
  - *Decisión de Bastian:* el vencimiento es tarea de auditoría de la QF, no del conteo.
- En inventarios, el aviso al escanear ya no dice "lote verificado" cuando el producto no tiene lote contra el cual comparar.

## 16-11-2026 · Versión 1.0: servidor, vencimiento, privacidad y rendimiento

- **Modo con servidor (PHP + MySQL en Google Cloud).** Usuarios, documentos, fotos y bitácora quedan centralizados. Los permisos los valida el servidor, no solo la app.
  - *Decisión:* la app detecta sola si hay servidor. Así se mantiene la demo sin servidor y el código es uno solo.
  - *Decisión:* el auxiliar nunca recibe cantidades ni costos; el servidor los quita antes de enviar.
  - *Decisión:* la bitácora es de solo inserción (permisos de la base y triggers) y está encadenada con SHA-256. El usuario, la IP y el equipo los pone el servidor.
- **Alerta de vencimiento:** al escanear un código que trae vencimiento, si faltan 90 días o menos, avisa y queda en el reporte y en el Excel.
- **Privacidad (Ley 21.719):** aviso en el inicio de sesión, política de privacidad en el menú (plantilla, **revisar con abogado**) y exportación de los datos de un usuario.
- **Rendimiento con inventarios grandes:** la lista de conteo y el reporte se dibujan por tandas. En una tablet de gama media, abrir un conteo de 1.219 productos bajó de 3,2 s a 0,2 s, y el reporte de 1,8 s a 0,4 s. La lista de documentos es liviana (solo resumen) y la bitácora se filtra y pagina en el servidor.
- **Documentación de traspaso:** `CLAUDE.md`, `ARQUITECTURA.md`, `BASE_DE_DATOS.md`, `DEPLOY.md`, `ACCESOS.md` y este archivo.

## Revisión del QF y bitácora

- El QF revisa **todas** las desviaciones (cantidad correcta o corregida, más observación) y la app mide el tiempo por producto.
- Revisión aleatoria por estrato (caros, medios o baratos) y buscador en el reporte.
- **Aprobar** se bloquea si queda algo pendiente.
- Bitácora de todo: sesiones, documentos, cantidades, revisiones, filtros, exportaciones y aprobaciones, con verificación de integridad.

## Roles QF y auxiliar

- Conteo a ciegas para el auxiliar: sin totales y sin decir si está bien o mal.
- Reporte de desviaciones en orden ABC (80 / 15 / 5 % del valor).

## Inventarios, maestro y usuarios

- Módulo de inventario a partir del reporte de inventario en PDF y del maestro de materiales en Excel.
- Inicio de sesión con usuario y contraseña.

## Carga de pedidos y evidencia

- Carga desde Excel, CSV, Word, PDF y foto (OCR), con todo lo leído marcado para revisar.
- Evidencia por producto: motivo, nota y fotos.

## Diseño

- Estilo "Ejecutivo/Marino" elegido por Bastian: botones redondos, solo tema claro, Roboto y desplegables propios.
  - *Decisión:* se descartó el estilo bento porque no se veía profesional.

## Primera versión

- Conteo con buscador y cámara (códigos de barras y DataMatrix GS1 con lote).
- Reporte de diferencias "contado vs. debería ser" y exportación a Excel.
