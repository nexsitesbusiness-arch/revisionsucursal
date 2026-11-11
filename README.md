# Revisión de pedidos en sucursal

App web para revisar el pedido que llega a la sucursal sin buscar producto por producto en una hoja impresa.

## Cómo funciona

1. **Central – cargar el pedido.** Sube el Excel/CSV (o pega desde Excel) con: código de barras, producto, lote, precio, cantidad y, opcional, vencimiento. Hay una plantilla en `ejemplo-pedido.csv`.
2. **Enviar a la sucursal.** Botón *Compartir enlace* (WhatsApp, correo) o *Descargar archivo*. El pedido viaja comprimido: la sucursal **no ve las cantidades enviadas**.
3. **Sucursal – contar.** Abre el enlace y cuenta lo que trae la cubeta:
   - Buscador por nombre, código o lote.
   - **📷 Escanear** con la cámara del celular: cada lectura suma 1 (o las unidades que indiques por escaneo, útil para cajas).
   - Si el código es **DataMatrix / GS1-128** (los que traen lote y vencimiento), la app **lee el lote y verifica** que sea el del pedido. Si no coincide, avisa con sonido y lo registra como “Lote distinto”.
   - Si el producto viene en varios lotes y el código no trae lote, pregunta cuál es.
   - Productos que llegaron pero no estaban en el pedido se registran como sobrantes.
   - También sirve un lector de código de barras USB/Bluetooth: se escanea en el buscador.
   - El avance se guarda en el celular; se puede cerrar y seguir después.
4. **Terminé, ver diferencias.** Recién ahí se muestra lo contado vs. lo que debería ser:

   | Producto | Lote | Llegó | Debería ser | Dif. |
   |---|---|---|---|---|
   | Paracetamol 500 mg | L2405A | 20 und | 30 und | −10 |

   Se puede exportar a Excel/CSV, imprimir o compartir el resumen por WhatsApp. Si se reabre el conteo, queda registrado.

## Publicación

Es una página estática (HTML + JS, sin servidor). Para usarla desde el celular:

1. En GitHub: **Settings → Pages → Source: GitHub Actions**.
2. Al hacer merge a `main`, se publica sola en `https://<usuario>.github.io/revisionsucursal/`.

La cámara solo funciona en `https://` (GitHub Pages ya lo es) o en `localhost`.

Para probar en la computadora: `python3 -m http.server` y abrir `http://localhost:8000`.

## Limitaciones actuales

- Los datos se guardan en cada dispositivo (no hay base de datos central). La central recibe el resultado por Excel o WhatsApp.
- Los códigos EAN-13 normales no traen lote; para verificar lote automáticamente hace falta el DataMatrix/GS1 de la caja.
