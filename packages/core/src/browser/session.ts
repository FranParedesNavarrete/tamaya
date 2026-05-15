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

export async function launchPersistentContextForTenant(): Promise<BrowserContext> {
  mkdirSync(config.userDataDir, { recursive: true });

  const options = getBrowserContextOptions();
  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless: config.playwright.headless,
    slowMo: config.playwright.slowMoMs,
    args: ['--disable-blink-features=AutomationControlled'],
    // Fingerprint coherente por tenant (viewport, locale, timezone, UA)
    viewport: options.viewport,
    locale: options.locale,
    timezoneId: options.timezoneId,
    userAgent: options.userAgent,
  });

  logger.info({ userDataDir: config.userDataDir }, 'persistent context opened');
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
