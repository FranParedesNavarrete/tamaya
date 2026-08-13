import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

import { launchPersistentContextForTenant, waitForAppReady } from '@tamaya/core';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

async function main() {
  logger.info('opening persistent context for login');
  const context = await launchPersistentContextForTenant();
  const page = context.pages()[0] ?? (await context.newPage());

  logger.info('navigating to WhatsApp Web — scan the QR on screen');
  await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

  // Esperar a que la app esté logueada. Antes esto era un `#pane-side`
  // hardcodeado, que ignoraba los selectores/overrides configurados.
  await waitForAppReady(page, { timeout: 5 * 60 * 1000 });
  logger.info('login detected — session persisted in userDataDir');
  await context.close();
}

main().catch((err) => {
  logger.error({ err }, 'login failed');
  process.exit(1);
});
