/**
 * Vigilante de publicación: cada tick (por defecto 60s) revisa la BD y Redis y
 * avisa por n8n (ver `notify.ts`) de tres cosas:
 *
 *  1. Jobs que han acabado `failed` (no se publicaron tras agotar reintentos).
 *  2. Jobs atrasados: siguen pending/resolving/ready/publishing pasados
 *     ALERT_OVERDUE_MINUTES de su hora programada. Si están `ready`, se mira
 *     si siguen en `publish-queue`: si no están, se perdieron en Redis.
 *  3. Redis inalcanzable (2 ticks seguidos) y su recuperación.
 *
 * Cada job se avisa UNA vez por tipo (se recuerda en `app_settings`, clave
 * `alerts.state`, para que un reinicio de la API no repita avisos), y todo lo
 * nuevo de un tick va en un único mensaje para no inundar cuando cae la sesión
 * de WhatsApp y fallan varios jobs a la vez.
 */
import pino from 'pino';
import { and, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import { publishQueue } from '../queue/bullmq.js';
import { getSetting, setSetting } from '../settings/store.js';
import { alertsEnabled, readAlertConfig, sendAlert } from './notify.js';
import { fmtMadrid, hintForError, pruneNotified, type NotifiedMap } from './format.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const STATE_KEY = 'alerts.state';
/** Ventana en la que se buscan fallos recientes (cubre una caída de la API). */
const FAILED_WINDOW_MS = 6 * 60 * 60_000;
const REDIS_PROBE_TIMEOUT_MS = 5_000;
const ACTIVE_STATUSES = ['pending', 'resolving', 'ready', 'publishing'] as const;

async function loadNotified(): Promise<NotifiedMap> {
  try {
    const raw = await getSetting(STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { notified?: NotifiedMap };
    return parsed.notified ?? {};
  } catch {
    return {};
  }
}

async function saveNotified(map: NotifiedMap): Promise<void> {
  await setSetting(STATE_KEY, JSON.stringify({ notified: map }));
}

async function redisReachable(): Promise<boolean> {
  try {
    await Promise.race([
      publishQueue.getJobCounts('waiting'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), REDIS_PROBE_TIMEOUT_MS)),
    ]);
    return true;
  } catch {
    return false;
  }
}

let redisFailures = 0;
let redisAlerted = false;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const db = getDb();
    const now = Date.now();
    const overdueMin = Number(process.env.ALERT_OVERDUE_MINUTES) > 0 ? Number(process.env.ALERT_OVERDUE_MINUTES) : 10;
    const notified = pruneNotified(await loadNotified(), now);
    const lines: string[] = [];
    const newKeys: string[] = [];
    const subjectParts: string[] = [];

    // 3) Redis
    const redisOk = await redisReachable();
    if (!redisOk) {
      redisFailures += 1;
      if (redisFailures >= 2 && !redisAlerted) {
        lines.push('⚠ Redis no responde. Los jobs programados no se publicarán hasta que vuelva.');
        subjectParts.push('Redis caído');
        redisAlerted = true;
      }
    } else {
      if (redisAlerted) {
        lines.push('✔ Redis vuelve a responder.');
        subjectParts.push('Redis recuperado');
      }
      redisFailures = 0;
      redisAlerted = false;
    }

    // 1) Fallidos recientes
    const failed = await db.select().from(schema.jobs).where(and(
      eq(schema.jobs.status, 'failed'),
      isNull(schema.jobs.deletedAt),
      gte(schema.jobs.updatedAt, new Date(now - FAILED_WINDOW_MS)),
    ));
    const newFailed = failed.filter((j) => !notified[`failed:${j.id}`]);
    if (newFailed.length > 0) {
      subjectParts.push(`${newFailed.length} job(s) fallido(s)`);
      lines.push(`Jobs que no se han podido publicar (${newFailed.length}):`);
      const hints = new Set<string>();
      for (const j of newFailed) {
        lines.push(`• ${j.channelName} — programado ${fmtMadrid(j.scheduledAt)} — ${(j.lastError ?? 'sin detalle').slice(0, 180)}`);
        const hint = hintForError(j.lastError);
        if (hint) hints.add(hint);
        newKeys.push(`failed:${j.id}`);
      }
      hints.forEach((h) => lines.push(`→ ${h}`));
    }

    // 2) Atrasados (solo los que NO están ya como fallidos)
    const overdue = await db.select().from(schema.jobs).where(and(
      inArray(schema.jobs.status, [...ACTIVE_STATUSES]),
      isNull(schema.jobs.deletedAt),
      lt(schema.jobs.scheduledAt, new Date(now - overdueMin * 60_000)),
    ));
    const newOverdue = overdue.filter((j) => !notified[`overdue:${j.id}`]);
    if (newOverdue.length > 0) {
      subjectParts.push(`${newOverdue.length} job(s) atrasado(s)`);
      lines.push(`Jobs atrasados más de ${overdueMin} min sin publicarse (${newOverdue.length}):`);
      for (const j of newOverdue) {
        let extra = `estado ${j.status}`;
        if (j.status === 'ready' && redisOk) {
          try {
            const inQueue = await publishQueue.getJob(j.id);
            if (!inQueue) extra += ', NO está en la cola de Redis (se perdió; reencólalo)';
          } catch { /* sin Redis no podemos saberlo */ }
        }
        lines.push(`• ${j.channelName} — programado ${fmtMadrid(j.scheduledAt)} — ${extra}`);
        newKeys.push(`overdue:${j.id}`);
      }
    }

    if (lines.length === 0) return;

    const subject = `[Tamaya] ${subjectParts.join(' · ')}`;
    const delivered = await sendAlert(subject, lines);
    if (delivered) {
      for (const k of newKeys) notified[k] = now;
      await saveNotified(notified);
    } else {
      // No se marca como avisado: se reintenta en el siguiente tick.
      logger.warn({ pending: newKeys.length }, 'watchdog: alerta no entregada, se reintentará');
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'watchdog: fallo en el tick');
  } finally {
    running = false;
  }
}

/** Arranca el vigilante si hay destino configurado. Devuelve la función de parada. */
export function startAlertWatchdog(): () => void {
  const cfg = readAlertConfig();
  if (!alertsEnabled(cfg)) {
    logger.warn('alertas desactivadas: define N8N_BASE_URL, N8N_NOTIFICATION_PATH y ALERT_EMAIL o ALERT_WHATSAPP');
    return () => {};
  }
  const sec = Number(process.env.ALERT_CHECK_INTERVAL_SEC) >= 10 ? Number(process.env.ALERT_CHECK_INTERVAL_SEC) : 60;
  const interval = setInterval(() => { void tick(); }, sec * 1000);
  logger.info({ intervalSec: sec, email: Boolean(cfg.email), whatsapp: Boolean(cfg.phone) }, 'alert watchdog started');
  return () => clearInterval(interval);
}
