import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const TMP_DIR = process.env.TAMAYA_TMP_DIR ?? '/tmp/tamaya-media';

/**
 * WhatsApp Channels SOLO acepta imágenes y vídeos (no documentos, no audio
 * como documento). Bloqueamos cualquier otro tipo en el upload.
 */
function isAllowedMime(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('video/');
}

export async function mediaRoutes(app: FastifyInstance) {
  // POST /media/upload — recibe un archivo multipart y devuelve { source, mime, size }
  app.post('/upload', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'no file provided' });

    if (!isAllowedMime(data.mimetype)) {
      return reply.code(415).send({
        error: `tipo no soportado (${data.mimetype}). WhatsApp Channels solo acepta imágenes y vídeos.`,
      });
    }

    await mkdir(TMP_DIR, { recursive: true });

    const buf = await data.toBuffer();
    const ext = extname(data.filename) || '.bin';
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const name = `${hash}-${randomUUID().slice(0, 8)}${ext}`;
    const target = join(TMP_DIR, name);
    await writeFile(target, buf);

    req.log.info({ target, size: buf.byteLength, mime: data.mimetype }, 'media uploaded');
    return {
      source: target,                // absolute path — MediaResolver lo trata como local
      mime: data.mimetype,
      size: buf.byteLength,
      originalName: data.filename,
    };
  });
}
