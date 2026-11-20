# Lector de códigos: zxing-wasm 3.1.5

Motor de lectura de códigos de barras y DataMatrix (ZXing-C++ compilado a WebAssembly), incluido en la app para que el escáner funcione **sin internet** y sin depender de un CDN.

| Archivo | Origen | Huella |
|---|---|---|
| `zxing-reader.js` | `zxing-wasm@3.1.5/dist/iife/reader/index.js` | — |
| `zxing_reader.wasm` | `zxing-wasm@3.1.5/dist/reader/zxing_reader.wasm` | SHA-256 `aecc1876de036c62c8419f67a5e1a16b1698a325bcd190aa84810d516e263931` (la misma que declara la librería) |

- Descargado del registro oficial de npm; el paquete coincide con su integridad publicada (`sha512-jmxXvTCR/qZx…JI4w==`).
- Licencias: envoltorio `zxing-wasm` MIT (ver `LICENSE`); motor ZXing-C++ Apache 2.0.
- Para actualizar: bajar la nueva versión desde npm, verificar la integridad, reemplazar los dos archivos, actualizar esta tabla, subir `CACHE` en `sw.js` y correr las pruebas del escáner.
