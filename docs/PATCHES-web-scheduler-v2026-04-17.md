# Tamaya — Parches web + scheduler + Docker (Opción B) v2026-04-17

Migración del PoC CLI actual a arquitectura híbrida: web stack dockerizado + worker publish nativo con pm2.

**Stack elegido**:
- Monorepo: npm workspaces
- DB: **MySQL 8** (contenedor) + **Drizzle ORM**
- Cola: **BullMQ** sobre **Redis** (contenedor)
- API: **Fastify** + Zod
- Frontend: **Vite + React + TailwindCSS + shadcn/ui**
- Worker publish: **nativo** (Playwright en el host) gestionado por **pm2**
- Worker resolve: **dockerizado**, N réplicas
- Sin reverse proxy — acceso por IP (DNS se asigna aparte en el server)

**Pre-requisitos instalados en host**:
- Node 20+
- Docker + Docker Compose v2
- pm2 global (`npm i -g pm2`)

**Archivos afectados**: TODO el repo (reestructura a monorepo). El código actual de `src/` pasa a `packages/core/src/`.

---

## Tabla de contenidos

1. [Parche W1 — Reestructura a monorepo npm workspaces](#w1)
2. [Parche W2 — Schema MySQL con Drizzle](#w2)
3. [Parche W3 — Media resolver (S3 / HTTP / file)](#w3)
4. [Parche W4 — Docker Compose base + override dev/prod](#w4)
5. [Parche W5 — API Fastify con rutas /jobs](#w5)
6. [Parche W6 — Integración BullMQ (colas resolve + publish)](#w6)
7. [Parche W7 — Worker resolve dockerizado](#w7)
8. [Parche W8 — Worker publish nativo con pm2](#w8)
9. [Parche W9 — Frontend Vite + React + Tailwind + shadcn](#w9)
10. [Parche W10 — Runbooks dev y prod](#w10)

---

<a id="w1"></a>
## Parche W1 — Reestructura a monorepo npm workspaces

### Estructura final

```
tamaya/
├── apps/
│   ├── api/                  # Fastify (dockerizado)
│   ├── web/                  # Vite+React (dockerizado)
│   ├── worker-publish/       # pm2 nativo
│   └── worker-resolve/       # dockerizado, replicable
├── packages/
│   ├── core/                 # publishText, publishMedia, browser/, dom-helpers
│   ├── db/                   # Drizzle schema + cliente
│   ├── media-resolver/       # s3://, https://, file://
│   └── shared-types/         # Zod schemas compartidos
├── docker-compose.yml
├── docker-compose.override.yml    # dev
├── docker-compose.prod.yml        # prod
├── .env.example
├── .dockerignore
└── package.json                   # workspaces
```

### Migración desde `src/` actual

```bash
# Desde la raíz del repo actual:
mkdir -p apps/api apps/web apps/worker-publish apps/worker-resolve
mkdir -p packages/core packages/db packages/media-resolver packages/shared-types

# Mover el código actual a packages/core
mv src packages/core/src
mv tsconfig.json packages/core/tsconfig.json
# El package.json actual se va a reescribir (abajo); guárdalo como referencia:
mv package.json packages/core/package.json.old
mv package-lock.json packages/core/package-lock.json.old
```

### Raíz `package.json`

```json
{
  "name": "tamaya-monorepo",
  "private": true,
  "version": "0.2.0-alpha.0",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build -ws --if-present",
    "dev:api": "npm run dev -w apps/api",
    "dev:web": "npm run dev -w apps/web",
    "dev:worker-publish": "npm run dev -w apps/worker-publish",
    "dev:worker-resolve": "npm run dev -w apps/worker-resolve",
    "login": "npm run login -w apps/worker-publish",
    "stack:up": "docker compose up -d",
    "stack:down": "docker compose down",
    "stack:logs": "docker compose logs -f"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "tsx": "^4.19.0",
    "@types/node": "^20.14.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

### `packages/core/package.json` (reescrito)

```json
{
  "name": "@tamaya/core",
  "version": "0.2.0-alpha.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./publisher/*": "./dist/publisher/*.js",
    "./browser/*": "./dist/browser/*.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "pino": "^9.5.0",
    "playwright": "^1.49.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.3"
  }
}
```

### `packages/core/src/index.ts` (nuevo — barrel)

```typescript
export { publishText } from './publisher/publish-text.js';
export { publishMedia } from './publisher/publish-media.js';
export { launchPersistentContextForTenant, sessionExists } from './browser/session.js';
export type { PublishTextInput, PublishResult } from './publisher/publish-text.js';
export type { PublishMediaInput } from './publisher/publish-media.js';
```

### `.dockerignore` (raíz)

```
node_modules
**/node_modules
**/dist
**/.turbo
**/coverage
.env
.env.*
!.env.example
.git
sessions
debug
tmp
*.log
.DS_Store
```

### Verificación

```bash
npm install          # instala con workspaces
npm run build        # compila todos los packages
```

---

<a id="w2"></a>
## Parche W2 — Schema MySQL con Drizzle

### `packages/db/package.json`

```json
{
  "name": "@tamaya/db",
  "version": "0.2.0-alpha.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./schema": "./dist/schema.js",
    "./client": "./dist/client.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "db:push": "drizzle-kit push",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "drizzle-orm": "^0.36.0",
    "mysql2": "^3.11.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.28.0",
    "typescript": "^5.6.3"
  }
}
```

### `packages/db/drizzle.config.ts`

```typescript
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'mysql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'mysql://tamaya:tamaya@localhost:3306/tamaya',
  },
} satisfies Config;
```

### `packages/db/src/schema.ts`

```typescript
import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  int,
  json,
  mysqlEnum,
  index,
} from 'drizzle-orm/mysql-core';

// ---------- channels ----------
export const channels = mysqlTable('channels', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  inviteLink: varchar('invite_link', { length: 512 }),
  whatsappId: varchar('whatsapp_id', { length: 128 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  tenantNameIdx: index('tenant_name_idx').on(t.tenantId, t.name),
}));

// ---------- jobs ----------
// Un job = una publicación programada (con o sin media, con o sin caption)
export const jobs = mysqlTable('jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),
  channelId: varchar('channel_id', { length: 36 }).notNull(),
  channelName: varchar('channel_name', { length: 255 }).notNull(),

  text: text('text'),                                  // caption o mensaje de texto
  media: json('media').$type<JobMedia[]>(),            // array de adjuntos (ver tipo abajo)

  scheduledAt: timestamp('scheduled_at').notNull(),
  status: mysqlEnum('status', [
    'pending', 'resolving', 'ready', 'publishing', 'sent', 'failed', 'cancelled',
  ]).notNull().default('pending'),

  attemptCount: int('attempt_count').notNull().default(0),
  maxAttempts: int('max_attempts').notNull().default(3),

  lastError: text('last_error'),
  durationMs: int('duration_ms'),
  sentAt: timestamp('sent_at'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  statusSchedIdx: index('status_sched_idx').on(t.status, t.scheduledAt),
  tenantStatusIdx: index('tenant_status_idx').on(t.tenantId, t.status),
}));

// Tipo del campo JSON `media`
export type JobMedia = {
  source: string;          // "s3://bucket/key" | "https://..." | "file:///path" | "/abs/path"
  caption?: string;        // opcional — caption por archivo
  localPath?: string;      // rellenado por resolve-worker tras descarga
  mime?: string;           // detectado por resolve-worker
  sizeBytes?: number;
};

// ---------- audit_log ----------
export const auditLog = mysqlTable('audit_log', {
  id: int('id').primaryKey().autoincrement(),
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),
  actor: varchar('actor', { length: 64 }).notNull(),      // 'user' | 'system' | 'worker'
  action: varchar('action', { length: 128 }).notNull(),
  targetId: varchar('target_id', { length: 64 }),         // id de job/channel/...
  meta: json('meta'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  tenantCreatedIdx: index('tenant_created_idx').on(t.tenantId, t.createdAt),
}));
```

### `packages/db/src/client.ts`

```typescript
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';

let _pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    _pool = mysql.createPool({
      uri: url,
      connectionLimit: 10,
      enableKeepAlive: true,
    });
  }
  return _pool;
}

export function getDb() {
  return drizzle(getPool(), { schema, mode: 'default' });
}

export { schema };
```

### `packages/db/src/index.ts`

```typescript
export * from './client.js';
export * as schema from './schema.js';
export type { JobMedia } from './schema.js';
```

### Crear DB y aplicar schema

```bash
# Tras levantar el contenedor de MySQL (ver W4):
cd packages/db
DATABASE_URL="mysql://tamaya:tamaya@localhost:3306/tamaya" npm run db:push
```

`db:push` aplica el schema directamente (útil en dev). Para migrations versionadas usa `db:generate` + `db:migrate`.

---

<a id="w3"></a>
## Parche W3 — Media resolver (S3 / HTTP / file)

### `packages/media-resolver/package.json`

```json
{
  "name": "@tamaya/media-resolver",
  "version": "0.2.0-alpha.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.670.0",
    "pino": "^9.5.0"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "@types/node": "^20.14.0"
  }
}
```

### `packages/media-resolver/src/index.ts`

```typescript
import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

export interface ResolvedMedia {
  localPath: string;
  mime?: string;
  sizeBytes: number;
  originalSource: string;
}

export interface ResolverOptions {
  /** Directorio donde se escriben las descargas. Ej: /data/tmp */
  tmpDir: string;
  /** Timeout por descarga en ms. Default: 120s */
  downloadTimeoutMs?: number;
  /** Tamaño máximo permitido en bytes. Default: 100 MB (límite práctico de WA) */
  maxSizeBytes?: number;
}

export class MediaResolver {
  private s3: S3Client | null = null;

  constructor(private readonly opts: ResolverOptions) {}

  private getS3(): S3Client {
    if (!this.s3) {
      this.s3 = new S3Client({
        region: process.env.AWS_REGION ?? 'eu-west-1',
        // Credenciales las toma del entorno (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
      });
    }
    return this.s3;
  }

  async resolve(source: string): Promise<ResolvedMedia> {
    // Ruta local absoluta
    if (source.startsWith('/') || source.startsWith('file://')) {
      return this.resolveLocal(source.replace(/^file:\/\//, ''));
    }

    if (source.startsWith('s3://')) {
      return this.resolveS3(source);
    }

    if (source.startsWith('http://') || source.startsWith('https://')) {
      return this.resolveHttp(source);
    }

    throw new Error(`Unsupported media source scheme: ${source}`);
  }

  private async resolveLocal(path: string): Promise<ResolvedMedia> {
    const st = await stat(path);
    this.assertSize(st.size, path);
    return {
      localPath: path,
      sizeBytes: st.size,
      originalSource: path,
    };
  }

  private async resolveS3(source: string): Promise<ResolvedMedia> {
    // s3://bucket/key/with/slashes.ext
    const m = source.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!m) throw new Error(`invalid s3 uri: ${source}`);
    const [, bucket, key] = m;

    const target = this.targetPathFor(source, extname(key));
    await mkdir(dirname(target), { recursive: true });

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const resp = await this.getS3().send(cmd);
    if (!resp.Body) throw new Error(`empty S3 body: ${source}`);

    await pipeline(resp.Body as Readable, createWriteStream(target));
    const st = await stat(target);
    this.assertSize(st.size, source);

    return {
      localPath: target,
      mime: resp.ContentType,
      sizeBytes: st.size,
      originalSource: source,
    };
  }

  private async resolveHttp(url: string): Promise<ResolvedMedia> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.downloadTimeoutMs ?? 120_000);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${url}`);
      }

      // Intentar extraer la extensión del URL o del Content-Type
      const urlExt = extname(new URL(url).pathname);
      const target = this.targetPathFor(url, urlExt || '.bin');
      await mkdir(dirname(target), { recursive: true });

      const buf = Buffer.from(await resp.arrayBuffer());
      this.assertSize(buf.byteLength, url);
      await writeFile(target, buf);

      return {
        localPath: target,
        mime: resp.headers.get('content-type') ?? undefined,
        sizeBytes: buf.byteLength,
        originalSource: url,
      };
    } finally {
      clearTimeout(t);
    }
  }

  private targetPathFor(source: string, ext: string): string {
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    const safeExt = ext.match(/^\.[A-Za-z0-9]+$/) ? ext : '.bin';
    return join(this.opts.tmpDir, `${hash}${safeExt}`);
  }

  private assertSize(size: number, source: string): void {
    const max = this.opts.maxSizeBytes ?? 100 * 1024 * 1024;
    if (size > max) {
      throw new Error(
        `media exceeds max size: ${size} > ${max} bytes (source=${source})`,
      );
    }
  }
}
```

---

<a id="w4"></a>
## Parche W4 — Docker Compose base + overrides

### `.env.example`

```bash
# ---------- MySQL ----------
MYSQL_ROOT_PASSWORD=changeme_root_pw
MYSQL_USER=tamaya
MYSQL_PASSWORD=changeme_user_pw
MYSQL_DB=tamaya
DATABASE_URL=mysql://tamaya:changeme_user_pw@localhost:3306/tamaya

# ---------- Redis ----------
REDIS_URL=redis://localhost:6379

# ---------- AWS S3 (para worker-resolve) ----------
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=eu-west-1

# ---------- API ----------
API_PORT=3001
API_CORS_ORIGIN=http://localhost:5173,http://localhost

# ---------- Tamaya core (worker-publish) ----------
TAMAYA_TENANT_ID=default
TAMAYA_USER_DATA_DIR=./sessions/default-profile
TAMAYA_HEADLESS=false
TAMAYA_SLOWMO_MS=100
TAMAYA_USER_AGENT=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
TAMAYA_VIEWPORT_WIDTH=1440
TAMAYA_VIEWPORT_HEIGHT=900
TAMAYA_TIMEZONE=Europe/Madrid
TAMAYA_LOCALE=es-ES

# ---------- Worker tmp dir ----------
TAMAYA_TMP_DIR=./tmp/tamaya

# ---------- Logging ----------
LOG_LEVEL=info
```

### `docker-compose.yml` (base, prod-ready)

```yaml
services:
  mysql:
    image: mysql:8.0
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: ${MYSQL_DB}
      MYSQL_USER: ${MYSQL_USER}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    command:
      - --default-authentication-plugin=caching_sha2_password
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
    ports:
      - "3306:3306"
    volumes:
      - tamaya-mysql:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - tamaya-redis:/data
    command: ["redis-server", "--appendonly", "yes"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 10

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    restart: unless-stopped
    environment:
      DATABASE_URL: mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@mysql:3306/${MYSQL_DB}
      REDIS_URL: redis://redis:6379
      API_PORT: ${API_PORT}
      API_CORS_ORIGIN: ${API_CORS_ORIGIN}
      LOG_LEVEL: ${LOG_LEVEL}
    ports:
      - "${API_PORT}:${API_PORT}"
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy

  worker-resolve:
    build:
      context: .
      dockerfile: apps/worker-resolve/Dockerfile
    restart: unless-stopped
    environment:
      DATABASE_URL: mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@mysql:3306/${MYSQL_DB}
      REDIS_URL: redis://redis:6379
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      AWS_REGION: ${AWS_REGION}
      TAMAYA_TMP_DIR: /data/tmp
      LOG_LEVEL: ${LOG_LEVEL}
    volumes:
      - tamaya-tmp:/data/tmp
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy
    deploy:
      replicas: 3

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      args:
        VITE_API_BASE_URL: "http://localhost:${API_PORT}"
    restart: unless-stopped
    ports:
      - "80:80"
    depends_on:
      - api

volumes:
  tamaya-mysql:
  tamaya-redis:
  tamaya-tmp:
```

### `docker-compose.override.yml` (dev — hot reload)

```yaml
services:
  api:
    build:
      target: dev
    command: npm run dev -w apps/api
    volumes:
      - ./apps/api:/app/apps/api
      - ./packages:/app/packages
      - /app/node_modules
    environment:
      LOG_LEVEL: debug

  worker-resolve:
    build:
      target: dev
    command: npm run dev -w apps/worker-resolve
    volumes:
      - ./apps/worker-resolve:/app/apps/worker-resolve
      - ./packages:/app/packages
      - /app/node_modules

  web:
    build:
      target: dev
    command: npm run dev -w apps/web -- --host 0.0.0.0
    ports:
      - "5173:5173"
    volumes:
      - ./apps/web:/app/apps/web
      - /app/node_modules
```

### `docker-compose.prod.yml` (prod — overrides)

```yaml
services:
  mysql:
    ports:
      - "127.0.0.1:3306:3306"   # solo accesible desde el host, no desde la LAN

  redis:
    ports:
      - "127.0.0.1:6379:6379"

  api:
    environment:
      LOG_LEVEL: info

  web:
    # En prod quita el build stage "dev", usa imagen final de nginx
    build:
      target: runtime

  # No exponer ports al exterior (redis/mysql solo localhost)
  # Si necesitas que otro host de tu LAN acceda, cambia a 0.0.0.0 y usa firewall
```

### Comandos

```bash
# Dev (Mac)
cp .env.example .env && vim .env
docker compose up -d mysql redis          # solo BD y cola primero
cd packages/db && npm run db:push && cd ../..
docker compose up -d                      # levanta api + web + worker-resolve

# Prod (servidor Linux)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

<a id="w5"></a>
## Parche W5 — API Fastify

### `apps/api/package.json`

```json
{
  "name": "@tamaya/api",
  "version": "0.2.0-alpha.0",
  "type": "module",
  "main": "./dist/server.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@tamaya/db": "*",
    "@tamaya/shared-types": "*",
    "@fastify/cors": "^10.0.1",
    "bullmq": "^5.25.6",
    "fastify": "^5.1.0",
    "fastify-type-provider-zod": "^4.0.2",
    "ioredis": "^5.4.1",
    "pino": "^9.5.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.3",
    "@types/node": "^20.14.0"
  }
}
```

### `packages/shared-types/src/job.ts`

```typescript
import { z } from 'zod';

export const MediaSourceSchema = z.object({
  source: z.string().min(1),
  caption: z.string().optional(),
});

export const CreateJobSchema = z.object({
  channel: z.string().min(1),
  text: z.string().optional(),
  media: z.array(MediaSourceSchema).default([]),
  scheduledAt: z.string().datetime(),    // ISO 8601 con timezone
}).refine(
  (d) => (d.text && d.text.length > 0) || d.media.length > 0,
  { message: 'At least one of text or media is required' },
);

export const JobStatusSchema = z.enum([
  'pending', 'resolving', 'ready', 'publishing', 'sent', 'failed', 'cancelled',
]);

export const JobSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  channelId: z.string().uuid(),
  channelName: z.string(),
  text: z.string().nullable(),
  media: z.array(MediaSourceSchema),
  scheduledAt: z.string().datetime(),
  status: JobStatusSchema,
  attemptCount: z.number().int(),
  maxAttempts: z.number().int(),
  lastError: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  sentAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type CreateJobInput = z.infer<typeof CreateJobSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
```

### `apps/api/src/server.ts`

```typescript
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { jobsRoutes } from './routes/jobs.js';
import { channelsRoutes } from './routes/channels.js';
import { closeQueue } from './queue/bullmq.js';

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: (process.env.API_CORS_ORIGIN ?? 'http://localhost:5173').split(','),
  });

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(jobsRoutes, { prefix: '/jobs' });
  await app.register(channelsRoutes, { prefix: '/channels' });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });

  const shutdown = async () => {
    app.log.info('shutting down');
    await closeQueue();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### `apps/api/src/routes/jobs.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { eq, desc, and, isNull } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import { CreateJobSchema, JobSchema } from '@tamaya/shared-types';
import { enqueueResolve } from '../queue/bullmq.js';

export async function jobsRoutes(app: FastifyInstance) {
  const a = app.withTypeProvider<ZodTypeProvider>();
  const db = getDb();

  // POST /jobs — crear nuevo job programado
  a.post('/', {
    schema: {
      body: CreateJobSchema,
    },
  }, async (req) => {
    const input = req.body;
    const tenantId = 'default'; // ajusta cuando añadas auth/multitenancy

    // Upsert del canal por nombre
    const existing = await db.select().from(schema.channels)
      .where(and(
        eq(schema.channels.tenantId, tenantId),
        eq(schema.channels.name, input.channel),
      ))
      .limit(1);

    let channelId: string;
    if (existing.length > 0) {
      channelId = existing[0].id;
    } else {
      channelId = randomUUID();
      await db.insert(schema.channels).values({
        id: channelId,
        tenantId,
        name: input.channel,
      });
    }

    const jobId = randomUUID();
    const scheduledAt = new Date(input.scheduledAt);

    await db.insert(schema.jobs).values({
      id: jobId,
      tenantId,
      channelId,
      channelName: input.channel,
      text: input.text ?? null,
      media: input.media,
      scheduledAt,
      status: 'pending',
    });

    await enqueueResolve({
      jobId,
      scheduledAt: scheduledAt.toISOString(),
    });

    req.log.info({ jobId, scheduledAt: input.scheduledAt }, 'job created and enqueued');
    return { id: jobId, status: 'pending' };
  });

  // GET /jobs — listar con filtros
  a.get('/', {
    schema: {
      querystring: z.object({
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    },
  }, async (req) => {
    const { status, limit } = req.query;
    const tenantId = 'default';

    const rows = await db.select().from(schema.jobs)
      .where(
        status
          ? and(eq(schema.jobs.tenantId, tenantId), eq(schema.jobs.status, status as any))
          : eq(schema.jobs.tenantId, tenantId)
      )
      .orderBy(desc(schema.jobs.scheduledAt))
      .limit(limit);

    return rows;
  });

  // GET /jobs/:id
  a.get('/:id', {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, req.params.id))
      .limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  // DELETE /jobs/:id — solo si está pending/failed/cancelled
  a.delete('/:id', {
    schema: {
      params: z.object({ id: z.string().uuid() }),
    },
  }, async (req, reply) => {
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, req.params.id)).limit(1);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    if (['publishing', 'resolving'].includes(rows[0].status)) {
      return reply.code(409).send({ error: 'cannot cancel job in progress' });
    }
    await db.update(schema.jobs).set({ status: 'cancelled' })
      .where(eq(schema.jobs.id, req.params.id));
    return { id: req.params.id, status: 'cancelled' };
  });
}
```

### `apps/api/src/routes/channels.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';

export async function channelsRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/', async () => {
    return db.select().from(schema.channels)
      .where(eq(schema.channels.tenantId, 'default'));
  });
}
```

### `apps/api/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7

# --- dev stage (con hot reload) ---
FROM node:20-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages ./packages/
COPY apps/api ./apps/api/
RUN npm ci
EXPOSE 3001
CMD ["npm", "run", "dev", "-w", "apps/api"]

# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages ./packages/
RUN npm ci
COPY apps/api ./apps/api/
RUN npm run build -w packages/db
RUN npm run build -w packages/shared-types
RUN npm run build -w apps/api

# --- runtime ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/packages ./packages/
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3001
USER node
CMD ["node", "apps/api/dist/server.js"]
```

---

<a id="w6"></a>
## Parche W6 — Integración BullMQ

### `apps/api/src/queue/bullmq.ts`

```typescript
import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const resolveQueue = new Queue('resolve-queue', { connection });
export const publishQueue = new Queue('publish-queue', { connection });

export interface ResolveJobData {
  jobId: string;
  scheduledAt: string;   // ISO
}

export interface PublishJobData {
  jobId: string;
}

/**
 * Encola un job a la cola "resolve" con delay según scheduledAt.
 * BullMQ maneja el delay internamente (jobs se inactivan hasta que toca).
 */
export async function enqueueResolve(data: ResolveJobData): Promise<void> {
  const delay = Math.max(0, new Date(data.scheduledAt).getTime() - Date.now());

  await resolveQueue.add('resolve', data, {
    jobId: data.jobId,   // idempotencia
    delay,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 30_000,
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
}

export async function enqueuePublish(data: PublishJobData): Promise<void> {
  await publishQueue.add('publish', data, {
    jobId: data.jobId,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60_000,
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
}

export async function closeQueue(): Promise<void> {
  await Promise.all([
    resolveQueue.close(),
    publishQueue.close(),
    connection.quit(),
  ]);
}
```

**Notas clave**:
- `jobId: data.jobId` hace que BullMQ rechace duplicados (idempotente si el user pulsa "crear" dos veces)
- `delay` es el tiempo hasta que el job entra a la cola activa (precisión ~1s)
- `attempts: 3` con backoff exponencial — si falla se reintenta 3 veces

---

<a id="w7"></a>
## Parche W7 — Worker resolve dockerizado

### `apps/worker-resolve/package.json`

```json
{
  "name": "@tamaya/worker-resolve",
  "version": "0.2.0-alpha.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@tamaya/db": "*",
    "@tamaya/media-resolver": "*",
    "@tamaya/shared-types": "*",
    "bullmq": "^5.25.6",
    "ioredis": "^5.4.1",
    "pino": "^9.5.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.3"
  }
}
```

### `apps/worker-resolve/src/index.ts`

```typescript
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import { MediaResolver } from '@tamaya/media-resolver';
import type { JobMedia } from '@tamaya/db';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://redis:6379', {
  maxRetriesPerRequest: null,
});
const db = getDb();
const resolver = new MediaResolver({
  tmpDir: process.env.TAMAYA_TMP_DIR ?? '/data/tmp',
});

const worker = new Worker(
  'resolve-queue',
  async (job) => {
    const { jobId } = job.data as { jobId: string };
    logger.info({ jobId, attempt: job.attemptsMade + 1 }, 'resolve start');

    // Actualizar estado
    await db.update(schema.jobs)
      .set({ status: 'resolving', attemptCount: job.attemptsMade + 1 })
      .where(eq(schema.jobs.id, jobId));

    // Leer media[] del job
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, jobId)).limit(1);
    if (rows.length === 0) throw new Error(`job ${jobId} not found`);
    const row = rows[0];
    const mediaList = (row.media ?? []) as JobMedia[];

    // Si el job fue cancelado mientras tanto, abortar
    if (row.status === 'cancelled') {
      logger.warn({ jobId }, 'job cancelled, skipping');
      return { skipped: true };
    }

    // Resolver cada media (si no hay, es text-only y saltamos directo a publish)
    const resolved: JobMedia[] = [];
    for (const m of mediaList) {
      if (m.localPath) {
        // ya resuelto en un intento previo — reutilizamos
        resolved.push(m);
        continue;
      }
      const r = await resolver.resolve(m.source);
      resolved.push({
        ...m,
        localPath: r.localPath,
        mime: r.mime,
        sizeBytes: r.sizeBytes,
      });
      logger.info({ jobId, source: m.source, localPath: r.localPath }, 'media resolved');
    }

    // Persistir media resuelta y marcar ready
    await db.update(schema.jobs)
      .set({ media: resolved, status: 'ready' })
      .where(eq(schema.jobs.id, jobId));

    // Encolar en publish-queue
    const { enqueuePublish } = await import('./enqueue-publish.js');
    await enqueuePublish({ jobId });
    logger.info({ jobId }, 'resolve done, enqueued to publish-queue');

    return { ok: true };
  },
  { connection, concurrency: 5 },
);

worker.on('failed', async (job, err) => {
  if (!job) return;
  logger.error({ jobId: job.id, err: err.message }, 'resolve failed');
  if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
    await db.update(schema.jobs)
      .set({ status: 'failed', lastError: `resolve: ${err.message}` })
      .where(eq(schema.jobs.id, job.id!));
  }
});

logger.info('worker-resolve started');
```

### `apps/worker-resolve/src/enqueue-publish.ts`

```typescript
// Duplicamos la lógica de encolado (o extráela a @tamaya/queue como package compartido)
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://redis:6379', {
  maxRetriesPerRequest: null,
});
const publishQueue = new Queue('publish-queue', { connection });

export async function enqueuePublish(data: { jobId: string }): Promise<void> {
  await publishQueue.add('publish', data, {
    jobId: data.jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
}
```

**Mejor refactor**: extrae `apps/api/src/queue/bullmq.ts` a un package `@tamaya/queue` que compartan api + worker-resolve. Lo dejo como deuda técnica — la duplicación actual es <30 líneas.

### `apps/worker-resolve/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/worker-resolve/package.json apps/worker-resolve/
COPY packages ./packages/
COPY apps/worker-resolve ./apps/worker-resolve/
RUN npm ci
CMD ["npm", "run", "dev", "-w", "apps/worker-resolve"]

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/worker-resolve/package.json apps/worker-resolve/
COPY packages ./packages/
RUN npm ci
COPY apps/worker-resolve ./apps/worker-resolve/
RUN npm run build -w packages/db
RUN npm run build -w packages/media-resolver
RUN npm run build -w packages/shared-types
RUN npm run build -w apps/worker-resolve

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/worker-resolve/dist ./apps/worker-resolve/dist
COPY --from=build /app/apps/worker-resolve/package.json ./apps/worker-resolve/
COPY --from=build /app/packages ./packages/
COPY --from=build /app/node_modules ./node_modules
USER node
CMD ["node", "apps/worker-resolve/dist/index.js"]
```

---

<a id="w8"></a>
## Parche W8 — Worker publish nativo con pm2

### `apps/worker-publish/package.json`

```json
{
  "name": "@tamaya/worker-publish",
  "version": "0.2.0-alpha.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "login": "tsx src/login.ts",
    "pm2:start": "pm2 start ecosystem.config.cjs",
    "pm2:stop": "pm2 stop tamaya-worker-publish",
    "pm2:logs": "pm2 logs tamaya-worker-publish",
    "pm2:restart": "pm2 restart tamaya-worker-publish"
  },
  "dependencies": {
    "@tamaya/core": "*",
    "@tamaya/db": "*",
    "@tamaya/shared-types": "*",
    "bullmq": "^5.25.6",
    "ioredis": "^5.4.1",
    "pino": "^9.5.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.3",
    "pm2": "^5.4.0"
  }
}
```

### `apps/worker-publish/ecosystem.config.cjs`

```javascript
// pm2 ecosystem — gestiona el proceso del worker publish en el host
// https://pm2.keymetrics.io/docs/usage/application-declaration/
module.exports = {
  apps: [
    {
      name: 'tamaya-worker-publish',
      script: 'dist/index.js',
      cwd: __dirname,
      exec_mode: 'fork',        // NO cluster — Chromium no tolera multi-fork
      instances: 1,             // 1 por cuenta WA
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        // El resto vive en .env del repo raíz — pm2 los carga con --update-env
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/out.log',
      error_file: './logs/err.log',
      merge_logs: true,
    },
  ],
};
```

### `apps/worker-publish/src/index.ts`

```typescript
import 'dotenv/config';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import type { JobMedia } from '@tamaya/db';
import { publishText, publishMedia } from '@tamaya/core';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
const db = getDb();

const worker = new Worker(
  'publish-queue',
  async (job) => {
    const { jobId } = job.data as { jobId: string };
    logger.info({ jobId, attempt: job.attemptsMade + 1 }, 'publish start');

    // Cargar job de la DB
    const rows = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, jobId)).limit(1);
    if (rows.length === 0) throw new Error(`job ${jobId} not found`);
    const row = rows[0];

    if (row.status === 'cancelled') {
      logger.warn({ jobId }, 'job cancelled, skipping');
      return { skipped: true };
    }

    await db.update(schema.jobs)
      .set({ status: 'publishing', attemptCount: job.attemptsMade + 1 })
      .where(eq(schema.jobs.id, jobId));

    const started = Date.now();
    const media = (row.media ?? []) as JobMedia[];
    const resolvedMedia = media.filter((m) => m.localPath);

    try {
      let result;
      if (resolvedMedia.length === 0) {
        // text-only
        if (!row.text || row.text.length === 0) {
          throw new Error('job has no text and no media');
        }
        result = await publishText({
          channelIdentifier: { name: row.channelName },
          body: row.text,
        });
      } else {
        // media (uno o varios — si tu publishMedia acepta múltiples, úsalo;
        // si no, itera por archivo — WA permite captionear cada uno por separado)
        result = await publishMedia({
          channelIdentifier: { name: row.channelName },
          mediaPath: resolvedMedia[0].localPath!,
          caption: row.text ?? resolvedMedia[0].caption,
        });
        // TODO: multi-archivo → iterar aquí cuando amplíes publishMedia
      }

      if (!result.success) {
        throw new Error(result.error ?? 'unknown publish failure');
      }

      await db.update(schema.jobs).set({
        status: 'sent',
        sentAt: new Date(),
        durationMs: Date.now() - started,
        lastError: null,
      }).where(eq(schema.jobs.id, jobId));

      logger.info({ jobId, durationMs: result.durationMs }, 'publish success');
      return { ok: true, messageId: result.messageId };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ jobId, err: errMsg }, 'publish failed');
      throw err;   // BullMQ reintentará según attempts
    }
  },
  {
    connection,
    concurrency: 1,   // NUNCA >1 — una cuenta WA = una sesión
  },
);

worker.on('failed', async (job, err) => {
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 3);
  if (exhausted) {
    await db.update(schema.jobs).set({
      status: 'failed',
      lastError: err.message,
    }).where(eq(schema.jobs.id, job.id!));
  }
});

logger.info('worker-publish started');

const shutdown = async () => {
  logger.info('shutting down worker-publish');
  await worker.close();
  await connection.quit();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

### `apps/worker-publish/src/login.ts`

```typescript
import 'dotenv/config';
import { launchPersistentContextForTenant } from '@tamaya/core';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

async function main() {
  logger.info('opening persistent context for login');
  const context = await launchPersistentContextForTenant();
  const page = context.pages()[0] ?? (await context.newPage());

  logger.info('navigating to WhatsApp Web — scan the QR on screen');
  await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

  // Esperar a que aparezca la UI de app (marcador #pane-side)
  await page.waitForSelector('#pane-side', { timeout: 5 * 60 * 1000 });
  logger.info('login detected — session persisted in userDataDir');
  await context.close();
}

main().catch((err) => {
  logger.error({ err }, 'login failed');
  process.exit(1);
});
```

### Arranque

```bash
# Primera vez (login manual, ves el QR en Chrome de tu Mac)
cd apps/worker-publish
npm run login                      # escaneas QR

# Arranca el worker con pm2
npm run build -w apps/worker-publish
npm run pm2:start

# Ver logs
npm run pm2:logs

# Que se ejecute al reiniciar
pm2 startup
pm2 save
```

**En servidor Linux** (sin display): necesitas xvfb para que Chromium no headless funcione, o poner `TAMAYA_HEADLESS=true` en `.env`. Para el primer login en server, recomiendo usar estrategia B (extraer QR a stdout) — te la detallo si te hace falta.

---

<a id="w9"></a>
## Parche W9 — Frontend Vite + React + Tailwind + shadcn

### `apps/web/package.json`

```json
{
  "name": "@tamaya/web",
  "version": "0.2.0-alpha.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tamaya/shared-types": "*",
    "@radix-ui/react-dialog": "^1.1.2",
    "@radix-ui/react-label": "^2.1.0",
    "@radix-ui/react-slot": "^1.1.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "date-fns": "^4.1.0",
    "lucide-react": "^0.453.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.27.0",
    "tailwind-merge": "^2.5.4",
    "tailwindcss-animate": "^1.0.7"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3",
    "vite": "^5.4.10"
  }
}
```

### Setup shadcn/ui (resumido)

```bash
cd apps/web
npx shadcn@latest init        # sigue el wizard (TypeScript, src/, default)
npx shadcn@latest add button input label card table toast form dialog textarea calendar select
```

Esto crea `src/components/ui/` con los componentes. No los pego aquí por longitud.

### `apps/web/src/api/client.ts`

```typescript
import type { CreateJobInput, Job } from '@tamaya/shared-types';

const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}: ${body}`);
  }
  return r.json();
}

export const api = {
  createJob: (input: CreateJobInput) =>
    req<{ id: string; status: string }>('/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listJobs: (status?: string) =>
    req<Job[]>(`/jobs${status ? `?status=${status}` : ''}`),
  getJob: (id: string) => req<Job>(`/jobs/${id}`),
  cancelJob: (id: string) => req<Job>(`/jobs/${id}`, { method: 'DELETE' }),
  listChannels: () => req<{ id: string; name: string }[]>('/channels'),
};
```

### `apps/web/src/pages/JobsList.tsx`

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Job } from '@tamaya/shared-types';
import { Button } from '../components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table';
import { format } from 'date-fns';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-gray-200',
  resolving: 'bg-blue-100',
  ready: 'bg-indigo-100',
  publishing: 'bg-yellow-100',
  sent: 'bg-green-100',
  failed: 'bg-red-100',
  cancelled: 'bg-gray-400',
};

export function JobsList() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setJobs(await api.listJobs());
    setLoading(false);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Jobs</h1>
        <Button asChild><Link to="/new">+ Nuevo</Link></Button>
      </div>
      {loading ? <p>Cargando…</p> : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Canal</TableHead>
              <TableHead>Texto</TableHead>
              <TableHead>Media</TableHead>
              <TableHead>Programado</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <TableRow key={j.id}>
                <TableCell>{j.channelName}</TableCell>
                <TableCell className="max-w-xs truncate">{j.text}</TableCell>
                <TableCell>{j.media.length}</TableCell>
                <TableCell>{format(new Date(j.scheduledAt), 'dd/MM HH:mm')}</TableCell>
                <TableCell>
                  <span className={`px-2 py-1 rounded text-sm ${STATUS_COLORS[j.status]}`}>
                    {j.status}
                  </span>
                </TableCell>
                <TableCell className="max-w-xs truncate text-red-600">
                  {j.lastError}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

### `apps/web/src/pages/NewJob.tsx`

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';

interface MediaRow {
  source: string;
  caption?: string;
}

export function NewJob() {
  const nav = useNavigate();
  const [channel, setChannel] = useState('');
  const [text, setText] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      await api.createJob({
        channel,
        text: text || undefined,
        media: media.filter(m => m.source),
        scheduledAt: new Date(scheduledAt).toISOString(),
      });
      nav('/');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="p-6 max-w-2xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold">Nuevo job</h1>

      <div>
        <Label>Canal</Label>
        <Input value={channel} onChange={e => setChannel(e.target.value)} required />
      </div>

      <div>
        <Label>Texto (o caption si hay media)</Label>
        <Textarea value={text} onChange={e => setText(e.target.value)} rows={4} />
      </div>

      <div>
        <Label>Fecha/hora programada</Label>
        <Input type="datetime-local" value={scheduledAt}
               onChange={e => setScheduledAt(e.target.value)} required />
      </div>

      <div>
        <Label>Media (s3://, https://, /abs/path)</Label>
        {media.map((m, i) => (
          <div key={i} className="flex gap-2 mt-2">
            <Input value={m.source}
                   onChange={e => {
                     const next = [...media];
                     next[i] = { ...next[i], source: e.target.value };
                     setMedia(next);
                   }}
                   placeholder="s3://bucket/key.jpg" />
            <Button type="button" variant="outline"
                    onClick={() => setMedia(media.filter((_, j) => j !== i))}>
              Quitar
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" className="mt-2"
                onClick={() => setMedia([...media, { source: '' }])}>
          + Añadir media
        </Button>
      </div>

      {err && <p className="text-red-600">{err}</p>}
      <Button type="submit" disabled={submitting}>
        {submitting ? 'Creando…' : 'Crear job'}
      </Button>
    </form>
  );
}
```

### `apps/web/src/App.tsx`

```tsx
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { JobsList } from './pages/JobsList';
import { NewJob } from './pages/NewJob';

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-white shadow px-6 py-3 flex justify-between">
          <Link to="/" className="font-bold text-xl">Tamaya</Link>
          <Link to="/" className="text-gray-600 hover:text-black">Jobs</Link>
        </nav>
        <Routes>
          <Route path="/" element={<JobsList />} />
          <Route path="/new" element={<NewJob />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
```

### `apps/web/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages ./packages/
COPY apps/web ./apps/web/
RUN npm ci
EXPOSE 5173
CMD ["npm", "run", "dev", "-w", "apps/web", "--", "--host", "0.0.0.0"]

FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages ./packages/
RUN npm ci
COPY apps/web ./apps/web/
RUN npm run build -w apps/web

FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### `apps/web/nginx.conf`

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  # SPA — todas las rutas caen a index.html
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Cache estático
  location ~* \.(js|css|png|jpg|jpeg|svg|ico)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
```

---

<a id="w10"></a>
## Parche W10 — Runbooks

### Dev (tu Mac)

```bash
# 1. Clonar + deps
git clone <repo> tamaya && cd tamaya
cp .env.example .env        # rellena passwords + AWS creds
npm install                  # instala workspaces

# 2. Levantar infra (MySQL + Redis)
docker compose up -d mysql redis

# 3. Aplicar schema
cd packages/db && npm run db:push && cd ../..

# 4. Levantar web stack en Docker (hot reload)
docker compose up -d api worker-resolve web
docker compose logs -f       # ver logs de todo

# 5. Login inicial de WhatsApp (nativo, ves el QR en tu Chrome)
cd apps/worker-publish
rm -rf ./sessions            # si tenías sesión antigua
npm run login                # escanea QR

# 6. Build + arrancar worker publish con pm2
cd ../..
npm run build -w packages/core
npm run build -w packages/db
npm run build -w packages/shared-types
npm run build -w apps/worker-publish
cd apps/worker-publish && npm run pm2:start && cd ../..

# 7. Abrir UI
open http://localhost          # web
open http://localhost:3001/health  # api
```

### Prod (tu servidor Linux)

```bash
# Pre-requisitos en el server:
#   - Docker + Docker Compose v2
#   - Node 20+, npm
#   - pm2 global (npm i -g pm2)
#   - Para worker-publish en server: xvfb (apt install xvfb)
#     o usar TAMAYA_HEADLESS=true (detecta QR via imagen dumpeada)

# Primera vez
git clone <repo> /opt/tamaya && cd /opt/tamaya
cp .env.example .env && vim .env
npm install

# Arrancar stack Docker (prod overrides)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Migrar DB
cd packages/db && npm run db:push && cd ../..

# Login inicial — en server headless, usar xvfb:
cd apps/worker-publish
xvfb-run -a npm run login
# Alternativa: TAMAYA_HEADLESS=true npm run login y usar un script que extrae el QR
# del DOM como imagen PNG (ver sección "QR extraction" abajo — no incluido en este parche).

# Arrancar worker con pm2 bajo systemd (persiste reinicios)
npm run build -w packages/core
npm run build -w packages/db
npm run build -w packages/shared-types
npm run build -w apps/worker-publish
cd apps/worker-publish
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd          # genera y muestra el comando sudo a ejecutar
# Copia y ejecuta el comando sudo que te imprima

# Verificar
curl http://localhost/        # web
curl http://<ip-server>/      # desde tu LAN
curl http://<ip-server>:3001/health
pm2 status
docker compose ps
```

### Diagnóstico habitual

| Síntoma | Revisar |
|---|---|
| Job queda en `pending` y no avanza | `docker compose logs worker-resolve` — puede fallar S3 creds |
| Job pasa a `resolving` pero no a `ready` | Mismo sitio — la descarga puede haber timeoutado |
| Job en `ready` no se publica | `pm2 logs tamaya-worker-publish` — sesión WA expirada o selectores rotos |
| API no responde | `docker compose logs api` |
| UI no carga | Revisa `VITE_API_BASE_URL` del build y CORS del api |
| MySQL errores | `docker compose logs mysql`, revisa password en `.env` |
| Redis errores | `docker compose exec redis redis-cli ping` |

### Update de la aplicación

```bash
# Dev
git pull
npm install
npm run build
cd packages/db && npm run db:generate && npm run db:migrate && cd ../..
docker compose up -d --build
cd apps/worker-publish && npm run pm2:restart && cd ../..

# Prod (mismo flujo, sustituyendo compose con -f ...prod.yml)
```

### Backup

```bash
# MySQL
docker compose exec mysql mysqldump -u root -p tamaya > backup-$(date +%F).sql

# UserDataDir (sesión WA) — importante si se corrompe
tar czf sessions-backup-$(date +%F).tar.gz apps/worker-publish/sessions/

# Redis (opcional, la cola es efímera)
docker compose exec redis redis-cli SAVE
docker cp tamaya-redis-1:/data/dump.rdb redis-backup-$(date +%F).rdb
```

---

## Checklist de aplicación completo

Orden recomendado (~8–12h de trabajo total):

### Fase 1 — Estructura (2h)
- [ ] W1: reestructura a monorepo, mueve `src/` a `packages/core/src/`, crea `package.json` raíz con workspaces
- [ ] `npm install` funciona limpio
- [ ] `npm run build -w packages/core` compila (el código que ya tienes)

### Fase 2 — DB + Compose (2h)
- [ ] W2: `packages/db` con Drizzle + schema + cliente
- [ ] W4: `.env.example` + `docker-compose.yml` + override dev
- [ ] `docker compose up -d mysql redis` levanta ambos con healthchecks verdes
- [ ] `npm run db:push -w packages/db` aplica schema

### Fase 3 — API + Resolver (3h)
- [ ] W3: `packages/media-resolver`
- [ ] W5: `apps/api` con rutas `/jobs` y `/channels`
- [ ] W6: `apps/api/src/queue/bullmq.ts`
- [ ] `docker compose up -d api` — `curl http://localhost:3001/health` OK
- [ ] Test manual POST `/jobs` con curl → job aparece en DB

### Fase 4 — Workers (2h)
- [ ] W7: `apps/worker-resolve` + Dockerfile
- [ ] W8: `apps/worker-publish` + pm2 config + login script
- [ ] Login en tu Mac (`npm run login -w apps/worker-publish`)
- [ ] Arrancar worker con pm2 — `pm2 status` verde
- [ ] Test E2E: crear job con scheduledAt = now+1min, observar transitions `pending → resolving → ready → publishing → sent`

### Fase 5 — Frontend (3h)
- [ ] W9: `apps/web` Vite+React+Tailwind+shadcn
- [ ] `docker compose up -d web` — `http://localhost` carga
- [ ] Crear job desde UI funciona
- [ ] Lista actualiza en vivo (polling 5s)

### Fase 6 — Prod (1h + lo que tarde tu server)
- [ ] W10: deploy en servidor Linux
- [ ] Asignar DNS al servidor
- [ ] Verificar acceso externo

---

## Mejoras posteriores (backlog)

- **Multi-archivo en un solo job**: ampliar `publishMedia` para aceptar array y mandar todos en una sola vuelta al preview
- **SSE/WebSocket en la UI** en lugar de polling 5s (reduce carga)
- **Auth** en la UI (JWT simple o basic auth delante de nginx)
- **Retry manual** desde la UI (botón en jobs failed)
- **Duplicar job** desde la UI (para mismos canales en distintas fechas)
- **Preview del mensaje** antes de crear (render del texto con emoji, miniatura del media)
- **Multi-tenant**: aislar canales por usuario/organización
- **Múltiples cuentas WA**: 1 publish-worker por cuenta, cada uno con su `userDataDir` + su prefix de `publish-queue`
- **Dashboard BullMQ**: exponer `bull-board` para ver colas
- **Métricas**: Prometheus endpoint en el api (jobs_total{status}, publish_duration_seconds)
- **Alertas**: notificación push/email cuando un job falla definitivamente
