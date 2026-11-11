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

## Diseño

Estilo **Ejecutivo**: barra azul marino, azul corporativo, tablas ordenadas, íconos de línea y botones redondos. El botón de la luna (arriba a la derecha) cambia a **modo oscuro**, útil en bodegas con poca luz.

<img src="docs/capturas/tab-nocturno-6-diferencias.png" width="420"> <img src="docs/capturas/cel-ejecutivo-4-conteo.png" width="260">

## Instalar en la tablet (funciona sin internet)

Abrir la página en Chrome/Safari → menú → **Agregar a pantalla de inicio**. Queda como app con ícono propio y, después de abrirla una vez con internet, se puede contar sin conexión.

Al cerrar el conteo se registra **quién contó** y la hora de inicio y cierre (aparece en el resumen, en el Excel y en el mensaje de WhatsApp).

## Proceso completo (vista en tablet)

### 1. Central: cargar y enviar el pedido
**Paso 1.** Inicio: lista de pedidos. Botón **Cargar pedido nuevo**.

<img src="docs/capturas/01-inicio.png" width="420">
**Paso 2.** Se sube el Excel/CSV. La central ve producto, lote, precio y cantidad. **Guardar pedido**.

<img src="docs/capturas/02-central-carga-pedido.png" width="420">
**Paso 3.** Pedido guardado. **Compartir enlace** (WhatsApp/correo) o **Descargar archivo** para la sucursal.

<img src="docs/capturas/03-central-enviar.png" width="420">

### 2. Sucursal: contar lo que llegó
**Paso 4.** La sucursal abre el enlace y toca **Comenzar conteo**.

<img src="docs/capturas/04-sucursal-abre-enlace.png" width="420">
**Paso 5.** Lista de productos **sin las cantidades enviadas**; todo empieza en 0.

<img src="docs/capturas/05-sucursal-conteo-sin-cantidades.png" width="420">
**Paso 6.** Buscador: al escribir "para" aparece el Paracetamol. Se suma con + / − o escribiendo la cantidad.

<img src="docs/capturas/06-sucursal-buscador.png" width="420">
**Paso 7.** **Escanear** con la cámara: cada lectura suma 1 (o las *unidades por escaneo*) y avisa qué producto contó.

<img src="docs/capturas/07-sucursal-camara-escaneo.png" width="420">
**Paso 8.** Código DataMatrix/GS1 con lote: la app lee el lote y confirma que es el correcto.

<img src="docs/capturas/08-sucursal-datamatrix-lote-ok.png" width="420">
**Paso 9.** Lote distinto al del pedido: alerta roja con sonido; queda registrado como diferencia.

<img src="docs/capturas/09-sucursal-lote-incorrecto.png" width="420">
**Paso 10.** Mismo producto en varios lotes y código sin lote: la app pregunta cuál es.

<img src="docs/capturas/10-sucursal-elegir-lote.png" width="420">
**Paso 11.** Avance: verde = contado, naranja = llegó y no estaba en el pedido.

<img src="docs/capturas/11-sucursal-conteo-avanzado.png" width="420">
**Paso 12.** **Terminé, ver diferencias**: avisa cuántos productos quedan en 0 y cierra el conteo.

<img src="docs/capturas/12-sucursal-confirmar-fin.png" width="420">

### 3. Resultado: diferencias
**Paso 13.** Diferencias: **Llegó** vs **Debería ser** (ej. Paracetamol 20 und / 30 und → −10).

<img src="docs/capturas/13-diferencias.png" width="420">
**Paso 14.** Desmarcando *Solo con diferencias* se ven también los correctos.

<img src="docs/capturas/14-diferencias-todo.png" width="420">
**Paso 15.** Tablet en horizontal. Exportar a Excel/CSV, imprimir o compartir por WhatsApp.

<img src="docs/capturas/15-diferencias-horizontal.png" width="420">

## Publicación

Es una página estática (HTML + JS, sin servidor). Para usarla desde el celular:

1. En GitHub: **Settings → Pages → Source: GitHub Actions**.
2. Al hacer merge a `main`, se publica sola en `https://<usuario>.github.io/revisionsucursal/`.

La cámara solo funciona en `https://` (GitHub Pages ya lo es) o en `localhost`.

Para probar en la computadora: `python3 -m http.server` y abrir `http://localhost:8000`.

## Limitaciones actuales

- Los datos se guardan en cada dispositivo (no hay base de datos central). La central recibe el resultado por Excel o WhatsApp.
- Los códigos EAN-13 normales no traen lote; para verificar lote automáticamente hace falta el DataMatrix/GS1 de la caja.
