# Accesos (sin contraseñas)

Las contraseñas y claves van en **Secret Manager** de Google Cloud o en un gestor de contraseñas. **Nunca** en este repositorio.

| Servicio | Para qué | Quién tiene acceso | Dónde está la clave |
|---|---|---|---|
| GitHub `nexsitesbusiness-arch/revisionsucursal` | Código y publicación de la demo (GitHub Pages) | Bastian (dueño) | Cuenta de GitHub de cada persona |
| Google Cloud: proyecto *(por definir)* | Cloud Run (app) y Cloud SQL (base) | *(por definir)* | Cuenta de Google de cada persona, con permisos mínimos |
| Cloud SQL: usuario `root` | Crear tablas y respaldos. **No lo usa la app** | Solo administrador de la base | Secret Manager / gestor |
| Cloud SQL: usuario `revision_app` | El que usa la app, con permisos mínimos | Cloud Run (automático) | Secret Manager: `revision-db-pass` |
| App: primer administrador | Crea los demás usuarios | Responsable de la central | Lo crea cada persona; la app guarda solo el hash |
| CDN jsdelivr / cdnjs | Librerías (con verificación SRI) | Público, sin cuenta | — |

## Al salir una persona

1. Eliminarla en la app (**Usuarios →** ícono de basurero; con servidor queda desactivada, no se borra). Sus sesiones se cierran y su historial queda en la bitácora.
2. Si conocía la clave de `revision_app`: crear una nueva versión del secreto, actualizar el usuario en Cloud SQL y volver a publicar Cloud Run.
3. Sacarla de GitHub y de Google Cloud.
