/**
 * Lock de perfil de Chromium.
 *
 * control-server y worker-publish comparten `TAMAYA_USER_DATA_DIR`, y Chromium
 * NO admite dos procesos sobre el mismo perfil. Este lock explícito da un error
 * claro (en vez de un crash oscuro de Chromium) cuando ambos intentan abrirlo.
 *
 * Reglas:
 *  - Antes de abrir Chromium se adquiere el lock.
 *  - Si existe un lock de OTRO owner con PID vivo → se lanza `ProfileLockedError`.
 *  - Si el lock es "stale" (PID muerto) o es del mismo proceso → se sobrescribe.
 *  - Al cerrar Chromium se libera el lock.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

export type ProfileLockOwner = 'control-server' | 'worker-publish' | 'cli';

export interface ProfileLockInfo {
  owner: ProfileLockOwner;
  pid: number;
  createdAt: string;
  updatedAt: string;
}

export class ProfileLockedError extends Error {
  info: ProfileLockInfo;
  constructor(info: ProfileLockInfo) {
    const ownerLabel = info.owner === 'control-server' ? 'control-server' : info.owner;
    super(
      `El perfil de WhatsApp está ocupado por ${ownerLabel} (pid ${info.pid}). ` +
        'Detén ese proceso antes de continuar (p.ej. la vinculación QR antes de publicar).',
    );
    this.name = 'ProfileLockedError';
    this.info = info;
  }
}

function lockPath(): string {
  return join(config.userDataDir, '.tamaya-profile.lock');
}

/** ¿El proceso con ese PID sigue vivo? */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no existe; EPERM → existe pero sin permisos (lo tratamos como vivo).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Lee el lock actual, o null si no existe / está corrupto. */
export function readProfileLock(): ProfileLockInfo | null {
  const p = lockPath();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as ProfileLockInfo;
    if (typeof parsed?.pid === 'number' && typeof parsed?.owner === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Adquiere el lock para `owner`. Lanza `ProfileLockedError` si otro owner con
 * PID vivo lo tiene. Sobrescribe locks stale o del propio proceso.
 */
export function acquireProfileLock(owner: ProfileLockOwner): void {
  mkdirSync(config.userDataDir, { recursive: true });
  const existing = readProfileLock();

  if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
    // Lock vivo de otro proceso.
    if (existing.owner !== owner || existing.pid !== process.pid) {
      throw new ProfileLockedError(existing);
    }
  }

  const now = new Date().toISOString();
  const info: ProfileLockInfo = {
    owner,
    pid: process.pid,
    createdAt: existing && existing.pid === process.pid ? existing.createdAt : now,
    updatedAt: now,
  };
  writeFileSync(lockPath(), JSON.stringify(info, null, 2), 'utf8');
  logger.debug({ owner, pid: process.pid }, 'profile lock acquired');
}

/** Libera el lock SOLO si es de este proceso (no pisamos locks ajenos). */
export function releaseProfileLock(): void {
  const existing = readProfileLock();
  if (existing && existing.pid === process.pid) {
    try {
      rmSync(lockPath(), { force: true });
      logger.debug({ pid: process.pid }, 'profile lock released');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not release profile lock');
    }
  }
}
