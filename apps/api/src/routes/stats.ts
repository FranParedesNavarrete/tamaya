import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';

const TENANT = 'default';

/**
 * Endpoints agregados para el dashboard. Todas las queries ejecutan GROUP BY
 * en la propia DB — evitamos traer listas largas al cliente.
 */
export async function statsRoutes(app: FastifyInstance) {
  const a = app.withTypeProvider<ZodTypeProvider>();
  const db = getDb();

  const rangeSchema = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    channelId: z.string().uuid().optional(),
  });

  function baseConditions(q: z.infer<typeof rangeSchema>): SQL[] {
    const conds: SQL[] = [eq(schema.jobs.tenantId, TENANT)];
    if (q.from) conds.push(gte(schema.jobs.scheduledAt, new Date(q.from)));
    if (q.to) conds.push(lte(schema.jobs.scheduledAt, new Date(q.to)));
    if (q.channelId) conds.push(eq(schema.jobs.channelId, q.channelId));
    return conds;
  }

  // GET /stats/summary — métricas globales
  a.get('/summary', { schema: { querystring: rangeSchema } }, async (req) => {
    const conds = baseConditions(req.query);

    const rows = await db
      .select({
        total: sql<number>`count(*)`,
        sent: sql<number>`sum(case when ${schema.jobs.status} = 'sent' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${schema.jobs.status} = 'failed' then 1 else 0 end)`,
        pending: sql<number>`sum(case when ${schema.jobs.status} = 'pending' then 1 else 0 end)`,
        publishing: sql<number>`sum(case when ${schema.jobs.status} in ('publishing', 'resolving', 'ready') then 1 else 0 end)`,
        cancelled: sql<number>`sum(case when ${schema.jobs.status} = 'cancelled' then 1 else 0 end)`,
        avgDurationMs: sql<number>`avg(case when ${schema.jobs.status} = 'sent' then ${schema.jobs.durationMs} end)`,
        totalAttempts: sql<number>`sum(${schema.jobs.attemptCount})`,
      })
      .from(schema.jobs)
      .where(and(...conds));

    const r = rows[0];
    const total = Number(r.total ?? 0);
    const sent = Number(r.sent ?? 0);
    const failed = Number(r.failed ?? 0);
    return {
      total,
      sent,
      failed,
      pending: Number(r.pending ?? 0),
      publishing: Number(r.publishing ?? 0),
      cancelled: Number(r.cancelled ?? 0),
      avgDurationMs: r.avgDurationMs ? Number(r.avgDurationMs) : null,
      totalAttempts: Number(r.totalAttempts ?? 0),
      successRate: total > 0 ? sent / (sent + failed || 1) : 0,
    };
  });

  // GET /stats/by-status — conteo por status (para pie chart)
  a.get('/by-status', { schema: { querystring: rangeSchema } }, async (req) => {
    const conds = baseConditions(req.query);
    const rows = await db
      .select({
        status: schema.jobs.status,
        count: sql<number>`count(*)`,
      })
      .from(schema.jobs)
      .where(and(...conds))
      .groupBy(schema.jobs.status);

    return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
  });

  // GET /stats/by-channel — top canales
  a.get('/by-channel', { schema: { querystring: rangeSchema } }, async (req) => {
    const conds = baseConditions(req.query);
    const rows = await db
      .select({
        channelId: schema.jobs.channelId,
        channelName: schema.jobs.channelName,
        total: sql<number>`count(*)`,
        sent: sql<number>`sum(case when ${schema.jobs.status} = 'sent' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${schema.jobs.status} = 'failed' then 1 else 0 end)`,
      })
      .from(schema.jobs)
      .where(and(...conds))
      .groupBy(schema.jobs.channelId, schema.jobs.channelName)
      .orderBy(sql`count(*) desc`)
      .limit(20);

    return rows.map((r) => ({
      channelId: r.channelId,
      channelName: r.channelName,
      total: Number(r.total),
      sent: Number(r.sent),
      failed: Number(r.failed),
    }));
  });

  // GET /stats/timeline — serie temporal por día (sent / failed / cancelled)
  a.get('/timeline', {
    schema: {
      querystring: rangeSchema.extend({
        granularity: z.enum(['hour', 'day', 'week']).default('day'),
      }),
    },
  }, async (req) => {
    const conds = baseConditions(req.query);
    const { granularity } = req.query;

    const fmt =
      granularity === 'hour' ? '%Y-%m-%d %H:00:00'
      : granularity === 'week' ? '%x-W%v'
      : '%Y-%m-%d';

    const rows = await db
      .select({
        bucket: sql<string>`date_format(${schema.jobs.scheduledAt}, ${fmt})`,
        status: schema.jobs.status,
        count: sql<number>`count(*)`,
      })
      .from(schema.jobs)
      .where(and(...conds))
      .groupBy(sql`date_format(${schema.jobs.scheduledAt}, ${fmt})`, schema.jobs.status)
      .orderBy(sql`date_format(${schema.jobs.scheduledAt}, ${fmt})`);

    // Pivot para el cliente: un objeto por bucket con contadores por status.
    type TimelinePoint = {
      bucket: string;
      sent: number;
      failed: number;
      pending: number;
      cancelled: number;
      publishing: number;
    };
    const byBucket = new Map<string, TimelinePoint>();
    for (const r of rows) {
      const key = r.bucket;
      if (!byBucket.has(key)) {
        byBucket.set(key, { bucket: key, sent: 0, failed: 0, pending: 0, cancelled: 0, publishing: 0 });
      }
      const slot = byBucket.get(key)!;
      const status = r.status as string;
      const count = Number(r.count);
      if (status === 'resolving' || status === 'ready' || status === 'publishing') {
        slot.publishing += count;
      } else if (status === 'sent' || status === 'failed' || status === 'pending' || status === 'cancelled') {
        slot[status] += count;
      }
    }
    return Array.from(byBucket.values());
  });

  // GET /stats/media-types — counts por tipo: text-only / image / video
  a.get('/media-types', { schema: { querystring: rangeSchema } }, async (req) => {
    const conds = baseConditions(req.query);
    const rows = await db
      .select({ media: schema.jobs.media, count: sql<number>`count(*)` })
      .from(schema.jobs)
      .where(and(...conds))
      .groupBy(schema.jobs.media);

    // El field `media` es JSON — lo clasificamos en JS.
    const buckets = { textOnly: 0, image: 0, video: 0, mixed: 0, other: 0 };
    for (const r of rows) {
      const media = (r.media ?? []) as Array<{ source: string; mime?: string }>;
      const count = Number(r.count);
      if (media.length === 0) {
        buckets.textOnly += count;
        continue;
      }
      const kinds = new Set(media.map((m) => {
        const mime = m.mime ?? '';
        if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(m.source)) return 'image';
        if (mime.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v|3gp)$/i.test(m.source)) return 'video';
        return 'other';
      }));
      if (kinds.size === 1) {
        const k = kinds.values().next().value!;
        if (k === 'image') buckets.image += count;
        else if (k === 'video') buckets.video += count;
        else buckets.other += count;
      } else {
        buckets.mixed += count;
      }
    }
    return buckets;
  });

  // GET /stats/hourly-heatmap — jobs por día-de-semana y hora
  a.get('/hourly-heatmap', { schema: { querystring: rangeSchema } }, async (req) => {
    const conds = baseConditions(req.query);
    const rows = await db
      .select({
        dow: sql<number>`dayofweek(${schema.jobs.scheduledAt})`,   // 1=Sun..7=Sat
        hour: sql<number>`hour(${schema.jobs.scheduledAt})`,
        count: sql<number>`count(*)`,
      })
      .from(schema.jobs)
      .where(and(...conds))
      .groupBy(
        sql`dayofweek(${schema.jobs.scheduledAt})`,
        sql`hour(${schema.jobs.scheduledAt})`,
      );

    return rows.map((r) => ({
      dow: Number(r.dow),
      hour: Number(r.hour),
      count: Number(r.count),
    }));
  });

  // GET /stats/duration-distribution — buckets de latencia para jobs 'sent'
  a.get('/duration-distribution', { schema: { querystring: rangeSchema } }, async (req) => {
    const conds = [...baseConditions(req.query), eq(schema.jobs.status, 'sent')];
    const rows = await db
      .select({
        bucket: sql<string>`
          case
            when ${schema.jobs.durationMs} < 5000 then '<5s'
            when ${schema.jobs.durationMs} < 15000 then '5-15s'
            when ${schema.jobs.durationMs} < 30000 then '15-30s'
            when ${schema.jobs.durationMs} < 60000 then '30-60s'
            when ${schema.jobs.durationMs} < 120000 then '1-2m'
            when ${schema.jobs.durationMs} < 300000 then '2-5m'
            else '>5m'
          end
        `,
        count: sql<number>`count(*)`,
      })
      .from(schema.jobs)
      .where(and(...conds))
      .groupBy(sql`
        case
          when ${schema.jobs.durationMs} < 5000 then '<5s'
          when ${schema.jobs.durationMs} < 15000 then '5-15s'
          when ${schema.jobs.durationMs} < 30000 then '15-30s'
          when ${schema.jobs.durationMs} < 60000 then '30-60s'
          when ${schema.jobs.durationMs} < 120000 then '1-2m'
          when ${schema.jobs.durationMs} < 300000 then '2-5m'
          else '>5m'
        end
      `);

    return rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }));
  });

  // GET /stats/recent-failures — últimos errores (para panel de warnings)
  a.get('/recent-failures', {
    schema: {
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(50).default(10),
      }),
    },
  }, async (req) => {
    const rows = await db
      .select({
        id: schema.jobs.id,
        channelName: schema.jobs.channelName,
        text: schema.jobs.text,
        lastError: schema.jobs.lastError,
        scheduledAt: schema.jobs.scheduledAt,
        attemptCount: schema.jobs.attemptCount,
      })
      .from(schema.jobs)
      .where(and(
        eq(schema.jobs.tenantId, TENANT),
        eq(schema.jobs.status, 'failed'),
      ))
      .orderBy(sql`${schema.jobs.updatedAt} desc`)
      .limit(req.query.limit);

    return rows;
  });
}
