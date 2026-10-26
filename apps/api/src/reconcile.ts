/**
 * Reconciliador de jobs: BD y colas de Redis pueden desincronizarse (Redis sin
 * persistencia reiniciado, caída del servidor, worker muerto a mitad de envío).
 * Cada minuto compara los jobs "vivos" de la BD con lo que hay en las colas y
 * repara lo que se haya perdido:
 *
 *  - ready sin job en publish-queue    → se vuelve a encolar (se había perdido).
 *  - pending/resolving sin job en resolve-queue → se vuelve a encolar la resolución.
 *  - publishing sin job en publish-queue → el worker murió durante el envío:
 *    se marca failed y NO se reintenta (ya se pudo pulsar Enviar; reintentar
 *    duplicaría el post). El vigilante de alertas avisa de los failed.
 *
 * Los umbrales de inactividad evitan pisar a un job que justo está cambiando de
 * estado (p. ej. resolve acaba de pasarlo a ready y aún no lo ha encolado).
 */
import pino from 'pino';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import { publishQueue, resolveQueue, enqueuePublish, enqueueResolve } from './queue/bullmq.js';
import { alertsEnabled, readAlertConfig, sendAlert } from './alerts/notify.js';
import { fmtMadrid } from './alerts/format.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const FIRST_RUN_DELAY_MS = 30_000;
const RUN_EVERY_MS = 60_000;
const READY_IDLE_MS = 2 * 60_000;
const PUBLISHING_IDLE_MS = 5 * 60_000;
const RESOLVE_IDLE_MS = 10 * 60_000;
/** Estados de BullMQ en los que un job sigue "vivo" (se ejecutará o se está ejecutando). */
const LIVE_STATES = ['waiting', 'delayed', 'active', 'prioritized', 'paused'] as const;

export const INTERRUPTED_ERROR =
  'INTERRUPTED: el worker se detuvo durante el envío; puede haberse publicado. No se reintentó para evitar duplicados.';

export interface ReconcileRow {
  id: string;
  status: string;
  scheduledAt: Date;
  updatedAt: Date;
  channelName: string;
}

export interface ReconcilePlan {
  requeuePublish: ReconcileRow[];
  requeueResolve: ReconcileRow[];
  interrupted: ReconcileRow[];
}

/** Decisión pura: qué jobs hay que reparar dado lo que está vivo en cada cola. */
export function planReconcile(
  rows: ReconcileRow[],
  publishLive: Set<string>,
  resolveLive: Set<string>,
  now: number,
): ReconcilePlan {
  const plan: ReconcilePlan = { requeuePublish: [], requeueResolve: [], interrupted: [] };
  for (const r of rows) {
    const idleMs = now - r.updatedAt.getTime();
    if (r.status === 'ready' && !publishLive.has(r.id) && idleMs > READY_IDLE_MS) {
      plan.requeuePublish.push(r);
    } else if (r.status === 'publishing' && !publishLive.has(r.id) && idleMs > PUBLISHING_IDLE_MS) {
      plan.interrupted.push(r);
    } else if ((r.status === 'pending' || r.status === 'resolving') && !resolveLive.has(r.id) && idleMs > RESOLVE_IDLE_MS) {
      plan.requeueResolve.push(r);
    }
  }
  return plan;
}

async function liveJobIds(queue: typeof publishQueue): Promise<Set<string>> {
  const jobs = await queue.getJobs([...LIVE_STATES], 0, -1);
  const ids = new Set<string>();
  for (const j of jobs) {
    const id = (j?.data as { jobId?: string } | undefined)?.jobId;
    if (id) ids.add(id);
  }
  return ids;
}

let running = false;

export async function runReconcile(now: number = Date.now()): Promise<ReconcilePlan | null> {
  if (running) return null;
  running = true;
  try {
    const db = getDb();
    const rows = await db.select({
      id: schema.jobs.id,
      status: schema.jobs.status,
      scheduledAt: schema.jobs.scheduledAt,
      updatedAt: schema.jobs.updatedAt,
      channelName: schema.jobs.channelName,
    }).from(schema.jobs).where(and(
      inArray(schema.jobs.status, ['pending', 'resolving', 'ready', 'publishing']),
      isNull(schema.jobs.deletedAt),
    ));
    if (rows.length === 0) return { requeuePublish: [], requeueResolve: [], interrupted: [] };

    // Si Redis no responde, getJobs lanza y no tocamos nada.
    const [publishLive, resolveLive] = await Promise.all([liveJobIds(publishQueue), liveJobIds(resolveQueue)]);
    const plan = planReconcile(rows, publishLive, resolveLive, now);

    for (const r of plan.requeuePublish) {
      await publishQueue.remove(r.id).catch(() => undefined);
      await enqueuePublish({ jobId: r.id, scheduledAt: r.scheduledAt.toISOString() });
      logger.warn({ jobId: r.id, channel: r.channelName }, 'reconcile: job ready ausente de publish-queue, reencolado');
    }
    for (const r of plan.requeueResolve) {
      await resolveQueue.remove(r.id).catch(() => undefined);
      await enqueueResolve({ jobId: r.id, scheduledAt: r.scheduledAt.toISOString() });
      logger.warn({ jobId: r.id, channel: r.channelName, status: r.status }, 'reconcile: job sin resolve-queue, reencolada la resolución');
    }
    for (const r of plan.interrupted) {
      await db.update(schema.jobs).set({ status: 'failed', lastError: INTERRUPTED_ERROR })
        .where(and(eq(schema.jobs.id, r.id), eq(schema.jobs.status, 'publishing'), isNull(schema.jobs.deletedAt)));
      logger.warn({ jobId: r.id, channel: r.channelName }, 'reconcile: job publishing sin worker, marcado failed (sin reintento)');
    }

    // Los interrumpidos ya salen en el aviso de "fallidos"; aquí solo lo recuperado.
    const recovered = [...plan.requeuePublish, ...plan.requeueResolve];
    if (recovered.length > 0 && alertsEnabled(readAlertConfig())) {
      await sendAlert(`[Tamaya] ${recovered.length} job(s) recuperado(s) tras una caída`, [
        'Estos jobs se habían perdido de la cola y se han vuelto a encolar:',
        ...recovered.map((r) => `• ${r.channelName} — programado ${fmtMadrid(r.scheduledAt)} — estaba ${r.status}`),
      ]);
    }
    return plan;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'reconcile: fallo (se reintentará)');
    return null;
  } finally {
    running = false;
  }
}

/** Arranca el reconciliador. Devuelve la función de parada. */
export function startReconciler(): () => void {
  const first = setTimeout(() => { void runReconcile(); }, FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => { void runReconcile(); }, RUN_EVERY_MS);
  logger.info({ everySec: RUN_EVERY_MS / 1000 }, 'job reconciler started');
  return () => { clearTimeout(first); clearInterval(interval); };
}
