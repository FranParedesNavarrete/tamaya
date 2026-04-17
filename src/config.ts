/**
 * Tamaya — config loader
 *
 * Carga y valida la configuración desde variables de entorno (.env).
 * El resto del código importa `config` desde aquí — no se leen env vars directamente.
 */

import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  tenantId: z.string().min(1),
  sessionPath: z.string().min(1),

  fingerprint: z.object({
    userAgent: z.string().min(10),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    timezone: z.string().min(1),
    locale: z.string().min(2),
  }),

  playwright: z.object({
    headless: z.boolean(),
    slowMoMs: z.number().int().nonnegative(),
  }),

  rateLimit: z.object({
    minDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative(),
    sendWindowStart: z.string().regex(/^\d{2}:\d{2}$/),
    sendWindowEnd: z.string().regex(/^\d{2}:\d{2}$/),
  }),

  dbPath: z.string().min(1),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
});

export type Config = z.infer<typeof configSchema>;

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function parseIntEnv(v: string | undefined, fallback: number): number {
  const n = v === undefined ? fallback : parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer env value: ${v}`);
  return n;
}

export const config: Config = configSchema.parse({
  tenantId: process.env.TAMAYA_TENANT_ID ?? 'default',
  sessionPath: process.env.TAMAYA_SESSION_PATH ?? './sessions/default.json',

  fingerprint: {
    userAgent:
      process.env.TAMAYA_USER_AGENT ??
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    viewport: {
      width: parseIntEnv(process.env.TAMAYA_VIEWPORT_WIDTH, 1440),
      height: parseIntEnv(process.env.TAMAYA_VIEWPORT_HEIGHT, 900),
    },
    timezone: process.env.TAMAYA_TIMEZONE ?? 'Europe/Madrid',
    locale: process.env.TAMAYA_LOCALE ?? 'es-ES',
  },

  playwright: {
    headless: parseBool(process.env.TAMAYA_HEADLESS, false),
    slowMoMs: parseIntEnv(process.env.TAMAYA_SLOWMO_MS, 150),
  },

  rateLimit: {
    minDelayMs: parseIntEnv(process.env.TAMAYA_MIN_DELAY_MS, 30_000),
    maxDelayMs: parseIntEnv(process.env.TAMAYA_MAX_DELAY_MS, 180_000),
    sendWindowStart: process.env.TAMAYA_SEND_WINDOW_START ?? '09:00',
    sendWindowEnd: process.env.TAMAYA_SEND_WINDOW_END ?? '22:00',
  },

  dbPath: process.env.TAMAYA_DB_PATH ?? './tamaya.db',
  logLevel:
    (process.env.LOG_LEVEL as Config['logLevel']) ?? 'info',
});
