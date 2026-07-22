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

- **macOS** (Intel o Apple Silicon) — el camino más directo; el QR de WhatsApp se escanea localmente.
- **Linux server** (Ubuntu 22.04 / Debian 12 recomendados) — soportado, pero hay dos detalles propios: dependencias nativas de Chromium y cómo escanear el QR sin pantalla. Ver sección "[Despliegue en servidor Linux](#despliegue-en-servidor-linux-headless)" más abajo.
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
# URL pública donde se sirve la app — sin puerto, sin slash final.
# Local:        http://localhost
# Producción:   https://tamaya.midominio.com
APP_URL=http://localhost

DATABASE_URL=mysql://user:password@host:3306/tamaya

# S3 solo si vas a resolver s3://... — si no, deja en blanco
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=eu-west-1
```

`APP_URL` se usa para construir `API_CORS_ORIGIN` y el `VITE_API_BASE_URL` de build del frontend — un solo cambio cubre los tres sitios. El resto trae valores por defecto razonables. `TAMAYA_TMP_DIR=/tmp/tamaya-media` es **ruta absoluta compartida** entre el `worker-resolve` (Docker, bind-mount) y el `worker-publish` (nativo) — no la cambies salvo que sepas lo que haces.

> ⚠️ **Si la contraseña de MySQL tiene `$`, `#`, `&`, `*`, `%` u otros símbolos**, **percent-encódalos** antes de ponerla en `DATABASE_URL`. Una sola línea:
>
> ```bash
> node -p 'encodeURIComponent("MI-PASSWORD-CON-SIMBOLOS")'
> ```
>
> Y mete el resultado entre `admin:` y `@`. Recomendación: si puedes, usa una password sin esos caracteres y te ahorras el dolor.

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

## Despliegue en servidor Linux (headless)

El flujo en macOS es directo porque el QR de WhatsApp se escanea con una ventana real. En un servidor Linux sin pantalla hay tres detalles extra:

### A. Dependencias de sistema para Chromium

Playwright no trae las libs nativas que macOS sí incluye:

```bash
sudo apt update
sudo apt install -y curl build-essential
sudo npx playwright install-deps chromium     # libnss3, libatk-bridge2.0-0, ...
```

### B. Sesión de WhatsApp sin pantalla

`npm run login` abre Chromium en modo headful y no hay forma de escanear el QR en un servidor sin display. Las dos rutas viables:

**Opción 1 — Login en una máquina con pantalla y sincronizar (recomendado):**

```bash
# En tu Mac/laptop:
git clone … && cd tamaya && npm install && npm run login
# Escanea el QR, espera a ver la lista de canales, cierra la ventana.

# Copia la sesión al server:
rsync -avz apps/worker-publish/sessions/default-profile/ \
  usuario@server:/ruta/a/tamaya/apps/worker-publish/sessions/default-profile/
```

Si has copiado con `sudo rsync` revisa el owner:

```bash
sudo chown -R $USER:$USER apps/worker-publish/sessions
```

**Opción 2 — Xvfb + VNC** (display virtual). Más complicado, solo si no tienes acceso a una segunda máquina:

```bash
sudo apt install -y xvfb x11vnc
# Lanza display virtual:
Xvfb :99 -screen 0 1440x900x24 &
export DISPLAY=:99
x11vnc -display :99 -bg -nopw -listen 127.0.0.1 -xkb &
# Reenvía VNC por SSH desde tu Mac: ssh -L 5900:127.0.0.1:5900 server
# Conecta con cualquier cliente VNC al localhost:5900
DISPLAY=:99 npm run login
```

### C. pm2 + systemd para auto-start

```bash
cd apps/worker-publish
npm run pm2:start
pm2 startup systemd          # imprime un sudo … — ejecútalo tal cual
pm2 save                     # graba la lista actual de procesos
```

A partir de aquí, el `worker-publish` arranca solo en cada reboot.

### D. Firewall / acceso externo

Por defecto el stack escucha en:

- `80`  → web UI
- `3001` → API
- `6379` → Redis (NUNCA debe estar abierto a internet)

En `ufw`:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 3001/tcp      # solo si vas a llamar a la API desde fuera
# NUNCA: sudo ufw allow 6379/tcp
```

Mejor todavía: pon un reverse proxy (Caddy, Nginx, Traefik) delante con TLS, y deja el puerto 3001 cerrado al exterior.

### E. Sanity check post-deploy

```bash
# todos verdes:
docker compose ps
pm2 status
curl -sf http://localhost:3001/health
ls apps/worker-publish/sessions/default-profile/Default/IndexedDB | head -3   # debe haber ficheros
```

Si los cuatro pasan, programa un job de texto desde la UI y mira `pm2 logs tamaya-worker-publish` — deberías ver el flujo completo.

---

## How to use

> **¿Integrando desde otra app?** Tamaya expone una REST API en `http://localhost:3001`. Documentación completa con ejemplos (curl, Node, Python, n8n): **[docs/API.md](docs/API.md)**.

### Programar un mensaje

1. Abre **http://localhost** → te recibe el **Dashboard**.
2. Ve a **Canales → + Nuevo canal**. El "Nombre" debe ser **exactamente** el que muestra WA Web (p.ej. `Pruebas n8n`).
3. Ve a **Jobs → + Nuevo**:
   - **Canal** (requerido).
   - **Texto** (se envía como caption si hay media). Soporta saltos de línea reales y la sintaxis nativa de WhatsApp:
     - `*negrita*` → **negrita**
     - `_cursiva_` → *cursiva*
     - `~tachado~` → ~~tachado~~
     - `` `monoespacio` `` para inline; ` ```bloque``` ` para varias líneas.
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
   - **Borrar**: *soft-delete* — solo si no está en curso. La fila no se elimina
     de la BD; se marca `deletedAt` y deja de aparecer en listados y métricas.

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

## Seguridad API (Bearer token)

La API se puede proteger con un token Bearer. Comportamiento:

- **Sin token configurado** → la API está abierta (permite el bootstrap y el
  primer arranque). `/health` siempre es público.
- **Con token configurado** → todos los endpoints exigen token, salvo
  `GET /health` y `GET /settings/security`. Sin token válido devuelven `401`.

### Levantar en local

```bash
docker compose up -d --build
# App web:  http://localhost:${WEB_PORT}   (por defecto 5173)
# API:      http://localhost:3001
```

### Generar el token desde Ajustes

1. Abre la web → **Ajustes** (icono en la navbar).
2. Sección **Seguridad API** → **Generar primer token**.
3. Copia el token: **solo se muestra una vez**. Se guarda automáticamente en
   este navegador (`localStorage: tamaya_api_token`) para que la UI siga
   llamando a la API.
4. Para **rotar**, pulsa *Rotar token* (pide confirmación). El token anterior
   queda invalidado.

Solo se persiste el **hash** del token (SHA-256) en la tabla `app_settings`;
el token plano nunca se almacena.

### Generar el token por API (sin UI)

```bash
# Solo funciona mientras NO haya token configurado (bootstrap):
curl -sX POST http://localhost:3001/settings/security/api-token
# → {"token":"tamaya_xxxxxxxx...","shownOnce":true}

# Estado (público):
curl -s http://localhost:3001/settings/security
# → {"apiTokenConfigured":true}
```

### Llamar a la API con token

```bash
# Sin token (con token ya configurado) → 401
curl -i http://localhost:3001/jobs

# Con token → 200
curl -i -H "Authorization: Bearer tamaya_xxxxxxxx..." http://localhost:3001/jobs
# Alternativa: -H "X-API-Token: tamaya_xxxxxxxx..."
```

> **Desarrollo:** `API_AUTH_DISABLED=true` en `.env` desactiva el guard por
> completo. **No usar en producción.**

### Nota Ubuntu Server / headless

Tamaya está pensada para desplegarse en servidor headless. Evita flujos que
dependan de ventanas o navegadores visibles en la máquina. Desde la Iteración 2
la vinculación de WhatsApp puede hacerse por QR **desde la UI** (ver abajo);
también sigue disponible copiar la sesión (ver *Despliegue en servidor Linux*).

---

## WhatsApp desde la UI, selectores editables y embed (Iteración 2)

### Control server (worker-publish nativo)

La administración de la sesión de WhatsApp (estado / login QR / reset) la sirve
un **control server** HTTP local que corre NATIVO en el host (usa Playwright/
Chromium sobre el mismo perfil que el publisher). La API (en Docker) actúa de
gateway protegido y lo alcanza vía `TAMAYA_CONTROL_URL`.

Arrancarlo en Ubuntu:

```bash
npm install
npx playwright install chromium
npm run build
# a mano:
npm run control -w apps/worker-publish
# o con pm2:
cd apps/worker-publish && npm run pm2:control:start
```

Variables (`.env`):

```env
# macOS/Desktop: 127.0.0.1 vale. Ubuntu + API en Docker: usa 0.0.0.0
# para que el contenedor llegue vía host.docker.internal/host-gateway.
TAMAYA_CONTROL_HOST=0.0.0.0
TAMAYA_CONTROL_PORT=3010
TAMAYA_CONTROL_URL=http://host.docker.internal:3010
# Obligatorio si TAMAYA_CONTROL_HOST no es loopback. Genera con: openssl rand -hex 32
TAMAYA_CONTROL_TOKEN=pon-un-token-largo-aqui
TAMAYA_HEADLESS=true        # en servidor sin display
```

**Docker sobre Linux:** `docker-compose.yml` ya añade `host.docker.internal:host-gateway` en el servicio `api` para que pueda llegar al control server nativo. Si expones el control server en `0.0.0.0`, protégelo con `TAMAYA_CONTROL_TOKEN` y firewall.

> **Bloqueo de perfil:** el control server y `worker-publish` comparten
> `userDataDir` y Chromium no admite dos procesos sobre el mismo perfil. Haz la
> vinculación cuando no haya publicaciones en curso (idealmente
> `pm2 stop tamaya-worker-publish` durante el login y arráncalo de nuevo al
> terminar).

### Vincular WhatsApp por QR desde la UI

1. Arranca el control server nativo (arriba).
2. Web → **Ajustes → WhatsApp**.
3. **Iniciar vinculación** → aparece el QR (polling cada ~2,5 s).
4. Móvil → *Dispositivos vinculados → Vincular un dispositivo* → escanea.
5. Cuando el estado pase a **Listo**, reinicia `worker-publish`.
6. **Resetear sesión** cierra el navegador y borra el perfil (no toca la BD).

Si WhatsApp bloquea el QR en headless por fingerprint, ejecuta el control server
bajo **Xvfb** (no hace falta abrir ninguna ventana en local):

```bash
xvfb-run -a npm run control -w apps/worker-publish
```

### Selectores editables

Web → **Ajustes → Selectores WhatsApp**. Permite guardar *overrides* de los
selectores del DOM sin tocar código, para sobrevivir a cambios de WhatsApp:

- Los **defaults** viven en el código (`@tamaya/shared-types` +
  `packages/core/src/browser/selectors.ts`) y se mantienen como fallback.
- Los overrides se guardan en `app_settings` (clave `selectors.overrides`) como
  JSON: `{ "appReady": ["#pane-side"], "sendButton": ["div[role='button'][aria-label^='Send']"] }`.
- Solo son editables las claves de tipo **array**. Los selectores **dinámicos**
  (`channelRowByName`, `messageComposerForChannel`) son funciones y NO son
  editables (mantienen defaults).
- Los cambios se aplican al **arrancar** worker-publish / control server →
  **reinicia el worker** tras guardar.

API equivalente: `GET/PUT/POST /settings/selectors` (ver `docs/API.md`).

### Modo embed

Añade `?embed=1` a cualquier ruta para ocultar navbar y controles globales
(útil para incrustar en iframe):

```txt
http://localhost:${WEB_PORT}/jobs?embed=1
```

El flag se recuerda durante la sesión del navegador (`?embed=0` lo desactiva).
El modo embed **no** cambia la seguridad: las llamadas a la API siguen
necesitando el API token. No hay aún tokens temporales ni scopes.

---

## Pipeline, diagnóstico y operación (Iteración 3)

### El pipeline de un job

```
POST /jobs → resolve-queue → (status: resolving → ready) → publish-queue → worker-publish → sent
```

Un job en **`ready`** está resuelto y **esperando a que `worker-publish` lo
consuma**. Si `worker-publish` (nativo) no está corriendo, el job se queda en
`ready`/en cola y **no se publica** — esto es lo esperado, no un error.

### Diagnóstico

Endpoints protegidos (ver `docs/API.md`):

- `GET /ops/queues` — conteos BullMQ de `resolve`/`publish`.
- `GET /ops/publisher` — si worker-publish está consumiendo, heartbeat, y un
  `message` explicativo (p.ej. *"Hay jobs listos pero worker-publish no está
  consumiendo"*).
- `GET /ops/health` — salud de DB/Redis/control server/publisher.

En la UI: **Jobs → Ver diagnóstico** (o **Ajustes → Diagnóstico del pipeline**)
muestra colas, heartbeat y estado. Si hay jobs `ready` y el publisher está
offline, Jobs muestra un **banner** indicándolo.

**Heartbeat:** `worker-publish` y `control-server` escriben su latido en
`app_settings` (`worker.publish.heartbeat` / `worker.control.heartbeat`) cada
~12 s. La API considera el proceso *online* si el latido tiene < 30 s.

### Reencolar una publicación

Si un job quedó `failed`/`ready` por un problema operativo ya resuelto (worker
parado, perfil bloqueado), **Reencolar publicación** (UI) o
`POST /jobs/:id/requeue-publish` lo vuelve a poner en `publish-queue` sin
duplicarlo. Requiere `worker-publish` activo para que se envíe.

### Verificación de publicación (anti-falsos-fallos / anti-duplicados)

Tras pulsar **Send**, el worker verifica el **contenido real** del hilo (no solo
los ticks `msg-check`, que WhatsApp Channels no siempre muestra):

- **`sent`** solo si hay evidencia de un item nuevo y —si aplicaba— el
  **texto/caption** aparece en el hilo y la **media** se detecta.
- Si el fallo es **antes** de pulsar Send (sesión, canal, adjuntar, preview…),
  el job se **reintenta** (aún no se publicó nada).
- Si es **después** de pulsar Send y no se puede confirmar el contenido, el job
  se marca **`failed`** con `lastError` que empieza por
  `POST_SEND_VERIFICATION_FAILED` y **NO se reintenta** (para no duplicar). La UI
  muestra un aviso claro y guardamos `verificationMeta` (auditoría) en el job.

Timeouts de subida configurables por `.env` (aplican al caso más lento, vídeo):

```env
TAMAYA_MEDIA_UPLOAD_TIMEOUT_MAX_MS=1800000    # tope duro (30 min)
TAMAYA_MEDIA_UPLOAD_TIMEOUT_PER_MB_MS=6000     # margen por MB
```

Si no se definen o no son válidos, se usan esos defaults (con warning en logs).

### Lock de perfil de WhatsApp

`control-server` y `worker-publish` comparten `TAMAYA_USER_DATA_DIR` y Chromium
no admite dos procesos sobre el mismo perfil. Ahora hay un **lock explícito**
(`sessions/default-profile/.tamaya-profile.lock`): quien abre Chromium adquiere
el lock y lo libera al cerrar. Si el otro proceso lo tiene, el que llega recibe
un error claro (*"El perfil de WhatsApp está ocupado por control-server…"*) en
lugar de un crash de Chromium. Los locks *stale* (PID muerto) se sobrescriben.

### Operación en Ubuntu (autoarranque tras boot)

Los procesos **nativos** (`worker-publish` + `control-server`) se gestionan con
**PM2** y sobreviven a reinicios. Docker levanta API/web/worker-resolve/infra
por sus *restart policies*; PM2 (vía systemd) levanta los nativos. Tras el boot
la app queda lista **sin abrir ninguna terminal**.

Instalación y arranque (una vez):

```bash
npm install
npx playwright install chromium
sudo npx playwright install-deps chromium     # deps de sistema (Ubuntu)

npm run build
docker compose up -d --build                   # API / web / worker-resolve / infra

npm run native:start                           # worker-publish + control-server (PM2)
pm2 startup                                    # imprime un comando con sudo → ejecútalo
pm2 save                                        # persiste la lista para el boot
```

O usa el helper (comprueba requisitos, compila y arranca; imprime `pm2 startup`/`save`):

```bash
bash scripts/setup-native.sh
```

Scripts operativos (desde la raíz):

| Script | Acción |
| ------ | ------ |
| `npm run native:start`   | Arranca ambos procesos bajo PM2 (`ecosystem.config.cjs`). |
| `npm run native:stop`    | Para ambos. |
| `npm run native:restart` | Reinicia ambos. |
| `npm run native:logs`    | Logs de ambos. |
| `npm run native:status`  | `pm2 status`. |
| `npm run native:save`    | `pm2 save` (persistir para el boot). |

- **QR y publicación conviven:** ambos procesos pueden estar siempre vivos. El
  **lock de perfil** impide que abran Chromium a la vez y da un error claro si
  coinciden; ya **no** hace falta parar el publisher para vincular.
- Si `pm2` no está global: `npm install -g pm2` (ver aviso en *Antes de clonar*).

Verifica en la UI (**Ajustes → Diagnóstico del pipeline**) o por API
(`GET /ops/publisher`) que `publisherOnline: true` tras `native:start`.

---

## Desarrollo

Modo dev (hot reload en api, web, worker-resolve) directamente con el
`docker-compose.yml` único (los servicios arrancan con `npm run dev` y montan
el código del host):

```bash
docker compose up                # sin -d, ves logs en vivo
```

> Los servicios dev construyen el `dist` de los packages que consumen **antes**
> de arrancar el watcher, así que un repo recién clonado (sin `packages/*/dist`)
> levanta sin errores de imports.

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

**El vídeo se envía sin caption / solo llega el texto / se cierra el navegador antes de terminar**
El vídeo necesita tiempo para que WA Web (a) genere el preview, (b) parsee el contenedor y (c) suba el archivo. Los timeouts están **escalados por MB**:

| Etapa          | Vídeo base | Vídeo / MB | Máximo |
| -------------- | ---------- | ---------- | ------ |
| Preview load   | 90 s       | +2 s       | 10 min |
| Metadata ready | 60 s       | +3 s       | 10 min |
| Upload         | 240 s      | +6 s       | 30 min |

Si aún así un vídeo concreto peta, revisa `pm2 logs tamaya-worker-publish` y busca:
- `waiting for upload to complete` + `timeoutMin` → ves cuánto se concede.
- `upload still pending` cada 10s → sabes si avanza o está estancado.
- `upload marked as failed by WhatsApp (retry indicator found)` → WA rechazó el upload (p. ej. cuota, formato, red).

Para comprimir un vídeo antes de enviarlo (Mac):
```bash
ffmpeg -i input.mp4 -vcodec libx264 -crf 28 -preset fast -acodec aac output.mp4
```

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

**`Access denied for user 'admin'@... (using password: NO)`**
La password está saliendo vacía. Casi siempre: caracteres especiales (`#`, `$`, `&`, `*`, `%`) sin percent-encode. Pasa la pw por:
```bash
node -p 'encodeURIComponent("MI-PASSWORD-EN-PLANO")'
```
Y mete el resultado entre `admin:` y `@`. Comillas simples alrededor del valor en `.env`.

**`TLS/SSL error: Certificate verification failure`** al conectar a RDS
RDS exige TLS y la CA de Amazon no está en el truststore por defecto. Tamaya **activa SSL automáticamente** al detectar `*.rds.amazonaws.com` y NO verifica la CA (`rejectUnauthorized: false`) — suficiente para tráfico autenticado por security group. Si quieres verificación estricta, pon `DATABASE_SSL=verify` y mete el bundle de Amazon en el truststore del sistema.

Para que el cliente `mysql` de terminal conecte:
```bash
# Oracle MySQL client:
mysql -h ... -u admin -p --ssl-mode=REQUIRED
# MariaDB client:
mysql -h ... -u admin -p --ssl
```

**`pm2: command not found`**
pm2 está como devDependency del workspace pero **necesita estar también global**. Instálalo con:
```bash
sudo npm install -g pm2          # rápido en máquina personal
# o cambia el prefix de npm a ~/.npm-global para evitar sudo (ver README §"Antes de clonar el repo")
```

**`npm audit fix --force` destruyó mi instalación**
No lo uses NUNCA en este repo — fuerza versiones major incompatibles (vite 5→8, pm2 5→7, drizzle 0.36→0.45). Recuperación:
```bash
git checkout -- package.json package-lock.json 'apps/*/package.json' 'packages/*/package.json'
rm -rf node_modules apps/*/node_modules packages/*/node_modules
npm install
```
Las vulns de `npm audit` que reporta este repo (esbuild en drizzle-kit, ws en pm2) son **dev-only** — no afectan a runtime de producción.

**Mensaje partido en dos / texto enviado a medias antes de los saltos de línea**
Bug viejo: `\n` en el texto se interpretaba como Enter (= enviar en WA Channels). Resuelto con `typeMultiline` (Shift+Enter entre líneas). Si vuelve a pasar, asegúrate de tener `core` en versión ≥ 0.4.0 y reinicia el worker.

**Job marcado como `sent` pero el mensaje no llega a WhatsApp**
Pasa cuando el selector del botón Send es genérico y clica algo distinto al botón real. Desde 0.4.0 hay verificación post-envío: se exige que aparezca un indicador (`msg-time` / `msg-check`) en los 15s siguientes al click; si no, el job se marca `failed` con un screenshot en `debug/`. Si ves esto en una versión < 0.4.0, actualiza.

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
