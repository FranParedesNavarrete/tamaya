/**
 * Flujo de login (escaneo de QR).
 *
 * Abre el navegador NO headless, navega a web.whatsapp.com, espera a que el
 * usuario escanee el QR desde su móvil y, al detectar la barra lateral de
 * chats (appReadyMarker), guarda el storageState.
 *
 * Tras este paso, publish-text y publish-media reutilizan la sesión sin QR.
 */
import { launchBrowser, openContext, saveSession } from '../browser/session.js';
import { SELECTORS } from '../browser/selectors.js';
import { audit } from '../db/client.js';
import { logger } from '../logger.js';

export async function runLogin(): Promise<void> {
  const browser = await launchBrowser();
  try {
    const context = await openContext(browser);
    const page = await context.newPage();

    logger.info('navigating to WhatsApp Web...');
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

    logger.info('waiting for login — scan the QR code with your phone');
    // Esperamos a que aparezca el marcador de app cargada. Timeout generoso (5 min).
    await page.waitForSelector(SELECTORS.appReadyMarker, { timeout: 5 * 60 * 1000 });

    logger.info('login detected — saving session');
    await saveSession(context);
    audit('system', 'login_success');
  } finally {
    await browser.close();
  }
}
