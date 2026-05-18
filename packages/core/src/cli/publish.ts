#!/usr/bin/env node
/**
 * CLI: `npm run publish -- --channel "Mi Canal" --text "Hola" [--media ./foto.jpg --kind image]`
 *
 * Mínimo usable del PoC. Se invoca desde la terminal.
 */
import { parseArgs } from 'node:util';
import { publishText } from '../publisher/publish-text.js';
import { publishMedia, type MediaKind } from '../publisher/publish-media.js';
import { logger } from '../logger.js';

const { values } = parseArgs({
  options: {
    channel: { type: 'string', short: 'c' },
    text: { type: 'string', short: 't' },
    media: { type: 'string', short: 'm' },
    kind: { type: 'string', short: 'k' }, // image | video | audio | document
    link: { type: 'string', short: 'l' },
  },
});

if (!values.channel) {
  logger.error('missing --channel');
  process.exit(2);
}

const channelIdentifier = {
  name: values.channel,
  inviteLink: values.link,
};

async function main(): Promise<void> {
  if (values.media) {
    const kind = (values.kind ?? 'image') as MediaKind;
    const result = await publishMedia({
      channelIdentifier,
      body: values.text,
      mediaPath: values.media,
      mediaKind: kind,
    });
    logger.info(result, 'publishMedia result');
    process.exit(result.success ? 0 : 1);
  }

  if (!values.text) {
    logger.error('need at least --text or --media');
    process.exit(2);
  }

  const result = await publishText({
    channelIdentifier,
    body: values.text,
  });
  logger.info(result, 'publishText result');
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  logger.error({ err }, 'publish failed');
  process.exit(1);
});
