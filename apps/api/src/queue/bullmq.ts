import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
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
  scheduledAt?: string;   // ISO; si viene, publish se retrasa hasta esa fecha
}

/**
 * Encola un job a la cola "resolve" INMEDIATAMENTE.
 * La fecha programada se aplica en publish-queue, no aquí: así la media queda
 * descargada/resuelta antes de la hora de publicación.
 */
export async function enqueueResolve(data: ResolveJobData): Promise<void> {
  await resolveQueue.add('resolve', data, {
    jobId: data.jobId,   // idempotencia
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
  const delay = data.scheduledAt
    ? Math.max(0, new Date(data.scheduledAt).getTime() - Date.now())
    : 0;
  await publishQueue.add('publish', data, {
    jobId: data.jobId,
    delay,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60_000,
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
}

/**
 * Reencola un job en publish-queue de forma manual (acción operativa).
 * Elimina primero cualquier job previo con el mismo id — si no, BullMQ ignora
 * el add por idempotencia (removeOnComplete/Fail conserva ids un tiempo).
 */
export async function requeuePublish(jobId: string): Promise<void> {
  try {
    await publishQueue.remove(jobId);
  } catch {
    // no existía o no se pudo quitar — seguimos, el add crea uno nuevo
  }
  await enqueuePublish({ jobId });
}

export async function closeQueue(): Promise<void> {
  await Promise.all([
    resolveQueue.close(),
    publishQueue.close(),
    connection.quit(),
  ]);
}
