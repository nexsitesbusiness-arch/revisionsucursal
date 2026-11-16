# Cambios

Formato: fecha (dd-mm-aaaa) · qué cambió en simple · decisiones y por qué.

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

- Módulo de inventario a partir del reporte de existencias en PDF y del maestro de materiales en Excel.
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
