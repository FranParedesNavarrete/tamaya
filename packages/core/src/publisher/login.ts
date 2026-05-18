/**
 * Flujo de login (escaneo de QR).
 *
 * Abre el navegador NO headless, navega a web.whatsapp.com, espera a que el
 * usuario escanee el QR desde su móvil y, al detectar la barra lateral de
 * chats (appReadyMarker), cierra el contexto (persiste automáticamente).
 *
 * Tras este paso, publish-text y publish-media reutilizan la sesión sin QR.
 */
import { launchPersistentContextForTenant } from '../browser/session.js';
import { SELECTORS } from '../browser/selectors.js';
import { waitForAny } from '../browser/dom-helpers.js';
import { audit } from '../db/client.js';
import { logger } from '../logger.js';

export async function runLogin(): Promise<void> {
  const context = await launchPersistentContextForTenant();
  try {
    const page = context.pages()[0] ?? (await context.newPage());

    logger.info('navigating to WhatsApp Web...');
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

    logger.info('waiting for login — scan the QR code with your phone');
    // Esperamos a que aparezca cualquiera de los marcadores de app cargada.
    // Timeout generoso (5 min) para que dé tiempo a escanear el QR.
    await waitForAny(page, SELECTORS.appReady, { timeout: 5 * 60 * 1000 });

    logger.info('login detected — session persisted in userDataDir');
    audit('system', 'login_success');
  } finally {
    await context.close();
  }
}
