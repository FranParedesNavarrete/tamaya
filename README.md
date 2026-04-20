<p align="center">
  <img src="apps/web/public/tamaya-logo.png" width="128" alt="Tamaya logo" />
</p>

<h1 align="center">Tamaya</h1>

<p align="center">
  Programador y publicador de mensajes (texto + media) para canales de WhatsApp.<br/>
  Automatiza WhatsApp Web con Playwright; cubre un hueco que las APIs oficiales no resuelven.
</p>

---

**Etimología.** *Tamaya!* (玉屋) es el grito tradicional con el que en Japón se celebra un buen fuego artificial, en honor a **Tamaya Ichibei**, el pirotécnico del periodo Edo que se hizo famoso por sus explosiones en masa. Encaja con el proyecto por partida doble: publicamos **en masa** a muchos canales, y la primera vez que lo ves funcionando —el navegador abriéndose solo y moviéndose— es un pequeño *hanabi*.

## ⚠️ Aviso

Tamaya automatiza WhatsApp Web. Esto **viola los Términos de Servicio de WhatsApp/Meta** y puede resultar en el ban de la cuenta. Úsalo bajo tu responsabilidad y **nunca con tu número personal**. Pensado para un número desechable dedicado.

---

## Funcionalidades

- **Dashboard** con métricas en tiempo real: KPIs, gráficos de actividad, top canales, distribución de duración, heatmap por día/hora.
- **Programación de jobs** (texto + imágenes + vídeos) con "Publicar ahora" o fecha concreta.
- **CRUD de canales** con acrónimo, descripción y soft-delete.
- **Reintentar** jobs fallidos en un click (duplica con nueva fecha).
- **Búsqueda** por texto, filtros por estado / canal / rango de fechas.
- **Resolver de media** unificado: sube desde la UI, pega una URL (http/https/s3) o una ruta local — se descarga y almacena con la extensión correcta vía `Content-Type`.
- **Modo claro / oscuro** con persistencia.

---

## Arquitectura

> **El corazón de Tamaya es `worker-publish`** — un proceso Node **nativo** (fuera de Docker) que pilota Chromium con Playwright para abrir WhatsApp Web, navegar a un canal y enviar el mensaje. Todo lo demás (UI, API, resolver, Redis) es infraestructura de scheduling alrededor: una cola de trabajos que el worker consume. El stack de Docker existe para que la UI sea cómoda, no para publicar.

Monorepo con workspaces de npm. Cinco procesos:

| Servicio           | Dónde corre         | Función                                                           |
| ------------------ | ------------------- | ----------------------------------------------------------------- |
| `web`              | Docker (Vite+React) | UI para crear canales, programar jobs, ver estado                 |
| `api`              | Docker (Fastify)    | REST API + BullMQ producer                                        |
| `worker-resolve`   | Docker (x3 réplicas)| Descarga/resuelve media (S3, HTTP, local) → `/tmp/tamaya-media`   |
| `worker-publish`   | pm2 **nativo**      | Playwright + Chromium contra WhatsApp Web (1 instancia por cuenta)|
| `redis`            | Docker              | Backend de BullMQ                                                 |
| MySQL (AWS RDS)    | Externo             | Persistencia                                                      |

El worker de publish corre **fuera de Docker** porque Chromium dentro de contenedor trae problemas con GPU / persistencia de sesión / fingerprint. Además WA solo tolera una sesión por cuenta → `instances: 1` en pm2.

```
       ┌──────┐
       │ web  │
       └──┬───┘
          ▼
       ┌──────┐        ┌────────────────┐
       │ api  │──push──▶ BullMQ (redis) │
       └──┬───┘        └──────┬─────────┘
          │                   │
          ▼                   ▼
       ┌─────┐         ┌──────────────────┐        ┌──────────────┐
       │ RDS │◀────────│ worker-resolve   │───────▶│ /tmp/tamaya- │
       └──┬──┘         │  (docker x3)     │        │   media/     │
          │            └──────────────────┘        └──────┬───────┘
          │                                               │
          │                                        ┌──────▼───────┐
          └──requeue───────────────────────────────│ worker-      │
                                                   │  publish     │
                                                   │ (pm2 native) │
                                                   └──────┬───────┘
                                                          ▼
                                               WhatsApp Web (Chromium)
```

---

## Requisitos

### Software (versiones probadas)

| Herramienta                | Mínimo | Probado con      | Notas                                                      |
| -------------------------- | ------ | ---------------- | ---------------------------------------------------------- |
| **Node.js**                | 20.0   | 22.13            | El worker-publish corre nativo con Node del host.          |
| **npm**                    | 10.0   | 10.x             | Incluido con Node. Workspaces nativos, sin pnpm/yarn.      |
| **Docker**                 | 24     | 29.2             | Redis, API, worker-resolve y web corren en contenedor.     |
| **Docker Compose**         | v2.20  | v5.0 (plugin)    | Se usa la CLI `docker compose …`, no el viejo `docker-compose`. |
| **MySQL**                  | 8.0    | AWS RDS 8.0.39   | Puede ser local, pero RDS es el camino cómodo.             |
| **Playwright (Chromium)**  | 1.48   | 1.48             | Se instala con `npx playwright install chromium`.          |
| **pm2**                    | 5.4    | 5.4              | **Instalar globalmente** (`npm install -g pm2`). Imprescindible para gestionar el worker-publish nativo. |

### Sistema operativo

- **macOS** (Intel o Apple Silicon) — probado en 14 Sonoma / Darwin 25.
- **Linux** (Ubuntu 22.04, Debian 12, Fedora 40) — debería funcionar igual.
- **Windows** — no soportado directamente; usa WSL2.

### Cuenta / acceso externo

- **Número de WhatsApp desechable** con un canal de prueba creado.
- **Instancia MySQL accesible** desde tu host (RDS público o túnel).
- (Opcional) **S3 / IAM** si vas a resolver sources `s3://...`.

---

## Antes de clonar el repo

Estos pasos los haces **una sola vez** en la máquina donde vas a ejecutar Tamaya.

### 1. Instalar Node 20+ y npm

En macOS con `brew`:

```bash
brew install node          # instala la última LTS
node --version             # >= 20
npm --version              # >= 10
```

Si ya tienes otras versiones, usa [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 22 && nvm use 22
```

### 2. Instalar pm2 globalmente

`pm2` orquesta el `worker-publish` (que corre **fuera de Docker**). Tiene que estar disponible en el `$PATH` del sistema, no solo como dependencia local.

```bash
npm install -g pm2
pm2 --version          # >= 5.4
```

> Si lo instalas solo como `devDependency` del workspace, los comandos `npm run pm2:start`, `pm2 logs`, `pm2 startup`, `pm2 save` fallarán con `command not found` o se ejecutarán contra una instancia distinta y los procesos no quedarán visibles.

### 3. Instalar Docker Desktop

- macOS: [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
- Linux: `curl -fsSL https://get.docker.com | sh`

Comprueba:

```bash
docker --version
docker compose version
```

**Importante (macOS):** en *Settings → Resources → File sharing*, asegúrate de que `/tmp` es accesible — lo necesitamos para el bind-mount compartido.

### 4. Crear la base de datos

**Opción A — AWS RDS MySQL 8** (recomendado):

1. Crea una instancia MySQL 8.0 en RDS (db.t3.micro vale para PoC).
2. Abre el security group al puerto 3306 desde tu IP.
3. Conecta y crea el schema:
   ```sql
   CREATE DATABASE tamaya CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

**Opción B — MySQL local**:

```bash
docker run -d --name mysql-local \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=tamaya \
  -p 3306:3306 \
  mysql:8.0
```

Guarda la URL en formato `mysql://user:password@host:3306/tamaya` — la necesitas en el siguiente paso.

### 5. (Opcional) Credenciales AWS S3

Solo si vas a publicar media que viva en S3. Configura un IAM user con `s3:GetObject` sobre tus buckets y guarda `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

---

## Instalación

### 1. Clonar y entrar al repo

```bash
git clone https://github.com/FranParedesNavarrete/tamaya.git
cd tamaya
```

### 2. Instalar dependencias de Node

```bash
npm install                        # instala workspaces (apps/* + packages/*)
npx playwright install chromium    # navegador para el worker-publish
```

> El repo tiene `.npmrc` con `legacy-peer-deps=true` — necesario por el conflicto de React 19 con algunas dependencias transitivas.

### 3. Configurar variables de entorno

```bash
cp .env.example .env
$EDITOR .env
```

Valores obligatorios a rellenar:

```bash
DATABASE_URL=mysql://user:password@host:3306/tamaya
# S3 solo si vas a resolver s3://... — si no, deja en blanco
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=eu-west-1
```

El resto trae valores por defecto razonables. `TAMAYA_TMP_DIR=/tmp/tamaya-media` es **ruta absoluta compartida** entre el `worker-resolve` (Docker, bind-mount) y el `worker-publish` (nativo) — no la cambies salvo que sepas lo que haces.

### 4. Crear el directorio temporal compartido

`worker-resolve` (Docker) y `worker-publish` (nativo) se intercambian los archivos vía un bind-mount sobre `TAMAYA_TMP_DIR`. El directorio **debe existir antes de levantar Docker**, si no, Docker lo crea con `root:root` y el worker nativo no podrá leerlo.

```bash
sudo mkdir -p /tmp/tamaya-media
sudo chown -R $(whoami):$(id -gn) /tmp/tamaya-media
chmod 775 /tmp/tamaya-media
```

> En **macOS** basta con `mkdir -p /tmp/tamaya-media` (sin sudo, ya eres dueño de `/tmp`).
>
> En **Linux**, si cambiaste `TAMAYA_TMP_DIR` a algo en tu `$HOME` (recomendado en servidor para que no se borre en cada reboot), ajusta los paths.

Verifica:

```bash
ls -ld /tmp/tamaya-media
# drwxrwxr-x  2 fran fran  64  ...  /tmp/tamaya-media
```

### 5. Crear el esquema en la BD

```bash
npm run db:push
```

Crea las tablas `jobs`, `channels`, `audit_log` vía `drizzle-kit`.

### 6. Construir los paquetes compartidos

```bash
npm run build
```

### 7. Levantar el stack dockerizado

```bash
docker compose up -d --build
```

Arranca `redis`, `api`, `worker-resolve` (x3) y `web`.

Comprobación rápida:

```bash
docker compose ps                   # todos "running / healthy"
curl http://localhost:3001/health   # api
open http://localhost:5173          # web
```

### 8. Login inicial de WhatsApp (una sola vez)

Abre Chromium para escanear el QR. La sesión se persiste en `apps/worker-publish/sessions/default-profile/` y se reutiliza en cada ejecución.

```bash
npm run login
```

Escanea con el móvil de la cuenta desechable → cuando veas la lista de chats, cierra la ventana.

### 9. Arrancar el worker de publicación con pm2

```bash
cd apps/worker-publish
npm run pm2:start
pm2 logs tamaya-worker-publish
```

Para que arranque al reboot:

```bash
pm2 startup     # imprime un sudo — ejecútalo
pm2 save
```

---

## How to use

### Programar un mensaje

1. Abre **http://localhost** → te recibe el **Dashboard**.
2. Ve a **Canales → + Nuevo canal**. El "Nombre" debe ser **exactamente** el que muestra WA Web (p.ej. `Pruebas n8n`).
3. Ve a **Jobs → + Nuevo**:
   - **Canal** (requerido).
   - **Texto** (se envía como caption si hay media).
   - **Media** (opcional): sube archivo, pega URL `https://…` / `s3://…` o una ruta local absoluta. Solo imagen o vídeo — WA Channels no acepta documentos.
   - **Cuándo publicar**: marca "Publicar ahora" o pon fecha/hora.
4. El job avanza por estados:

   ```
   pending → resolving → ready → publishing → sent
                                              ↓
                                           failed  (si algo peta)
                                              ↓
                                          cancelled
   ```

5. Desde la lista:
   - **Reintentar**: duplica el job con fecha nueva.
   - **Cancelar**: solo en `pending` / `ready` / `failed`.
   - **Borrar**: solo si no está en curso.

### Dashboard

- **KPIs** arriba: total, enviados, fallidos, pendientes, tasa de éxito, duración media.
- **Timeline** (área) con sent/failed/cancelled por día/hora/semana.
- **Pie** por estado, **barras horizontales** de top canales.
- **Heatmap 7×24** de cuándo se programan los jobs.
- **Histograma** de duración (<5s, 5-15s, …).
- **Fallos recientes** con el error y tiempo relativo.
- **Buscador** con texto libre + filtros (estado, canal, rango de fechas).

### Tips operativos

- **Un solo navegador por cuenta:** `instances: 1` en pm2. Si abres WA Web en paralelo en otro sitio, la sesión del worker se invalida.
- **Login "expira":** si ves errores como *"Vincular un dispositivo"* recurrentes, borra `apps/worker-publish/sessions/default-profile/` y vuelve a `npm run login`.
- **Ver qué pasó en un fallo:** `apps/worker-publish/debug/` guarda screenshot + HTML del DOM en el momento del error.

---

## Desarrollo

Modo dev (hot reload en api, web, worker-resolve) gracias al `docker-compose.override.yml`:

```bash
docker compose up                # sin -d, ves logs en vivo
```

El `worker-publish` se lanza fuera de Docker, en `tsx watch`:

```bash
cd apps/worker-publish
npm run dev
```

### Cuando modificas paquetes compartidos

Si tocas algo en `packages/core`, `packages/db`, `packages/media-resolver` o `packages/shared-types`:

```bash
# rebuild del package tocado
npm --workspace @tamaya/core run build

# si era usado por el worker-publish (nativo):
cd apps/worker-publish && npm run build
pm2 restart tamaya-worker-publish

# si era usado por api o worker-resolve (Docker):
docker compose up -d --build api worker-resolve
```

### Cuando añades dependencias al web (dev)

El contenedor de web en dev tiene un volumen anónimo en `/app/node_modules` que NO se sincroniza con el host. Tras un `npm install`:

```bash
docker compose rm -sfv web && docker compose up -d --build web
```

---

## Mantenimiento

### Monitorización

```bash
# worker nativo
pm2 status
pm2 logs tamaya-worker-publish --lines 200
pm2 monit                        # UI en terminal

# stack dockerizado
docker compose ps
docker compose logs -f api
docker compose logs -f worker-resolve
```

### Limpieza

```bash
# media temporal (se regenera)
rm -rf /tmp/tamaya-media/*

# dumps de debug (crecen con cada fallo)
rm -rf apps/worker-publish/debug/*

# logs del worker-publish (rotar manualmente — pm2 no los rota por defecto)
rm apps/worker-publish/logs/*.log
pm2 reloadLogs
```

### Actualizar Tamaya (pull)

```bash
git pull
npm install                      # por si hay deps nuevas
npm run build                    # paquetes compartidos
npm run db:push                  # aplica cambios de schema (idempotente)
docker compose up -d --build     # rebuild contenedores
pm2 restart tamaya-worker-publish
```

### Renovar la sesión de WhatsApp

```bash
rm -rf apps/worker-publish/sessions/default-profile
npm run login
```

### Abrir el navegador persistido (debug / cambiar idioma / limpiar tips)

`npm run login` se cierra solo en cuanto detecta la app cargada, así que no sirve para operar dentro del perfil. Para eso está `npm run open`:

```bash
pm2 stop tamaya-worker-publish     # libera el lock del userDataDir
npm run open                       # abre Chromium con el perfil y se queda
# (haz lo que tengas que hacer: cambiar Settings → Language a English,
#  cerrar tooltips, revisar un canal, inspeccionar DOM con DevTools, etc.)
# Cierra la ventana cuando acabes — el proceso termina solo.
pm2 start tamaya-worker-publish
```

Casos típicos:

- **Cambiar el idioma a inglés.** Los selectores del caption de media están en EN + ES. Si WA Web te lo sirvió en otro idioma, pon EN para estar cubierto.
- **Dismiss de overlays persistentes** ("Prueba el nuevo…", "Vincula tu número…") que tapan la UI.
- **Inspección visual** del DOM real con DevTools cuando un selector deja de funcionar.

### Backup mínimo

Lo único irrecuperable son:

- **La base de datos** (jobs, canales, auditoría) — snapshot de RDS o `mysqldump` según config.
- **`apps/worker-publish/sessions/default-profile/`** — si lo pierdes, solo tienes que reescanear el QR.

Todo lo demás se reconstruye del repo.

---

## Stack técnico

**Núcleo (lo que publica):**

- **Playwright** (persistent context) contra WhatsApp Web, corriendo en **Chromium nativo del host** (no Docker — por compatibilidad de fingerprint, GPU y persistencia de sesión).
- Gestionado con **pm2** en modo `fork` con `instances: 1` — WA solo tolera una sesión por cuenta.

**Scheduler y UI (lo que hace cómodo programar):**

- **Backend:** TypeScript, Node 20, Fastify, BullMQ sobre Redis, Drizzle ORM, MySQL.
- **Frontend:** React 19, Vite, TailwindCSS, shadcn-style UI, Recharts.
- **Media resolver:** `@fastify/multipart` → tmp compartido → resolver (local / S3 / HTTP) con detección de MIME por `Content-Type`.
- **Packaging:** Docker Compose para UI + API + resolver + Redis. MySQL es externo (RDS recomendado).

---

## Troubleshooting

**`DATABASE_URL not set` en worker-publish**
El worker-publish carga `.env` desde la raíz del repo. Asegúrate de que `/path/to/tamaya/.env` existe y contiene `DATABASE_URL`. Si ejecutas con pm2, el `cwd` es `apps/worker-publish`; el código resuelve `../../../.env`.

**`ENOENT /tmp/tamaya-media/...` en worker-publish**
El worker-resolve (Docker) escribió el archivo en un volumen que el worker-publish nativo no ve. Causas habituales:
1. El directorio no existe → `mkdir -p $TAMAYA_TMP_DIR && chown $(whoami) $TAMAYA_TMP_DIR` (ver paso 4 de Instalación).
2. `TAMAYA_TMP_DIR` no es la **misma ruta absoluta** en `.env` que el bind-mount de `docker-compose.yml` (debe ser `${TAMAYA_TMP_DIR}:${TAMAYA_TMP_DIR}`).
3. El directorio existe pero pertenece a `root` (Docker lo creó al arrancar) → `sudo chown -R $(whoami):$(id -gn) $TAMAYA_TMP_DIR`.

**El vídeo se envía sin caption / solo llega el texto**
El vídeo necesita tiempo para subir. El worker espera hasta ~3 min según tamaño. Revisa los logs de `pm2 logs tamaya-worker-publish` — busca `waiting for upload to complete`.

**"no session found — run npm run login first"**
La sesión no existe o caducó. Vuelve a ejecutar `npm run login` y escanea el QR.

**El caption del media nunca se escribe → `waitForAny: no selector matched` con `"Type an update"`, `"caption"`, etc.**
Casi siempre es el **idioma de WhatsApp Web**. Los selectores cubren EN + ES; si tu sesión está en otro idioma, el `aria-label` del textbox de caption no matchea. Solución:
```bash
pm2 stop tamaya-worker-publish
npm run open     # cambia Settings → Language → English en el Chromium que se abre
pm2 start tamaya-worker-publish
```

**WhatsApp Web pide "Vincular un dispositivo" aunque ya escaneaste el QR**
WA invalida sesiones antiguas. Reescanea; si persiste, borra `apps/worker-publish/sessions/default-profile/` y vuelve a loguear.

**Job en `failed`**
Mira el campo `lastError` en la tabla (o en la UI) y el screenshot en `apps/worker-publish/debug/`. La mayoría de fallos son por cambios de WA Web — los selectores están centralizados en `packages/core/src/browser/selectors.ts`.

---

## Estructura del repo

```
tamaya/
├── apps/
│   ├── api/              # Fastify REST + BullMQ producer
│   ├── web/              # Vite + React + shadcn
│   ├── worker-publish/   # Playwright → WA Web (pm2 native)
│   └── worker-resolve/   # Descarga media (Docker x3)
├── packages/
│   ├── core/             # Lógica de Playwright (selectors, publisher)
│   ├── db/               # Drizzle schema + client
│   ├── media-resolver/   # S3 / HTTP / local resolver
│   └── shared-types/     # Zod schemas compartidos
├── docker-compose.yml    # Stack base
├── docker-compose.override.yml  # Modo dev
└── docs/                 # Notas de diseño y parches
```

---

## Licencia

Uso personal / educativo. No producción sin revisión de ToS.
