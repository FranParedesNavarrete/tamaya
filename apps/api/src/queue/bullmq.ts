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
