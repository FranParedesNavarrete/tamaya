import { z } from 'zod';

export const MediaSourceSchema = z.object({
  source: z.string().min(1),
});

export const CreateJobSchema = z.object({
  channelId: z.string().uuid(),
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
