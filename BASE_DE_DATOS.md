# Base de datos

MySQL 8 (Cloud SQL). Esquema en `servidor/sql/01_esquema.sql` y permisos en `02_usuario_app.sql`. Todas las tablas usan `utf8mb4`.

| Tabla | Para qué | Datos personales | Permisos de la app |
|---|---|---|---|
| `usuarios` | Cuentas: usuario, nombre, rol (admin/qf/auxiliar), sucursal, contraseña cifrada (`password_hash`), activo | **Sí:** nombre y usuario | Leer, crear, cambiar y borrar (en la práctica se desactiva, no se borra) |
| `intentos_login` | Bloqueo de 5 minutos tras 5 intentos fallidos | Usuario | Todo |
| `sesiones` | Sesiones en la base (Cloud Run puede tener varias instancias) | Identificador del usuario | Todo |
| `configuracion` | Maestro de productos y costos (JSON) | No | Leer, crear y cambiar |
| `documentos` | Pedidos e inventarios. `datos` es el documento completo en JSON (productos, conteos, revisiones del QF, evidencias). `resumen` guarda los totales para la lista. `version` evita que dos tablets se pisen | Nombres de quien contó y revisó | Todo |
| `evidencias` | Fotos de evidencia (máx. 5 MB, JPG, PNG o WebP verificado por contenido) | **Puede haber:** una foto podría mostrar a una persona | Leer, crear y borrar |
| `bitacora` | Auditoría: quién, qué, cuándo, documento, producto, tiempo, equipo e IP. Encadenada con SHA-256 (`hash_anterior` → `hash`) | **Sí:** usuario, nombre, IP y equipo | **Solo leer e insertar.** Además hay triggers que bloquean UPDATE y DELETE incluso al administrador de la base |

## Relaciones

- `documentos.creado_por` / `actualizado_por` → `usuarios.id`
- `evidencias.documento_id` → `documentos.id` (al borrar un documento se borran sus fotos)
- `bitacora.usuario_id` → `usuarios.id` y `bitacora.doc_id` → `documentos.id`. Son solo referencias, sin llave foránea, porque la bitácora debe sobrevivir aunque se borre el documento o el usuario.

## Índices importantes

- `bitacora`: `(doc_id, n)`, `(usuario_id, n)`, `(usuario, n)`, `ts_ms`, `accion`. La paginación es por cursor (`n < último`), no por OFFSET.
- `documentos`: `sucursal`, `estado`, `creado_en`.

## Volumen probado

50 inventarios de 1.219 productos y 100.000 registros de bitácora. La lista de documentos tarda 3 ms, abrir un inventario 5 ms, guardar 60 ms, una página de bitácora 66 ms, los filtros entre 18 y 134 ms, y verificar la integridad de toda la cadena 0,4 s. Para generar ese volumen se usa `servidor/tests/generar_volumen.php` (solo en la base local).

## Conservación de datos (Ley 21.719)

La política de privacidad de la app propone conservar la bitácora 2 años. Como la bitácora es inalterable, **archivarla o depurarla requiere un procedimiento manual con respaldo**, que hay que definir con el abogado (pendiente). Un usuario puede pedir sus datos: el administrador los exporta desde **Usuarios → botón Datos** (Excel).
