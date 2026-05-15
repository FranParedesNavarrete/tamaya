# Tamaya API

REST API para integrar Tamaya en otras aplicaciones: crear canales, programar jobs, subir media y consultar estado.

- **Base URL (dev):** `http://localhost:3001`
- **Content-Type:** `application/json` (salvo `/media/upload` que es `multipart/form-data`)
- **Auth:** *actualmente sin autenticación.* Pensado para uso en LAN / localhost. Ver [Roadmap](#roadmap) si vas a exponer la API públicamente.

---

## Tabla de endpoints

| Método | Path                          | Descripción                                       |
| ------ | ----------------------------- | ------------------------------------------------- |
| GET    | `/health`                     | Healthcheck                                       |
| GET    | `/channels`                   | Listar canales activos                            |
| GET    | `/channels/:id`               | Obtener un canal                                  |
| POST   | `/channels`                   | Crear canal                                       |
| PUT    | `/channels/:id`               | Actualizar canal                                  |
| DELETE | `/channels/:id`               | Soft-delete de canal                              |
| POST   | `/media/upload`               | Subir archivo (imagen/vídeo), devuelve `source`   |
| POST   | `/jobs`                       | Crear un job (programado o inmediato)             |
| GET    | `/jobs`                       | Listar/buscar jobs con filtros                    |
| GET    | `/jobs/:id`                   | Obtener un job                                    |
| POST   | `/jobs/:id/cancel`            | Cancelar un job pendiente                         |
| DELETE | `/jobs/:id`                   | Borrar un job                                     |
| GET    | `/stats/summary`              | Métricas globales                                 |
| GET    | `/stats/by-status`            | Conteo por status                                 |
| GET    | `/stats/by-channel`           | Top canales                                       |
| GET    | `/stats/timeline`             | Serie temporal                                    |
| GET    | `/stats/media-types`          | Conteo por tipo de contenido                      |
| GET    | `/stats/hourly-heatmap`       | Actividad por día × hora                          |
| GET    | `/stats/duration-distribution`| Histograma de duración                            |
| GET    | `/stats/recent-failures`      | Últimos fallos con su error                       |

---

## Flujo típico para integrar

El caso más frecuente — **crear un job con media desde otra app**:

```
1. GET  /channels              → elige el channelId
2. POST /media/upload          → sube imagen/vídeo, guarda el `source`
3. POST /jobs                  → crea el job con channelId + source
4. (opcional) GET /jobs/:id    → poll para ver cuándo pasa a 'sent' / 'failed'
```

Alternativa sin subir archivo: pasar una URL pública (`https://...`) o una ruta S3 (`s3://bucket/key.png`) directamente como `source` en el POST `/jobs`. El worker-resolve se encarga de descargarla y detectar el MIME por `Content-Type`.

---

## Canales

### GET /channels

Lista canales activos (soft-deletados excluidos).

**Respuesta 200** — array de canales:

```json
[
  {
    "id": "6b4f1b2a-5e0f-4c3a-a8a1-0c2a6ad3e4d9",
    "tenantId": "default",
    "acronym": "NEWS",
    "name": "Pruebas n8n",
    "description": "Canal de pruebas",
    "inviteLink": "https://whatsapp.com/channel/XXXXXXXX",
    "whatsappId": null,
    "createdAt": "2026-04-15T09:12:00.000Z",
    "updatedAt": "2026-04-17T22:45:00.000Z",
    "deletedAt": null
  }
]
```

### GET /channels/:id

**404** si no existe. Misma shape que el item de la lista.

### POST /channels

**Body:**

| Campo         | Tipo     | Req. | Notas                                               |
| ------------- | -------- | ---- | --------------------------------------------------- |
| `name`        | string   | ✅   | Debe coincidir **exactamente** con el que muestra WA Web. 1–255 chars. |
| `acronym`     | string   | ⬜   | 1–16 chars, usado como prefijo visual en la UI.     |
| `description` | string   | ⬜   | Libre.                                              |
| `inviteLink`  | string   | ⬜   | URL válida. Si se incluye, el worker la usa como ruta preferente al canal. |
| `whatsappId`  | string   | ⬜   | Reservado para futuras integraciones.               |

**Ejemplo:**

```bash
curl -X POST http://localhost:3001/channels \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Pruebas n8n",
    "acronym": "N8N",
    "description": "Canal de pruebas",
    "inviteLink": "https://whatsapp.com/channel/XXXXXXXX"
  }'
```

**Respuesta 200:**

```json
{ "id": "6b4f1b2a-5e0f-4c3a-a8a1-0c2a6ad3e4d9" }
```

### PUT /channels/:id

Mismo body que POST pero todos los campos son opcionales (solo se actualiza lo enviado).

### DELETE /channels/:id

Soft-delete (marca `deletedAt`). El canal desaparece de `GET /channels` pero sus jobs anteriores se conservan.

---

## Media

### POST /media/upload

Sube un archivo al tmp compartido. **No** crea un job; solo te da un `source` listo para usarlo en `POST /jobs`.

**Content-Type:** `multipart/form-data`

**Body:** un único campo `file` con el archivo. Solo `image/*` y `video/*` aceptados (límite 100 MB).

**Respuesta 200:**

```json
{
  "source": "/tmp/tamaya-media/7fdea64d8daa5bd2-75695a99.mp4",
  "mime": "video/mp4",
  "size": 12845230,
  "originalName": "demo.mp4"
}
```

**Errores:**
- `400` — no se ha enviado archivo.
- `415` — tipo no soportado (cualquier cosa que no sea `image/*` o `video/*`).

**Ejemplo:**

```bash
curl -X POST http://localhost:3001/media/upload \
  -F "file=@./foto.jpg"
```

---

## Jobs

### POST /jobs

Crea un job programado. Una vez creado, pasa por la cola `resolve` (descarga media si hace falta) y luego por `publish` (envía a WA Web).

**Body:**

| Campo         | Tipo             | Req.            | Notas                                                       |
| ------------- | ---------------- | --------------- | ----------------------------------------------------------- |
| `channelId`   | UUID             | ✅              | Id devuelto por `POST /channels` o `GET /channels`.         |
| `text`        | string           | ⬜ *            | Texto del mensaje. Se usa como caption si hay media.        |
| `media`       | `MediaSource[]`  | ⬜ *            | Array de `{ source: string }`. Mínimo 0.                    |
| `scheduledAt` | ISO 8601         | ✅              | Fecha/hora de publicación. Para "ahora" manda `new Date().toISOString()`. |

\* **Al menos uno de `text` o `media` es obligatorio.** Si mandas los dos vacíos → `400`.

**`MediaSource.source`** admite tres formatos:

- Ruta devuelta por `POST /media/upload` — ej. `/tmp/tamaya-media/abc123.jpg`
- URL pública `https://...` o `http://...` — el worker-resolve la descarga y guarda con la extensión correcta según `Content-Type`.
- URI de S3 `s3://bucket/key.jpg` — requiere credenciales AWS en el `.env`.

**Ejemplo 1 — solo texto, publicar ahora:**

```bash
curl -X POST http://localhost:3001/jobs \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "channelId": "6b4f1b2a-5e0f-4c3a-a8a1-0c2a6ad3e4d9",
  "text": "Hola desde la API",
  "media": [],
  "scheduledAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
JSON
)"
```

**Ejemplo 2 — imagen por URL + caption, programado:**

```bash
curl -X POST http://localhost:3001/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "channelId": "6b4f1b2a-5e0f-4c3a-a8a1-0c2a6ad3e4d9",
    "text": "Mira esta foto",
    "media": [{ "source": "https://example.com/foto.jpg" }],
    "scheduledAt": "2026-04-20T18:00:00.000Z"
  }'
```

**Ejemplo 3 — vídeo subido previamente:**

```bash
# 1. Sube el vídeo
RESP=$(curl -s -X POST http://localhost:3001/media/upload -F "file=@./video.mp4")
SOURCE=$(echo "$RESP" | jq -r .source)

# 2. Crea el job con ese source
curl -X POST http://localhost:3001/jobs \
  -H "Content-Type: application/json" \
  -d "{
    \"channelId\": \"6b4f1b2a-5e0f-4c3a-a8a1-0c2a6ad3e4d9\",
    \"text\": \"Novedades de hoy\",
    \"media\": [{ \"source\": \"$SOURCE\" }],
    \"scheduledAt\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
  }"
```

**Respuesta 200:**

```json
{ "id": "a57a37f9-f52c-40b0-88fd-b1ebd602a15b", "status": "pending" }
```

**Errores:**
- `400` — body inválido (ej. `text` y `media` ambos vacíos, `scheduledAt` no es ISO).
- `404` — el `channelId` no existe.

### GET /jobs

Lista/busca jobs. Todos los filtros son opcionales y combinables.

**Query params:**

| Param       | Tipo   | Descripción                                               |
| ----------- | ------ | --------------------------------------------------------- |
| `status`    | string | `pending`, `resolving`, `ready`, `publishing`, `sent`, `failed`, `cancelled` |
| `channelId` | UUID   | Filtra por canal.                                         |
| `q`         | string | Búsqueda en `text` (LIKE `%q%`).                          |
| `from`      | ISO    | `scheduledAt >= from`.                                    |
| `to`        | ISO    | `scheduledAt <= to`.                                      |
| `limit`     | int    | 1-500. Default: 100.                                      |
| `offset`    | int    | Default: 0.                                               |

**Respuesta 200** — array de jobs:

```json
[
  {
    "id": "a57a37f9-f52c-40b0-88fd-b1ebd602a15b",
    "tenantId": "default",
    "channelId": "6b4f1b2a-5e0f-4c3a-a8a1-0c2a6ad3e4d9",
    "channelName": "Pruebas n8n",
    "text": "Hola",
    "media": [{ "source": "/tmp/tamaya-media/abc.jpg", "localPath": "/tmp/tamaya-media/abc.jpg", "mime": "image/jpeg", "sizeBytes": 48512 }],
    "scheduledAt": "2026-04-20T18:00:00.000Z",
    "status": "sent",
    "attemptCount": 1,
    "maxAttempts": 3,
    "lastError": null,
    "durationMs": 18420,
    "sentAt": "2026-04-20T18:00:18.420Z",
    "createdAt": "2026-04-20T17:58:03.000Z",
    "updatedAt": "2026-04-20T18:00:18.420Z"
  }
]
```

### GET /jobs/:id

**404** si no existe. Misma shape que el item de la lista.

### POST /jobs/:id/cancel

Marca un job como `cancelled`. **No sirve** para jobs en estados `publishing` o `resolving` (en curso) → `409`.

**Respuesta 200:**

```json
{ "id": "a57a37f9-f52c-40b0-88fd-b1ebd602a15b", "status": "cancelled" }
```

### DELETE /jobs/:id

Borrado real de la fila. Igual restricción: no se puede borrar un job en curso → `409`.

**Respuesta 200:**

```json
{ "id": "a57a37f9-f52c-40b0-88fd-b1ebd602a15b", "deleted": true }
```

---

## Estados de un Job

```
            ┌──────────┐                       ┌─────────┐
            │ pending  │──────(cancelar)──────▶│cancelled│
            └────┬─────┘                       └─────────┘
                 ▼
            ┌──────────┐     error de descarga     ┌────────┐
            │resolving │─────────────────────────▶│ failed │
            └────┬─────┘                           └────────┘
                 ▼
            ┌──────────┐                                ▲
            │  ready   │                                │
            └────┬─────┘                                │
                 ▼                                      │
            ┌──────────┐    error publicando           │
            │publishing│────────────────────────────────┘
            └────┬─────┘
                 ▼
            ┌──────────┐
            │   sent   │
            └──────────┘
```

Un job fallido se puede reintentar creando uno nuevo con los mismos datos (la UI tiene un botón "Reintentar" que hace exactamente eso).

---

## Healthcheck

### GET /health

```bash
curl http://localhost:3001/health
```

```json
{ "ok": true, "ts": "2026-04-20T10:00:00.000Z" }
```

Útil para monitores externos (UptimeRobot, Prometheus blackbox, etc.).

---

## Stats (solo lectura)

Todos los endpoints de stats aceptan los mismos query params opcionales:

| Param       | Tipo | Descripción                         |
| ----------- | ---- | ----------------------------------- |
| `from`      | ISO  | Filtra por `scheduledAt >= from`.   |
| `to`        | ISO  | Filtra por `scheduledAt <= to`.     |
| `channelId` | UUID | Filtra por canal.                   |

### GET /stats/summary

```json
{
  "total": 128,
  "sent": 112,
  "failed": 9,
  "pending": 3,
  "publishing": 0,
  "cancelled": 4,
  "avgDurationMs": 18072.6,
  "totalAttempts": 141,
  "successRate": 0.925
}
```

### GET /stats/by-status

```json
[
  { "status": "sent", "count": 112 },
  { "status": "failed", "count": 9 },
  { "status": "cancelled", "count": 4 }
]
```

### GET /stats/by-channel

Top 20 canales por volumen. Ordenado por `total` descendente.

```json
[
  {
    "channelId": "6b4f1b2a-...",
    "channelName": "Pruebas n8n",
    "total": 48,
    "sent": 45,
    "failed": 3
  }
]
```

### GET /stats/timeline

Extra param: `granularity` ∈ `hour` | `day` (default) | `week`.

```json
[
  { "bucket": "2026-04-18", "sent": 9, "failed": 0, "pending": 0, "cancelled": 0, "publishing": 0 },
  { "bucket": "2026-04-19", "sent": 12, "failed": 1, "pending": 0, "cancelled": 0, "publishing": 0 }
]
```

### GET /stats/media-types

```json
{ "textOnly": 40, "image": 62, "video": 18, "mixed": 5, "other": 3 }
```

### GET /stats/hourly-heatmap

7 (día de semana, 1=Dom … 7=Sáb) × 24 (hora) → conteo.

```json
[
  { "dow": 2, "hour": 9, "count": 5 },
  { "dow": 2, "hour": 10, "count": 3 }
]
```

### GET /stats/duration-distribution

Buckets fijos: `<5s`, `5-15s`, `15-30s`, `30-60s`, `1-2m`, `2-5m`, `>5m`. Solo considera jobs `sent`.

```json
[
  { "bucket": "15-30s", "count": 48 },
  { "bucket": "30-60s", "count": 21 }
]
```

### GET /stats/recent-failures

Query param: `limit` (1–50, default 10).

```json
[
  {
    "id": "...",
    "channelName": "Pruebas n8n",
    "text": "Hola",
    "lastError": "waitForAny: no selector matched in 20000ms",
    "scheduledAt": "2026-04-19T18:00:00.000Z",
    "attemptCount": 3
  }
]
```

---

## Códigos de error

| Código | Significado                                                          |
| ------ | -------------------------------------------------------------------- |
| 200    | OK                                                                   |
| 400    | Body o query inválido (valida contra el Zod schema del endpoint).    |
| 404    | Recurso no encontrado (canal o job por id).                          |
| 409    | Operación no permitida en el estado actual (cancelar/borrar en curso). |
| 415    | MIME no soportado (solo `/media/upload`).                            |
| 500    | Error interno — revisa logs del contenedor `api`.                    |

---

## Ejemplos de integración

### Node.js (fetch)

```ts
const API = 'http://localhost:3001';

async function sendNow(channelId: string, text: string, imageUrl?: string) {
  const r = await fetch(`${API}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channelId,
      text,
      media: imageUrl ? [{ source: imageUrl }] : [],
      scheduledAt: new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<{ id: string; status: string }>;
}

// Uso:
const { id } = await sendNow(
  '6b4f1b2a-5e0f-4c3a-a8a1-0c2a6ad3e4d9',
  'Hola desde Node',
  'https://example.com/foto.jpg',
);
console.log('Job creado:', id);
```

### Python (requests)

```python
import requests, datetime

API = "http://localhost:3001"

def send_now(channel_id, text, image_path=None):
    media = []
    if image_path:
        with open(image_path, "rb") as f:
            r = requests.post(f"{API}/media/upload", files={"file": f})
            r.raise_for_status()
            media = [{"source": r.json()["source"]}]
    r = requests.post(f"{API}/jobs", json={
        "channelId": channel_id,
        "text": text,
        "media": media,
        "scheduledAt": datetime.datetime.utcnow().isoformat() + "Z",
    })
    r.raise_for_status()
    return r.json()

print(send_now("6b4f1b2a-...", "Hola desde Python", "./foto.jpg"))
```

### n8n / Make / Zapier

- **Trigger:** lo que quieras (webhook, cron, un evento…).
- **Step 1** (solo si hay archivo local): HTTP Request `POST /media/upload` con el binario en campo `file`. Capturar `source`.
- **Step 2**: HTTP Request `POST /jobs` con JSON:
  ```json
  {
    "channelId": "{{ channelId }}",
    "text": "{{ text }}",
    "media": [{ "source": "{{ source }}" }],
    "scheduledAt": "{{ $now.toISO() }}"
  }
  ```

---

## Roadmap

Cosas que **no** están aún pero tienen sentido cuando expongas esto fuera de localhost:

- **Auth Bearer token** (flag `TAMAYA_API_KEY` opt-in).
- **Rate limiting** por token.
- **Swagger UI en `/docs`** autogenerado desde los schemas Zod.
- **Webhooks** para notificar al sistema integrador cuando un job cambia de estado (hoy hace falta hacer polling).

Si las vas a necesitar, abre un issue y vamos.
