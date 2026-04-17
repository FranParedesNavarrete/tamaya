# System Design: WhatsApp Channels Publisher (SaaS)

**Versión:** 0.1 (draft)
**Fecha:** 2026-04-17
**Autor:** Fran Paredes
**Referencias:** ADR-001-whatsapp-channels-publisher.md

---

## 1. Requirements

### 1.1 Functional requirements

El sistema debe permitir a un usuario autenticado:

- **Gestionar canales de WhatsApp**: añadir canales (newsletters) a su cuenta, identificados por nombre o ID del canal, con posibilidad de importar/exportar la configuración en JSON.
- **Publicar un mensaje inmediato**: seleccionar un canal, componer un mensaje de texto y, opcionalmente, adjuntar hasta N ficheros (imagen, vídeo, audio, documento PDF/ofimática).
- **Programar un envío** para una fecha/hora futura, con posibilidad de recurrencia (semanal, diario) en tiers altos.
- **Ver historial de envíos** con estado (pendiente, en curso, enviado, fallido), contenido del mensaje, media adjunta, timestamp, canal y créditos consumidos.
- **Reintentar o cancelar** envíos en cola o fallidos.
- **Autenticarse en WhatsApp Web** mediante QR la primera vez, con sesión persistente y reautenticación asistida si expira.
- **Consumir créditos** según tier; recibir avisos al aproximarse al límite.

Además, funcionalidades administrativas:

- Panel de admin interno con métricas operativas, estado de sesiones, bans detectados, y capacidad de desactivar tenants.
- Exportación de datos del tenant (GDPR Art. 20).
- Borrado de datos del tenant (GDPR Art. 17).

### 1.2 Non-functional requirements

| Requisito | Objetivo | Comentario |
|-----------|----------|------------|
| Throughput | 2-3 msg/hora/tenant, máx. 50 tenants activos en v1 | ≈ 150 msg/hora pico sistema |
| Latencia envío | p50 < 10s, p95 < 30s (determinista); LLM p95 < 120s | Desde que el worker toma el job hasta verificación post-envío |
| Disponibilidad | 99.0% v1, 99.5% v2 | Ventanas de mantenimiento programables |
| Durabilidad de mensajes | 99.99% (jobs no se pierden) | Cola persistente (SQS + outbox) |
| Cifrado en reposo | AES-256 para sesiones y cuerpos de mensajes | Clave maestra en AWS KMS |
| Cifrado en tránsito | TLS 1.3 en todos los endpoints | Incluyendo interno worker ↔ backend |
| RTO / RPO | RTO 4h, RPO 15 min | Snapshots + replicación de DB |
| Tasa de éxito envío | > 97% en estado estable | Resto: fallback a LLM o notificación al usuario |
| Ban rate objetivo | < 1% de tenants/mes | Mitigado con rate-limits por tier |

### 1.3 Constraints

- Equipo inicial muy pequeño (probablemente 1-2 personas). Todo debe ser operable con poca plantilla.
- Infra existente: AWS + servidor físico propio → aprovechable para workers de Chromium (GPU/CPU más barato bare-metal que EC2 para esta carga).
- Ley de protección de datos aplicable: **GDPR** (cliente en España/EU).
- Stack preferido: TypeScript/Node en backend (compartir modelos con la extensión), Playwright como motor de automatización. Postgres como DB relacional.
- Objetivo de time-to-MVP: ~8-12 semanas.

---

## 2. High-Level Design

### 2.1 Diagrama de componentes

```
                                 ┌──────────────────────────┐
                                 │  Chrome Extension (UI)   │
                                 │  - Login                 │
                                 │  - Gestión de canales    │
                                 │  - Form envío + dropzone │
                                 │  - Historial             │
                                 └────────────┬─────────────┘
                                              │ HTTPS (JWT)
                                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      API Gateway  (ALB + Node/Fastify)                  │
│  /auth  /channels  /messages  /schedules  /credits  /sessions  /admin   │
└───────┬─────────────────────────┬────────────────────┬──────────────────┘
        │                         │                    │
        ▼                         ▼                    ▼
┌──────────────┐           ┌──────────────┐    ┌──────────────┐
│ PostgreSQL   │           │  Job Scheduler│    │   S3 Media   │
│  (RDS)       │           │  (EventBridge │    │   Bucket     │
│ tenants,     │           │   + cron)     │    │ (SSE-KMS)    │
│ channels,    │           └───────┬───────┘    └──────┬───────┘
│ messages,    │                   │                   │
│ credits,     │                   │                   │
│ audit_log    │                   │                   │
└──────┬───────┘                   ▼                   │
       │                  ┌────────────────┐           │
       │                  │  Job Queue     │           │
       │                  │  (SQS)         │           │
       │                  └───────┬────────┘           │
       │                          │                    │
       │                          ▼                    │
       │            ┌───────────────────────────┐      │
       │            │     Worker Pool           │      │
       │            │  (Playwright + Chromium)  │      │
       │            │  1 navegador por sesión   │◀─────┘ presigned URL
       │            │  activa, pool suspendible │
       │            └─────────┬─────────────────┘
       │                      │
       │                      ▼
       │            ┌───────────────────────┐
       │            │ Session Manager       │
       │            │  - cifra/descifra     │◀── KMS Master Key
       │            │  - persiste storage   │
       │            │    state de Playwright│
       │            └──────────┬────────────┘
       │                       │
       │                       ▼
       │            ┌───────────────────────┐
       └───────────▶│ LLM Fallback Service  │
                    │ (Claude Code / API)   │
                    └───────────────────────┘

             ┌────────────────────────────────────────┐
             │  Observabilidad                        │
             │  CloudWatch · Sentry · Grafana/Loki    │
             └────────────────────────────────────────┘
```

### 2.2 Flujo principal — envío inmediato

1. Usuario en la extensión rellena el form, adjunta ficheros, pulsa "Publicar".
2. Extensión sube los ficheros al backend (multipart), que los guarda en **S3** (cifrado SSE-KMS) y crea un registro en `messages` (estado `queued`).
3. Backend encola un **Job** en SQS con `{ message_id, tenant_id, priority }` — sin payloads, solo la referencia.
4. Un **Worker** con capacidad disponible toma el job. Verifica tier y rate-limits en DB (`SELECT FOR UPDATE` sobre `credits`).
5. El Worker carga la sesión cifrada de WhatsApp Web del tenant vía **Session Manager** (descifra con KMS y la monta en un contexto de Playwright).
6. Abre `web.whatsapp.com`, aplica **huella de navegador del tenant** (UA, viewport, timezone, locale persistentes), espera a que la sesión esté cargada.
7. Ejecuta el **script determinista** de publicación: navega al canal, inyecta texto, adjunta media vía `input[type=file]`, pulsa enviar.
8. **Verifica post-envío**: lee el último mensaje del canal y comprueba que coincide en texto y hash de media.
9. Si verificación OK → estado `sent`, se deducen créditos, se escribe en `audit_log`.
10. Si verificación falla → se intenta **LLM fallback** (si tier lo permite) o se marca `failed` y se devuelven créditos.
11. La sesión se guarda de vuelta al Session Manager (puede haber cambiado cookies/tokens).
12. El navegador se libera al pool; tras N min de inactividad se suspende (libera RAM).

### 2.3 Flujo secundario — envío programado

- Usuario crea un `schedule` con `cron_expr` o `send_at`.
- **EventBridge** (o un scheduler Node propio con `node-cron`) dispara a la hora indicada y publica el job equivalente en SQS.
- El resto del flujo es idéntico al envío inmediato.

### 2.4 Flujo de autenticación de WhatsApp Web (QR)

- Usuario pulsa "Conectar WhatsApp" en la extensión.
- Backend reserva un worker temporal, abre `web.whatsapp.com` en modo interactivo, captura el QR como imagen.
- El QR se streamea al usuario vía **WebSocket** o **Server-Sent Events**.
- Usuario escanea con su móvil → Playwright detecta login exitoso → captura el **storage state** (cookies + localStorage + IndexedDB).
- Se cifra con la clave maestra del tenant y se guarda en `sessions`.
- El worker temporal se cierra; la próxima publicación montará la sesión bajo demanda.

---

## 3. Deep Dive

### 3.1 Modelo de datos (PostgreSQL)

```sql
-- Multi-tenant
CREATE TABLE tenants (
  id                UUID PRIMARY KEY,
  email             CITEXT UNIQUE NOT NULL,
  display_name      TEXT,
  tier              TEXT NOT NULL DEFAULT 'free',  -- free | pro | business
  credits_balance   INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active', -- active | suspended | banned
  created_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ   -- soft delete (GDPR: purge job)
);

CREATE TABLE browser_fingerprints (
  tenant_id         UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  user_agent        TEXT NOT NULL,
  viewport_w        INTEGER NOT NULL,
  viewport_h        INTEGER NOT NULL,
  timezone          TEXT NOT NULL,
  locale            TEXT NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sessions (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  encrypted_state   BYTEA NOT NULL,       -- Playwright storageState JSON cifrado
  kms_key_id        TEXT NOT NULL,
  phone_number      TEXT,                  -- cacheado del perfil, para UX
  last_seen_at      TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'active', -- active | expired | banned
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE channels (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_channel_id TEXT,                -- el ID/invite link si lo conocemos
  name              TEXT NOT NULL,         -- nombre exacto (para localizar en UI)
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_channels_tenant ON channels(tenant_id);

CREATE TABLE messages (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id        UUID NOT NULL REFERENCES channels(id),
  body_encrypted    BYTEA NOT NULL,        -- cuerpo del texto cifrado
  body_hash         TEXT NOT NULL,         -- para verificación post-envío
  kms_key_id        TEXT NOT NULL,
  status            TEXT NOT NULL,         -- queued | in_progress | sent | failed | cancelled
  scheduled_at      TIMESTAMPTZ,
  attempted_count   INTEGER DEFAULT 0,
  last_error        TEXT,
  fallback_used     BOOLEAN DEFAULT false,
  credits_cost      INTEGER NOT NULL,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_messages_tenant_status ON messages(tenant_id, status);
CREATE INDEX idx_messages_scheduled ON messages(scheduled_at) WHERE status='queued';

CREATE TABLE message_media (
  id                UUID PRIMARY KEY,
  message_id        UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  s3_key            TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL,
  sha256            TEXT NOT NULL,         -- verificación post-envío
  kind              TEXT NOT NULL          -- image | video | audio | document
);

CREATE TABLE schedules (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id        UUID NOT NULL REFERENCES channels(id),
  template_body_encrypted BYTEA,
  kms_key_id        TEXT,
  cron_expr         TEXT,                  -- NULL si one-shot
  next_fire_at      TIMESTAMPTZ,
  status            TEXT NOT NULL,         -- active | paused
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE credit_ledger (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  delta             INTEGER NOT NULL,      -- + topup, - consumption
  reason            TEXT NOT NULL,         -- message_sent | refund | topup | adjustment
  ref_id            UUID,                  -- message_id si aplica
  balance_after     INTEGER NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_credit_tenant ON credit_ledger(tenant_id, created_at DESC);

CREATE TABLE audit_log (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID,
  actor             TEXT NOT NULL,         -- user:<id> | system | admin:<id>
  action            TEXT NOT NULL,
  target            TEXT,
  metadata          JSONB,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at DESC);
```

### 3.2 API (REST, versionada en `/v1`)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/v1/auth/login` | Login email+password, devuelve JWT |
| POST | `/v1/auth/refresh` | Refresh token |
| GET | `/v1/me` | Perfil + tier + créditos |
| GET | `/v1/channels` | Lista canales del tenant |
| POST | `/v1/channels` | Crea canal |
| DELETE | `/v1/channels/:id` | Borra canal |
| POST | `/v1/channels/import` | Importa JSON |
| GET | `/v1/channels/export` | Exporta JSON |
| POST | `/v1/sessions/connect` | Inicia flujo QR; devuelve SSE endpoint |
| GET | `/v1/sessions/status` | Estado de la sesión WhatsApp |
| DELETE | `/v1/sessions` | Desconecta y borra sesión |
| POST | `/v1/messages` | Crea + encola envío inmediato o programado |
| GET | `/v1/messages` | Lista/filtra historial |
| GET | `/v1/messages/:id` | Detalle |
| POST | `/v1/messages/:id/retry` | Reintenta un fallo |
| POST | `/v1/messages/:id/cancel` | Cancela si aún en cola |
| POST | `/v1/media` | Upload multipart, devuelve media_id |
| GET | `/v1/credits` | Balance + histórico |
| POST | `/v1/credits/topup` | Recarga (Stripe) |
| GET | `/v1/admin/*` | Endpoints admin (RBAC) |

**Contrato de envío:**

```json
POST /v1/messages
{
  "channel_id": "uuid",
  "body": "Texto del mensaje",
  "media_ids": ["uuid1", "uuid2"],
  "scheduled_at": null      // o ISO-8601 si programado
}
→ 202 Accepted
{ "id": "uuid", "status": "queued", "credits_cost": 1 }
```

### 3.3 Encolado, retry y idempotencia

- **SQS** como cola de jobs. Los jobs contienen **solo IDs**, no payloads. Esto evita duplicar datos y simplifica cifrado.
- **Idempotency key** = `message_id`. El worker antes de trabajar hace `UPDATE messages SET status='in_progress' WHERE id=? AND status='queued'` con claim atómico.
- **Visibility timeout** de SQS > 2 × p95 de tiempo de envío (p. ej. 5 min) para absorber lentitudes.
- **Reintentos** con backoff exponencial: 1min → 5min → 30min → dead-letter queue. Máx. 3 intentos deterministas antes de intentar fallback LLM (si tier lo permite).
- **Dead-letter queue**: mensajes que agotaron reintentos van a DLQ y disparan alerta + notificación al tenant + reembolso de créditos.
- **Outbox pattern** en el backend: al crear un mensaje, la inserción en DB y el envío a SQS se hacen en transacción mediante una tabla `outbox` drenada por un worker.

### 3.4 Worker Pool y gestión de navegadores

**Estrategia: pool con afinidad por tenant, suspensión por ociosidad.**

- Cada worker ejecuta un **navegador por tenant activo**. Motivo: mezclar sesiones en el mismo contexto es riesgo de leaks + huellas cruzadas = ban.
- Un worker (contenedor) puede hospedar **hasta K navegadores en paralelo** (K limitado por RAM: Chromium ≈ 250-400 MB con perfil). En un host con 16 GB → K ≈ 30.
- **Suspensión activa**: tras 10 min sin jobs para un tenant, se serializa el `storageState`, se cifra y se guarda; el navegador se cierra. Al siguiente job se reanima (cold start ~3-5s).
- **Warm pool**: los N tenants con más actividad se mantienen calientes aunque estén ociosos.
- **Scheduling**: una sola cola SQS. Los workers usan `receive_message` con `long polling`. Cada job lleva `tenant_id`; si el worker ya tiene ese tenant caliente, lo toma; si no, lo toma el primero con capacidad.
- **Aislamiento**: cada contexto de Playwright tiene su propio `userDataDir` en disco efímero cifrado (LUKS o tmpfs). Nunca se comparte entre tenants.

### 3.5 Sesiones y cifrado

- **Clave maestra** en AWS KMS. Una CMK por entorno (prod/staging).
- **DEK por tenant** (Data Encryption Key): generada con `kms:GenerateDataKey`, almacenada cifrada (wrapped) en la fila del tenant. Cada operación cifra en memoria con DEK plaintext, la descarta tras uso.
- **storageState de Playwright** se serializa a JSON, se cifra con DEK del tenant (AES-256-GCM) y se guarda en `sessions.encrypted_state`.
- **Rotación de DEK**: re-wrap periódico (90 días) sin re-cifrar el payload (reduce coste KMS).
- **Rotación de CMK**: automática vía KMS (anual).
- **Runbook de descifrado de urgencia**: requiere dos autorizaciones humanas registradas (principio de cuatro ojos), acceso temporal a la CMK, log inmutable en CloudTrail.

### 3.6 Sistema de tiers y créditos

| Tier | Precio/mes | Créditos/mes | Máx msg/día | Máx msg/hora | LLM fallback |
|------|-----------|-------------|-------------|--------------|--------------|
| Free | 0 € | 30 | 5 | 2 | No |
| Pro | 29 € | 400 | 20 | 5 | Incluido con límite |
| Business | 99 € | 1500 | 60 | 10 | Ilimitado |

Créditos adicionales vendibles fuera de la suscripción. 1 envío consume:

- 1 crédito para texto y media < 5 MB.
- 2 créditos si media ≥ 5 MB o si se usa LLM fallback.
- 5 créditos por uso explícito de LLM (tier usa-a-gusto).

**Rate limiting** implementado en dos capas:
1. **Capa dura** en backend al aceptar el job (rechaza con 429 si se excede tier).
2. **Capa blanda** en worker con jitter aleatorio ±20% del rate para parecer humano.

### 3.7 Estrategia anti-ban

- **Huella consistente por tenant**: UA, viewport, timezone, locale fijos y realistas (derivados del perfil del usuario al onboarding).
- **Horario humano configurable**: el tenant define ventanas de envío (p. ej. 8:00-22:00 Europe/Madrid). Fuera de ventana → se retrasa a la siguiente.
- **Jitter** de 30-180s entre acción final de navegación y envío real.
- **Sin ráfagas**: backpressure si hay > 1 mensaje pendiente para el mismo canal en < 60s.
- **Fingerprint rotation**: NO rotar (queremos consistencia, no aleatoriedad).
- **Verificación post-envío** por lectura del canal: detecta silent-fail y bans.
- **Health check de sesión** cada 6h: si detecta logout forzado o challenge, marca `sessions.status='expired'` y notifica al tenant.
- **Canary**: una sesión de prueba propia que publica 1 msg/día en un canal controlado y valida que la plataforma sigue funcionando.

### 3.8 Script determinista — puntos de verificación

El script de publicación debe verificar explícitamente:

1. Navegación al canal con éxito (URL esperada, título del canal visible).
2. Texto inyectado igual al texto que queremos (comparar `innerText`).
3. Si hay media: miniatura visible antes de pulsar enviar.
4. Tras enviar: aparece el mensaje en el hilo con timestamp reciente (± 10s del envío).
5. Hash SHA-256 de la media descargable desde el propio mensaje publicado coincide con `message_media.sha256`.

Si falla cualquiera → retry determinista (hasta 2) → fallback LLM (si tier lo permite) → `failed`.

### 3.9 LLM Fallback

- Se invoca con un prompt que incluye: objetivo ("publicar este texto + esta media en este canal"), estado actual capturado (screenshot + DOM reducido), y herramientas disponibles (click, type, upload, screenshot).
- Timeout agresivo: 180s máximo.
- Coste promedio esperado por invocación: 0.30-1.50 € (limita el tier).
- Se registra en `messages.fallback_used=true` y se cobra según pricing.

---

## 4. Scale and Reliability

### 4.1 Estimación de carga (v1 y v2)

| Magnitud | v1 (50 tenants) | v2 (500 tenants) | v3 (5000 tenants) |
|----------|------------------|-------------------|-------------------|
| Msg/hora pico | 150 | 1500 | 15000 |
| Navegadores concurrentes pico | ~30 | ~200 | ~1500 |
| Almacenamiento media (S3, 30 días) | 150 GB | 1.5 TB | 15 TB |
| DB IOPS | < 100 | < 500 | sharding necesario |
| Coste infra mensual estimado | 500-800 € | 3-5k € | 20-30k € |

**v1 cabe en 2-3 hosts** (bare-metal físico + un par de EC2 para API/DB). **v2** requiere orquestación (ECS o Kubernetes) y autoescalado de workers. **v3** requiere sharding de DB por tenant y colas por región.

### 4.2 Failover y redundancia

- **API Gateway y backend**: 2 zonas AZ en AWS, ALB con health checks.
- **DB**: RDS Multi-AZ con réplica síncrona.
- **Workers**: stateless respecto a navegadores (el estado vive en Session Manager). Un worker que cae es reemplazado; el tenant afectado sufre un cold-start extra.
- **SQS**: gestionado por AWS, alta disponibilidad nativa.
- **S3**: cross-region replication para media crítica (opcional v2+).

### 4.3 Monitorización y alerting

**Métricas clave:**

- `message_send_success_rate` (por tier, por canal, global) → alerta si < 95% en ventana 15 min.
- `p95_send_duration_ms` → alerta si > 60s.
- `fallback_llm_rate` → alerta si > 10% (indicador de que WhatsApp Web cambió).
- `session_expired_rate_24h` → alerta si spike.
- `ban_detected_count` → alerta cualquier detección (revisar manualmente).
- `queue_depth_sqs` → alerta si backlog > 500 mensajes.
- `credits_refund_rate` → indicador de calidad.
- `browser_pool_saturation` → alerta si > 85%.

**Herramientas:** CloudWatch para infra, Grafana + Loki para logs/métricas, Sentry para errores, PagerDuty para on-call.

**Canary externo:** script separado que prueba el flujo end-to-end cada hora y publica métricas sintéticas.

### 4.4 Backup y DR

- Snapshots diarios de RDS retenidos 30 días.
- Backup cifrado de las DEKs wrapped por si se pierde la CMK (improbable pero contemplado).
- Runbook de recuperación documentado con RTO 4h y RPO 15 min.

---

## 5. Trade-off Analysis

**Postgres vs. DynamoDB**
Se elige Postgres por la necesidad de transacciones (outbox, crédito, idempotencia) y consultas relacionales (historial filtrado). DynamoDB sería más escalable pero fuerza un diseño más rígido y encarece la lógica transaccional. Revisitar cuando > 5k tenants.

**SQS vs. Redis Streams**
SQS es gestionado, tiene DLQ nativo y no requiere ops. Redis sería más rápido y flexible pero añade un componente que mantener. SQS gana en v1.

**Un navegador por tenant vs. contexts compartidos en el mismo navegador**
Separación estricta = más RAM pero aislamiento de sesiones y huellas. En WhatsApp Web, una sola fuga de localStorage entre contextos = desastre (mensajes al canal equivocado). No es un trade-off real: toca separar.

**AWS Lambda para workers vs. contenedores long-running**
Lambda no sirve: Chromium no cabe cómodamente, y las sesiones persistidas en memoria entre envíos ahorran mucho tiempo. Contenedores long-running (ECS/Fargate o bare-metal) son la única opción.

**Cifrado a nivel de aplicación vs. solo a nivel de disco**
Ambos. Disco cifrado (SSE-KMS en S3, GP3 encrypted en RDS) protege de robo físico; cifrado a nivel aplicación protege de compromisos de la DB o logs. Coste marginal bajo, beneficio grande (especialmente tras un incidente).

**Chrome Extension vs. app web / app nativa como UI**
La extensión es conveniente porque los usuarios ya están en el navegador gestionando contenido, y facilita el drag-drop de ficheros. Pero limita el alcance a Chrome/Edge/Brave. En v2 conviene añadir app web como fallback para Firefox/Safari.

**Playwright vs. Puppeteer vs. Selenium**
Playwright: mejor soporte multi-browser, API más moderna, `storageState` serializable, mejor para tests. Puppeteer lo podría sustituir sin grandes cambios. Selenium descartado (más pesado, peor DX).

---

## 6. What to revisit as the system grows

- **> 200 tenants activos**: migrar workers a Kubernetes con HPA sobre métricas custom (queue depth + CPU).
- **> 500 tenants**: sharding de DB por `tenant_id` (Citus o particionado lógico).
- **Cambios de WhatsApp Web (trimestrales)**: automatizar el hotfix con un script de "grabación" del flujo nuevo sobre una sesión de prueba; validar con canaries.
- **Si Meta abre API oficial de canales con media**: migrar tráfico a la API y mantener navegador como fallback. Reduce coste y riesgo de ban.
- **Internacionalización**: separar colas por región si expandimos fuera de la UE.
- **Compliance avanzado** (SOC2, ISO 27001): cuando llegue el primer cliente enterprise.
- **Modelo híbrido extensión + servidor**: reconsiderar si aparece demanda de envíos "sin custodia" (profesionales que no quieren que tengamos su sesión).

---

## 7. Open questions

1. **Nombre vs. ID de canal** — ¿cómo identifica el usuario el canal destino? Opciones:
   - Por nombre exacto: más UX-friendly, pero frágil si el usuario renombra.
   - Por invite link (`https://whatsapp.com/channel/...`): robusto pero menos humano.
   - Híbrido: guardamos ambos al añadir el canal, y el script prefiere link.

2. **Multi-admin por canal** — ¿soportamos que varios usuarios de un mismo tenant publiquen en el mismo canal? Requeriría RBAC más fino.

3. **Borradores y aprobaciones** — ¿workflow de "un usuario redacta, otro aprueba"? Común en medios y marcas. Posible feature de tier Business.

4. **Analytics de canal** — ¿leemos métricas del canal (suscriptores, reacciones)? Útil como feature pero aumenta superficie de scraping.

5. **Facturación** — Stripe Billing para suscripciones + créditos? Confirmar integración y modelo fiscal (IVA intracomunitario).

6. **Acuerdo de procesado de datos (DPA)** — plantilla para tenants enterprise.
