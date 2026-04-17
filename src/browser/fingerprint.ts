/**
 * Huella de navegador consistente por tenant.
 *
 * IMPORTANTE: en Tamaya SaaS, la huella se deriva del tenant y NO cambia entre
 * envíos. Rotación = patrón de bot. Consistencia = patrón humano.
 */
import type { BrowserContextOptions } from 'playwright';
import { config } from '../config.js';

export function getBrowserContextOptions(): BrowserContextOptions {
  return {
    userAgent: config.fingerprint.userAgent,
    viewport: config.fingerprint.viewport,
    locale: config.fingerprint.locale,
    timezoneId: config.fingerprint.timezone,
    // Permisos típicos de WhatsApp Web (notifs, clipboard) — se piden en el onboarding
    // y se conceden de facto. Negarlos simula un usuario que rechazó, lo cual es común.
    permissions: [],
    // Importante: NO usar --disable-blink-features=AutomationControlled como flag "a lo bruto".
    // Playwright ya oculta la flag navigator.webdriver. Si se añaden más parches, hacerlo
    // de forma coherente y documentada en este fichero.
  };
}
