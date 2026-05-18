import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

import { launchPersistentContextForTenant } from '@tamaya/core';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

async function main() {
  logger.info('opening persistent context for login');
  const context = await launchPersistentContextForTenant();
  const page = context.pages()[0] ?? (await context.newPage());

  logger.info('navigating to WhatsApp Web — scan the QR on screen');
  await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

  // Esperar a que aparezca la UI de app (marcador #pane-side)
  await page.waitForSelector('#pane-side', { timeout: 5 * 60 * 1000 });
  logger.info('login detected — session persisted in userDataDir');
  await context.close();
}

main().catch((err) => {
  logger.error({ err }, 'login failed');
  process.exit(1);
});
