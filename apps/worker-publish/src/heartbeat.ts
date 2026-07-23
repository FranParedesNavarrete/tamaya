import { hostname } from 'node:os';
import type { Logger } from 'pino';
import { getPool } from '@tamaya/db';

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
  const write = async (): Promise<void> => {
    try {
      const value = JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        updatedAt: new Date().toISOString(),
      });
      // Ver apps/api/src/settings/store.ts: en algunos RDS/MySQL antiguos los
      // prepared statements generados por Drizzle fallan de forma opaca. Para
      // este KV/heartbeat usamos mysql2.query() directo.
      await getPool().query(
        'INSERT INTO `app_settings` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
        [key, value],
      );
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), key }, 'heartbeat write failed');
    }
  };

  void write();
  const timer = setInterval(() => void write(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
