import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDb } from '@tamaya/db';
import { resolveQueue, publishQueue } from '../queue/bullmq.js';
import { getSetting } from '../settings/store.js';
import { controlFetch, ControlUnavailableError } from '../control-client.js';

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

/**
 * Endpoints de diagnóstico del pipeline. Todos protegidos por el guard de token
 * (van bajo /ops, que no está en la lista pública de auth.ts).
 */
export async function opsRoutes(app: FastifyInstance) {
  const db = getDb();

  // GET /ops/queues — conteos BullMQ de ambas colas.
  app.get('/queues', async () => {
    const [resolve, publish] = await Promise.all([
      queueCounts(resolveQueue),
      queueCounts(publishQueue),
    ]);
    return { resolve, publish };
  });

  // GET /ops/publisher — ¿por qué (no) se está publicando?
  app.get('/publisher', async () => {
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

  // GET /ops/health — salud de las dependencias.
  app.get('/health', async () => {
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
