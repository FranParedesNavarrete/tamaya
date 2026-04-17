#!/usr/bin/env node
/**
 * CLI: `npm run inspect`
 *
 * Abre Chromium NO headless con la sesión cargada y se queda esperando
 * indefinidamente. Útil para:
 *  - Navegar manualmente a un canal y ver qué selectores funcionan de verdad.
 *  - Usar Playwright Inspector si se lanza con PWDEBUG=1.
 *  - Imprimir el DOM de partes concretas mediante `--dump <selector>`.
 *
 * Cierra con Ctrl+C.
 *
 * Ejemplos:
 *   npm run inspect
 *   npm run inspect -- --dump 'button[aria-label*="Canales" i]'
 *   PWDEBUG=1 npm run inspect     # Abre el inspector de Playwright
 */
import { parseArgs } from 'node:util';
import { launchPersistentContextForTenant, sessionExists } from '../browser/session.js';
import { logger } from '../logger.js';

const { values } = parseArgs({
  options: {
    dump: { type: 'string', short: 'd' },
    url: { type: 'string', short: 'u' },
  },
});

async function main(): Promise<void> {
  if (!sessionExists()) {
    logger.error('no session — run `npm run login` first');
    process.exit(1);
  }

  const context = await launchPersistentContextForTenant();
  const page = context.pages()[0] ?? (await context.newPage());

  const url = values.url ?? 'https://web.whatsapp.com';
  logger.info({ url }, 'opening page');
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  if (values.dump) {
    // Esperar un poco a que la app cargue y dumpear el selector pedido
    await page.waitForTimeout(5000);
    const count = await page.locator(values.dump).count();
    logger.info({ selector: values.dump, count }, 'selector count');
    for (let i = 0; i < Math.min(count, 10); i++) {
      const el = page.locator(values.dump).nth(i);
      try {
        const aria = await el.getAttribute('aria-label');
        const role = await el.getAttribute('role');
        const title = await el.getAttribute('title');
        const text = (await el.innerText({ timeout: 1_000 }).catch(() => '')).slice(0, 80);
        logger.info({ idx: i, aria, role, title, text }, 'match');
      } catch (err) {
        logger.warn({ idx: i, err }, 'could not inspect element');
      }
    }
  }

  logger.info('browser open — navigate manually. Press Ctrl+C to exit.');
  // Mantener el proceso vivo
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      logger.info('closing...');
      resolve();
    });
  });

  await context.close();
}

main().catch((err) => {
  logger.error({ err }, 'inspect failed');
  process.exit(1);
});
