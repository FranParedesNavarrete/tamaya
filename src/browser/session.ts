/**
 * Gestión de sesión persistente de WhatsApp Web.
 *
 * En el PoC la sesión vive como JSON plaintext en disco (carpeta `sessions/`).
 * En v1 (Tamaya SaaS) esto se reemplaza por almacenamiento cifrado con KMS.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getBrowserContextOptions } from './fingerprint.js';

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: config.playwright.headless,
    slowMo: config.playwright.slowMoMs,
    args: [
      // Estos flags reducen el ruido típico de Playwright en Chromium.
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

/**
 * Abre un contexto cargando el storageState si existe.
 * Si no existe, crea un contexto vacío — para el flujo de login inicial.
 */
export async function openContext(browser: Browser): Promise<BrowserContext> {
  const options = getBrowserContextOptions();
  const hasSession = existsSync(config.sessionPath);

  if (hasSession) {
    logger.info({ path: config.sessionPath }, 'loading session');
    return browser.newContext({ ...options, storageState: config.sessionPath });
  }
  logger.info('no session found — starting fresh (expect QR)');
  return browser.newContext(options);
}

export async function saveSession(context: BrowserContext): Promise<void> {
  const dir = dirname(config.sessionPath);
  mkdirSync(dir, { recursive: true });
  await context.storageState({ path: config.sessionPath });
  logger.info({ path: config.sessionPath }, 'session saved');
}

export function sessionExists(): boolean {
  return existsSync(config.sessionPath);
}

/** Lee el storageState como objeto (útil para tests / debug). */
export function readSession(): unknown | null {
  if (!existsSync(config.sessionPath)) return null;
  return JSON.parse(readFileSync(config.sessionPath, 'utf-8'));
}

export function writeSessionRaw(raw: string): void {
  writeFileSync(config.sessionPath, raw, 'utf-8');
}
