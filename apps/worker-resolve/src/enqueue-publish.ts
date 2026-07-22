import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
  maxRetriesPerRequest: null,
});
const publishQueue = new Queue('publish-queue', { connection });

export async function enqueuePublish(data: { jobId: string; scheduledAt?: string }): Promise<void> {
  const delay = data.scheduledAt
    ? Math.max(0, new Date(data.scheduledAt).getTime() - Date.now())
    : 0;
  await publishQueue.add('publish', data, {
    jobId: data.jobId,
    delay,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
}
