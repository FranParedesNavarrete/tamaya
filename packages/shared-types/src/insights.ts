import { z } from 'zod';

/**
 * Estadísticas de canal ("Estadísticas" en WhatsApp Web: Alcance / Crecimiento
 * / Seguidores). Estos tipos son el contrato entre:
 *   - `packages/core` (los produce leyendo el DOM vía Playwright),
 *   - `packages/db` (los persiste como JSON en `channel_insights_snapshots`,
 *     sin depender de Playwright — de ahí que vivan en `shared-types`),
 *   - `apps/api` (los sirve tal cual).
 *
 * WA abrevia los números grandes ("2,7 mil") y redondea al hacerlo — por eso
 * cada métrica lleva `exact` y el texto original (ver `parseWaNumber` en
 * `@tamaya/core`).
 */
export const MetricSchema = z.object({
  value: z.number().nullable(),
  exact: z.boolean(),
  raw: z.string(),
});
export type Metric = z.infer<typeof MetricSchema>;

export const ReachSegmentSchema = z.object({
  label: z.string(),
  count: MetricSchema,
  percent: z.number().nullable(),
});
export type ReachSegment = z.infer<typeof ReachSegmentSchema>;

export const BarChartRowSchema = z.object({
  label: z.string(),
  value: MetricSchema,
  percent: z.number().nullable(),
});
export type BarChartRow = z.infer<typeof BarChartRowSchema>;

export const ChannelReachSchema = z.object({
  accountsReached: MetricSchema,
  segments: z.array(ReachSegmentSchema),
  topRegions: z.array(BarChartRowSchema),
});
export type ChannelReach = z.infer<typeof ChannelReachSchema>;

/** Pestaña Crecimiento: netos nuevos / nuevos seguidores / bajas, en la ventana del periodo. */
export const ChannelGrowthItemSchema = z.object({
  label: z.string(),
  value: MetricSchema,
});
export type ChannelGrowthItem = z.infer<typeof ChannelGrowthItemSchema>;

export const ChannelGrowthSchema = z.object({
  items: z.array(ChannelGrowthItemSchema),
});
export type ChannelGrowth = z.infer<typeof ChannelGrowthSchema>;

/** Pestaña Seguidores: total + variación, y desglose por región (igual patrón que Alcance). */
export const ChannelFollowersSchema = z.object({
  total: MetricSchema,
  deltaPercent: z.number().nullable(),
  periodLabel: z.string().nullable(),
  topRegions: z.array(BarChartRowSchema),
});
export type ChannelFollowers = z.infer<typeof ChannelFollowersSchema>;

export const InsightsDateRangeSchema = z.object({
  label: z.string().nullable(),
  range: z.string().nullable(),
});
export type InsightsDateRange = z.infer<typeof InsightsDateRangeSchema>;

export const ChannelInsightsSchema = z.object({
  dateRange: InsightsDateRangeSchema,
  reach: ChannelReachSchema.nullable(),
  growth: ChannelGrowthSchema.nullable(),
  followers: ChannelFollowersSchema.nullable(),
  /** Pestañas presentes en el panel, por si WA añade o quita alguna. */
  tabsAvailable: z.array(z.string()),
  readAt: z.string(),
});
export type ChannelInsights = z.infer<typeof ChannelInsightsSchema>;

/** Configuración de captura automática programada (app_settings: 'insights.autoCapture'). */
export const InsightsAutoCaptureConfigSchema = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  /** Fecha (YYYY-MM-DD, Europe/Madrid) del último disparo — evita repetir en el mismo día. */
  lastRunDate: z.string().nullable(),
});
export type InsightsAutoCaptureConfig = z.infer<typeof InsightsAutoCaptureConfigSchema>;

export const DEFAULT_INSIGHTS_AUTO_CAPTURE_CONFIG: InsightsAutoCaptureConfig = {
  enabled: false,
  hour: 3,
  minute: 0,
  lastRunDate: null,
};

/** Resultado de una captura (uno o varios canales) devuelto por control-server. */
export const InsightsCaptureResultItemSchema = z.object({
  channelId: z.string(),
  channelName: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type InsightsCaptureResultItem = z.infer<typeof InsightsCaptureResultItemSchema>;

export const InsightsCaptureResponseSchema = z.object({
  ok: z.boolean(),
  results: z.array(InsightsCaptureResultItemSchema),
  error: z.string().optional(),
});
export type InsightsCaptureResponse = z.infer<typeof InsightsCaptureResponseSchema>;
