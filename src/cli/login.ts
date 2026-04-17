#!/usr/bin/env node
/**
 * CLI: `npm run login`
 *
 * Abre un Chromium NO headless, te deja escanear el QR y guarda la sesión.
 */
import { runLogin } from '../publisher/login.js';
import { logger } from '../logger.js';

runLogin()
  .then(() => {
    logger.info('done — session stored. You can now run `npm run publish`.');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'login failed');
    process.exit(1);
  });
