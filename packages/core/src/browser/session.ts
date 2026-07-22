/**
 * Gestión de contexto persistente de WhatsApp Web.
 *
 * Usamos `launchPersistentContext` (no `launch` + `newContext`) porque
 * WhatsApp Web guarda sus tokens en IndexedDB, que storageState NO captura.
 * El perfil persistente guarda el userDataDir completo de Chromium.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getBrowserContextOptions } from './fingerprint.js';
import { acquireProfileLock, releaseProfileLock, type ProfileLockOwner } from './profile-lock.js';

/**
 * Abre el contexto persistente adquiriendo antes el lock de perfil. El lock se
 * libera automáticamente cuando se cierra el contexto (evento `close`).
 *
 * `owner` identifica quién abre (control-server / worker-publish / cli) para
 * dar mensajes claros si el perfil está ocupado.
 */
export async function launchPersistentContextForTenant(
  owner: ProfileLockOwner = 'worker-publish',
): Promise<BrowserContext> {
  mkdirSync(config.userDataDir, { recursive: true });

  // Lanza ProfileLockedError si otro proceso vivo tiene el perfil.
  acquireProfileLock(owner);

  const options = getBrowserContextOptions();
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.userDataDir, {
      headless: config.playwright.headless,
      slowMo: config.playwright.slowMoMs,
      args: ['--disable-blink-features=AutomationControlled'],
      // Fingerprint coherente por tenant (viewport, locale, timezone, UA)
      viewport: options.viewport,
      locale: options.locale,
      timezoneId: options.timezoneId,
      userAgent: options.userAgent,
    });
  } catch (err) {
    // Si Chromium no llega a abrir, no dejamos el lock colgado.
    releaseProfileLock();
    throw err;
  }

  // Liberar el lock cuando el contexto se cierre (finally de publishers,
  // cleanup del control-server, o cierre manual).
  context.once('close', () => releaseProfileLock());

  logger.info({ userDataDir: config.userDataDir, owner }, 'persistent context opened');
  return context;
}

/**
 * Heurística: consideramos que hay sesión si el userDataDir existe Y contiene
 * el archivo de IndexedDB de WhatsApp. No es 100% fiable (el perfil podría
 * estar corrupto), pero sirve como pre-check antes de lanzar el navegador.
 */
export function sessionExists(): boolean {
  if (!existsSync(config.userDataDir)) return false;
  // Chromium crea IndexedDB en Default/IndexedDB/... — basta con que exista el dir Default
  return existsSync(`${config.userDataDir}/Default`);
}

/**
 * Borra completamente el perfil (reset total — obliga a volver a escanear QR).
 * Útil para tests o si la sesión se corrompe.
 */
export function wipeSession(): void {
  if (existsSync(config.userDataDir)) {
    rmSync(config.userDataDir, { recursive: true, force: true });
    logger.info({ userDataDir: config.userDataDir }, 'session wiped');
  }
}
