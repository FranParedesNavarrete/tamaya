/**
 * Abre el Chromium con el perfil persistido y lo mantiene abierto hasta
 * que cierres la ventana manualmente.
 *
 * Casos de uso:
 *   - Cambiar el idioma de WhatsApp Web (Settings → Language).
 *   - Limpiar notificaciones / tips / banners que tapan selectores.
 *   - Echar un ojo al estado de la sesión o a un canal en vivo.
 *   - Debug visual cuando un job peta y quieres ver el DOM real.
 *
 * IMPORTANTE: para antes `pm2 stop tamaya-worker-publish` para no chocar
 * con el lock del userDataDir (Chromium no admite dos procesos sobre el
 * mismo perfil). Al terminar, `pm2 start tamaya-worker-publish`.
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

import { launchPersistentContextForTenant } from '@tamaya/core';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

async function main(): Promise<void> {
  logger.info('opening persistent context (debug mode)');
  const context = await launchPersistentContextForTenant();
  const page = context.pages()[0] ?? (await context.newPage());

  logger.info('navigating to WhatsApp Web...');
  await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

  logger.info('browser open — close the window (or Ctrl+C) when you are done');

  // Mantener el proceso vivo hasta que el contexto se cierre (usuario cierra ventana)
  // o hasta recibir SIGINT.
  await new Promise<void>((resolvePromise) => {
    const done = (): void => resolvePromise();
    context.once('close', done);
    process.once('SIGINT', () => {
      logger.info('SIGINT — closing browser');
      void context.close().finally(done);
    });
  });

  logger.info('browser closed — exit');
}

main().catch((err) => {
  logger.error({ err }, 'open failed');
  process.exit(1);
});
