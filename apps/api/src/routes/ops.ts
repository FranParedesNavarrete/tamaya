import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { getDb } from '@tamaya/db';
import { resolveQueue, publishQueue } from '../queue/bullmq.js';
import { getSetting } from '../settings/store.js';
import { controlFetch, ControlUnavailableError } from '../control-client.js';
import { alertsEnabled, readAlertConfig, sendAlert } from '../alerts/notify.js';

// Un heartbeat se considera "fresco" (proceso online) si su updatedAt tiene
// menos de este umbral. El worker late cada ~12s.
const HEARTBEAT_STALE_MS = 30_000;

interface HeartbeatInfo {
  pid?: number;
  hostname?: string;
  updatedAt?: string;
  ageMs?: number;
}

async function readHeartbeat(key: string): Promise<{ online: boolean; info: HeartbeatInfo | null }> {
  const raw = await getSetting(key);
  if (!raw) return { online: false, info: null };
  try {
    const info = JSON.parse(raw) as HeartbeatInfo;
    const ts = info.updatedAt ? new Date(info.updatedAt).getTime() : 0;
    const ageMs = Date.now() - ts;
    return { online: ts > 0 && ageMs < HEARTBEAT_STALE_MS, info: { ...info, ageMs } };
  } catch {
    return { online: false, info: null };
  }
}

async function queueCounts(q: typeof resolveQueue) {
  const c = await q.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
  return {
    waiting: c.waiting ?? 0,
    active: c.active ?? 0,
    delayed: c.delayed ?? 0,
    completed: c.completed ?? 0,
    failed: c.failed ?? 0,
    paused: c.paused ?? 0,
  };
}

/** ¿Está el control server nativo accesible? (su /health es público). */
async function controlServerHealth(): Promise<boolean> {
  try {
    const { status } = await controlFetch('GET', '/health', { timeoutMs: 4000 });
    return status === 200;
  } catch {
    return false;
  }
}

const QueueCountsSchema = z.object({
  waiting: z.number(), active: z.number(), delayed: z.number(),
  completed: z.number(), failed: z.number(), paused: z.number(),
});

/**
 * Endpoints de diagnóstico del pipeline. Todos protegidos por el guard de token
 * (van bajo /ops, que no está en la lista pública de auth.ts).
 */
export async function opsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = getDb();

  // GET /ops/queues — conteos BullMQ de ambas colas.
  app.get('/queues', {
    schema: {
      summary: 'Conteos de las colas BullMQ',
      description: 'Jobs por estado de la cola de resolución (media) y de la de publicación.',
      response: { 200: z.object({ resolve: QueueCountsSchema, publish: QueueCountsSchema }) },
    },
  }, async () => {
    const [resolve, publish] = await Promise.all([
      queueCounts(resolveQueue),
      queueCounts(publishQueue),
    ]);
    return { resolve, publish };
  });

  // GET /ops/publisher — ¿por qué (no) se está publicando?
  app.get('/publisher', {
    schema: {
      summary: 'Estado del publicador de WhatsApp',
      description: 'Heartbeats de worker-publish y del control server, sesión de WhatsApp y jobs pendientes. `message` resume por qué (no) se está publicando.',
      response: {
        200: z.object({
          controlServerAvailable: z.boolean(),
          controlOnline: z.boolean(),
          sessionExists: z.boolean().nullable(),
          publisherOnline: z.boolean(),
          publisherLikelyRunning: z.boolean(),
          publisherHeartbeat: z.object({
            pid: z.number().optional(),
            hostname: z.string().optional(),
            updatedAt: z.string().optional(),
            ageMs: z.number().optional(),
          }).nullable(),
          publishQueueWaiting: z.number(),
          publishActive: z.number(),
          message: z.string(),
        }),
      },
    },
  }, async () => {
    const [publish, pubHb, ctrlHb, controlServerAvailable] = await Promise.all([
      queueCounts(publishQueue),
      readHeartbeat('worker.publish.heartbeat'),
      readHeartbeat('worker.control.heartbeat'),
      controlServerHealth(),
    ]);

    // sessionExists lo sabe el control server (si está disponible).
    let sessionExists: boolean | null = null;
    if (controlServerAvailable) {
      try {
        const { status, body } = await controlFetch('GET', '/whatsapp/status', { timeoutMs: 4000 });
        if (status === 200 && body && typeof body === 'object') {
          sessionExists = Boolean((body as { sessionExists?: boolean }).sessionExists);
        }
      } catch {
        /* deja sessionExists en null */
      }
    }

    const publishQueueWaiting = publish.waiting + publish.delayed;
    const publisherOnline = pubHb.online;
    const publisherLikelyRunning = publisherOnline || publish.active > 0;

    let message: string;
    if (publishQueueWaiting > 0 && !publisherLikelyRunning) {
      message = 'Hay jobs listos pero worker-publish no está consumiendo';
    } else if (publisherLikelyRunning) {
      message = 'worker-publish activo';
    } else {
      message = 'Sin jobs pendientes de publicar';
    }

    return {
      controlServerAvailable,
      controlOnline: ctrlHb.online,
      sessionExists,
      publisherOnline,
      publisherLikelyRunning,
      publisherHeartbeat: pubHb.info,
      publishQueueWaiting,
      publishActive: publish.active,
      message,
    };
  });

  // POST /ops/publisher/restart — pide al control server nativo reiniciar worker-publish vía PM2.
  app.post('/publisher/restart', {
    schema: {
      summary: 'Reiniciar worker-publish',
      description: 'Pide al control server nativo reiniciar worker-publish vía PM2. Responde 503 si el control server no está disponible.',
    },
  }, async (_req, reply) => {
    try {
      const { status, body } = await controlFetch('POST', '/publisher/restart', { timeoutMs: 35_000 });
      return reply.code(status).send(body);
    } catch (err) {
      if (err instanceof ControlUnavailableError) {
        return reply.code(503).send({ error: 'worker-publish control server not available' });
      }
      throw err;
    }
  });

  // POST /ops/alerts/test — envía una alerta de prueba por n8n (email y/o WhatsApp).
  app.post('/alerts/test', {
    schema: {
      summary: 'Enviar una alerta de prueba',
      description: 'Manda un aviso de prueba por los destinos configurados (ALERT_EMAIL / ALERT_WHATSAPP) a través del flujo de n8n. 409 si las alertas están desactivadas.',
    },
  }, async (_req, reply) => {
    const cfg = readAlertConfig();
    if (!alertsEnabled(cfg)) {
      return reply.code(409).send({
        error: 'alertas desactivadas: define N8N_BASE_URL, N8N_NOTIFICATION_PATH y ALERT_EMAIL o ALERT_WHATSAPP',
      });
    }
    const delivered = await sendAlert('[Tamaya] Prueba de alertas', ['Si recibes este aviso, las alertas de Tamaya funcionan.'], cfg);
    return { delivered, email: Boolean(cfg.email), whatsapp: Boolean(cfg.phone) };
  });

  // GET /ops/health — salud de las dependencias.
  app.get('/health', {
    schema: {
      summary: 'Salud de las dependencias',
      description: 'Comprueba base de datos, Redis, control server y heartbeat del publicador.',
      response: {
        200: z.object({
          ok: z.boolean(), db: z.boolean(), redis: z.boolean(),
          controlServer: z.boolean(), publisherOnline: z.boolean(), ts: z.string(),
        }),
      },
    },
  }, async () => {
    let dbOk = false;
    let redisOk = false;
    try {
      await db.execute(sql`select 1`);
      dbOk = true;
    } catch {
      /* dbOk false */
    }
    try {
      await publishQueue.getJobCounts('waiting');
      redisOk = true;
    } catch {
      /* redisOk false */
    }
    const controlServer = await controlServerHealth();
    const { online: publisherOnline } = await readHeartbeat('worker.publish.heartbeat');
    return {
      ok: dbOk && redisOk,
      db: dbOk,
      redis: redisOk,
      controlServer,
      publisherOnline,
      ts: new Date().toISOString(),
    };
  });
}
