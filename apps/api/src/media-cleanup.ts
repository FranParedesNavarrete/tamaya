/**
 * Limpieza de la media descargada (TAMAYA_TMP_DIR).
 *
 * La URL original de la imagen caduca a los pocos minutos, así que el fichero
 * local es la única copia: por eso el directorio debe ser PERSISTENTE (no /tmp,
 * que se vacía al reiniciar) y por eso la limpieza es conservadora:
 *
 *  - Solo borra ficheros con más de TAMAYA_MEDIA_TTL_DAYS días (por mtime).
 *  - Nunca borra la media de un job pendiente de publicarse
 *    (pending / resolving / ready / publishing), aunque esté fuera del TTL.
 *  - Sin TAMAYA_MEDIA_TTL_DAYS (o <= 0) no se borra nada.
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import pino from 'pino';
import { and, inArray, isNull } from 'drizzle-orm';
import { getDb, schema } from '@tamaya/db';
import type { JobMedia } from '@tamaya/db';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const RUN_EVERY_MS = 6 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 60_000;

export interface ExpiredFile { path: string; sizeBytes: number }

/** Ficheros sueltos del directorio más antiguos que el TTL y no protegidos. */
export async function findExpiredFiles(
  dir: string,
  ttlMs: number,
  protectedPaths: Set<string>,
  now: number = Date.now(),
): Promise<ExpiredFile[]> {
  const out: ExpiredFile[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (!s.isFile()) continue;
      if (now - s.mtimeMs < ttlMs) continue;
      if (protectedPaths.has(path)) continue;
      out.push({ path, sizeBytes: s.size });
    } catch {
      /* desapareció entre readdir y stat */
    }
  }
  return out;
}

async function activeMediaPaths(): Promise<Set<string>> {
  const rows = await getDb().select({ media: schema.jobs.media }).from(schema.jobs).where(and(
    inArray(schema.jobs.status, ['pending', 'resolving', 'ready', 'publishing']),
    isNull(schema.jobs.deletedAt),
  ));
  const paths = new Set<string>();
  for (const r of rows) {
    for (const m of (r.media ?? []) as JobMedia[]) {
      if (m.localPath) paths.add(m.localPath);
    }
  }
  return paths;
}

export async function runMediaCleanup(dir: string, ttlDays: number): Promise<void> {
  const expired = await findExpiredFiles(dir, ttlDays * 24 * 60 * 60_000, await activeMediaPaths());
  let freed = 0;
  let deleted = 0;
  for (const f of expired) {
    try {
      await unlink(f.path);
      freed += f.sizeBytes;
      deleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ path: f.path, err: err instanceof Error ? err.message : String(err) }, 'media cleanup: no se pudo borrar');
      }
    }
  }
  logger.info({ dir, ttlDays, deleted, freedBytes: freed }, 'media cleanup: terminado');
}

/** Arranca la limpieza periódica. Devuelve la función de parada. */
export function startMediaCleanup(): () => void {
  const ttlDays = Number(process.env.TAMAYA_MEDIA_TTL_DAYS);
  const dir = process.env.TAMAYA_TMP_DIR;
  if (!dir || !(ttlDays > 0)) {
    logger.info('media cleanup desactivado (define TAMAYA_MEDIA_TTL_DAYS > 0 para activarlo)');
    return () => {};
  }
  const run = () => {
    runMediaCleanup(dir, ttlDays).catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'media cleanup: fallo');
    });
  };
  const first = setTimeout(run, FIRST_RUN_DELAY_MS);
  const interval = setInterval(run, RUN_EVERY_MS);
  logger.info({ dir, ttlDays }, 'media cleanup scheduler started');
  return () => { clearTimeout(first); clearInterval(interval); };
}
