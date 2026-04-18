# Tamaya

> Programador y publicador de mensajes (texto + media) para canales de WhatsApp. Automatiza WhatsApp Web con Playwright; cubre un hueco que las APIs oficiales no resuelven.

El nombre es un guiño a *atalaya* (torre de vigía desde la que se lanzan señales).

## ⚠️ Aviso

Tamaya automatiza WhatsApp Web. Esto **viola los Términos de Servicio de WhatsApp/Meta** y puede resultar en el ban de la cuenta. Úsalo bajo tu responsabilidad y **nunca con tu número personal**. Pensado para un número desechable dedicado.

---

## Arquitectura

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

- **Node.js ≥ 20**
- **Docker Desktop** (con `docker compose`)
- **macOS o Linux** (probado en macOS 14 / Darwin 25)
- **Instancia MySQL** accesible (AWS RDS recomendado — también vale local)
- **Un número de WhatsApp desechable** con un canal de prueba creado

---

## Instalación

### 1. Clonar y instalar dependencias

```bash
git clone https://github.com/FranParedesNavarrete/tamaya.git
cd tamaya
npm install
npx playwright install chromium   # solo para worker-publish
```

> El repo tiene `.npmrc` con `legacy-peer-deps=true` para resolver el conflicto de React 19 con algunas deps.

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env` y rellena al menos:

```bash
# RDS (o MySQL local)
DATABASE_URL=mysql://user:password@host:3306/tamaya

# S3 (solo si vas a resolver sources s3://... — opcional)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=eu-west-1

# El resto trae valores por defecto razonables
```

El directorio `TAMAYA_TMP_DIR=/tmp/tamaya-media` es **ruta absoluta compartida** entre el `worker-resolve` (Docker, bind-mount) y el `worker-publish` (nativo). No lo cambies a menos que sepas lo que haces.

### 3. Crear el esquema en la BD

Desde el host (usa `drizzle-kit push` contra `DATABASE_URL`):

```bash
npm run db:push -w @tamaya/db
```

Esto crea las tablas `jobs`, `channels`, `audit_log`.

### 4. Construir los paquetes compartidos

```bash
npm run build
```

### 5. Levantar el stack dockerizado

```bash
docker compose up -d --build
```

Esto arranca `redis`, `api`, `worker-resolve` (x3) y `web`.

Comprobación rápida:

```bash
docker compose ps                   # todos "running / healthy"
curl http://localhost:3001/health   # api
open http://localhost               # web
```

### 6. Login inicial de WhatsApp (una sola vez)

Abre Chromium en tu máquina para escanear el QR de WhatsApp Web. La sesión se persiste en `apps/worker-publish/sessions/default-profile/`.

```bash
npm run login
```

Escanea el QR con el móvil de la cuenta desechable. Cuando aparezca la lista de chats, cierra la ventana; la sesión queda guardada.

### 7. Arrancar el worker de publicación con pm2

```bash
cd apps/worker-publish
npm run pm2:start
pm2 logs tamaya-worker-publish   # ver en vivo
```

Para que arranque en cada reboot del host:

```bash
pm2 startup     # imprime un comando sudo — ejecútalo
pm2 save
```

---

## Uso

1. Abre http://localhost en el navegador.
2. Crea un canal en **Channels → Nuevo canal** (nombre = el que muestra WA Web, opcional acrónimo).
3. Ve a **Jobs → Nuevo**:
   - Selecciona el canal.
   - Escribe texto (se usa como caption si hay media).
   - Sube imágenes o vídeos (solo image/* y video/* — WA Channels no acepta documentos).
   - "Publicar ahora" o programa una fecha.
4. El job pasa por `pending → resolving → ready → publishing → sent` (o `failed`).
5. Desde la lista puedes **Reintentar** un job fallido (duplica con nueva fecha), **Cancelar** uno pendiente o **Borrar** uno terminado.

---

## Desarrollo

Modo dev (hot reload en api, web, worker-resolve) gracias al override:

```bash
docker compose up                   # sin -d, ves logs en vivo
```

El `worker-publish` se lanza fuera de Docker, en tsx watch:

```bash
cd apps/worker-publish
npm run dev
```

---

## Stack técnico

- **Backend:** TypeScript, Node 20, Fastify, BullMQ, Drizzle ORM, MySQL
- **Frontend:** React 19, Vite, TailwindCSS, shadcn-style UI
- **Browser automation:** Playwright (persistent context) contra WhatsApp Web
- **Media:** `@fastify/multipart` → tmp compartido → resolver (local/S3/HTTP)
- **Gestión de procesos:** Docker Compose + pm2 para el worker de browser

---

## Troubleshooting

**`DATABASE_URL not set` en worker-publish**
El worker-publish carga `.env` desde la raíz del repo. Asegúrate de que `/path/to/tamaya/.env` existe y contiene `DATABASE_URL`. Si ejecutas con pm2, el `cwd` es `apps/worker-publish`; el código resuelve `../../../.env`.

**`ENOENT /tmp/tamaya-media/...` en worker-publish**
El worker-resolve (Docker) escribió el archivo en un volumen que el worker-publish nativo no ve. Comprueba que `TAMAYA_TMP_DIR` es la **misma ruta absoluta** en `.env` y que el bind-mount de `docker-compose.yml` es `${TAMAYA_TMP_DIR}:${TAMAYA_TMP_DIR}`.

**El vídeo se envía sin caption / solo llega el texto**
El vídeo necesita tiempo para subir. El worker espera hasta ~3 min según tamaño. Revisa los logs de `pm2 logs tamaya-worker-publish` — busca `waiting for upload to complete`.

**"no session found — run npm run login first"**
La sesión no existe o caducó. Vuelve a ejecutar `npm run login` y escanea el QR.

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
