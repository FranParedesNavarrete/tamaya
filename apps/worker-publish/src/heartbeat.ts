import { hostname } from 'node:os';
import type { Logger } from 'pino';
import { getDb, schema } from '@tamaya/db';

/**
 * Heartbeat persistido en `app_settings`. Cada proceso nativo escribe
 * periódicamente su latido para que la API pueda inferir si está "online".
 *
 * Claves:
 *   - 'worker.publish.heartbeat'  → worker-publish
 *   - 'worker.control.heartbeat'  → control-server
 *
 * Robustez:
 *   - Nunca lanza: si la DB no está disponible, loguea warning y sigue.
 *   - El timer usa unref() para no impedir que el proceso termine.
 */
export function startHeartbeat(key: string, logger: Logger, intervalMs = 12_000): () => void {
  const db = getDb();
  const write = async (): Promise<void> => {
    try {
      const value = JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        updatedAt: new Date().toISOString(),
      });
      await db
        .insert(schema.appSettings)
        .values({ key, value })
        .onDuplicateKeyUpdate({ set: { value } });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), key }, 'heartbeat write failed');
    }
  };

  void write();
  const timer = setInterval(() => void write(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
