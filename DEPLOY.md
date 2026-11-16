# Despliegue

La app funciona de dos formas:

| Modo | Dónde vive la información | Para qué |
|---|---|---|
| **Sin servidor** (GitHub Pages o demo) | En cada tablet (navegador) | Probar, o una sucursal sola |
| **Con servidor** (Google Cloud) | En la base de datos central | Uso real: varias sucursales, la central ve todo, bitácora inalterable |

La app detecta sola si hay servidor (`api/estado.php`). No hay que cambiar nada en el código.

## 1. Sin servidor: GitHub Pages

1. En GitHub: **Settings → Pages → Source: GitHub Actions**.
2. Cada merge a `main` publica la app en `https://<usuario>.github.io/revisionsucursal/`.

## 2. Con servidor: Google Cloud (Cloud Run + Cloud SQL)

Requisitos: proyecto de Google Cloud con facturación, `gcloud` instalado y la región `southamerica-west1` (Santiago).

### 2.1 Base de datos (Cloud SQL para MySQL 8)

```bash
gcloud sql instances create revision-db --database-version=MYSQL_8_0 --region=southamerica-west1 --tier=db-g1-small --no-assign-ip --network=default
gcloud sql databases create revision --instance=revision-db --charset=utf8mb4 --collation=utf8mb4_unicode_ci
```

Crear las tablas y el usuario de la app (desde Cloud Shell con `gcloud sql connect revision-db --user=root`):

1. Ejecutar `servidor/sql/01_esquema.sql` en la base `revision`.
2. Editar `servidor/sql/02_usuario_app.sql`, cambiar `CAMBIAR_CLAVE` por una clave larga y aleatoria, y ejecutarlo. **No guardar esa clave en el repositorio.**

La IP privada (`--no-assign-ip`) evita que la base quede expuesta a internet.

### 2.2 Clave en Secret Manager

```bash
printf '%s' 'LA_CLAVE_DEL_PASO_ANTERIOR' | gcloud secrets create revision-db-pass --data-file=-
```

### 2.3 Publicar en Cloud Run

```bash
gcloud run deploy revision --source . --region=southamerica-west1 \
  --add-cloudsql-instances=PROYECTO:southamerica-west1:revision-db \
  --set-env-vars=DB_SOCKET=/cloudsql/PROYECTO:southamerica-west1:revision-db,DB_NAME=revision,DB_USER=revision_app \
  --set-secrets=DB_PASS=revision-db-pass:latest \
  --allow-unauthenticated --min-instances=0 --max-instances=4
```

`--allow-unauthenticated` permite abrir la app desde las tablets; el acceso a los datos lo controla el inicio de sesión de la app.

### 2.4 Primera vez

Abrir la URL de Cloud Run: la app pide **crear el administrador**. Después, desde el menú de usuario: **Usuarios**, **Maestro de productos** y **Subir costos**.

### 2.5 Respaldos

```bash
gcloud sql instances patch revision-db --backup-start-time=03:00 --enable-point-in-time-recovery
```

## 3. Pruebas antes de cada publicación

```bash
# Base local de pruebas (nunca en producción)
bash servidor/tests/reset_db_local.sh
DB_USER=revision_app DB_PASS=clave_local_pruebas php -S 127.0.0.1:8780 -t . &
BASE=http://127.0.0.1:8780 bash servidor/tests/smoke_api.sh   # debe decir "0 con falla"
```

## 4. Cómo volver atrás

- **Cloud Run:** `gcloud run services update-traffic revision --to-revisions=REVISION_ANTERIOR=100` (lista con `gcloud run revisions list`).
- **Base de datos:** restaurar el respaldo automático desde la consola de Cloud SQL.
- **App en GitHub Pages:** revertir el merge en GitHub y se republica sola.
