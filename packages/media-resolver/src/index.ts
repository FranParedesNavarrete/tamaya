import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

export interface ResolvedMedia {
  localPath: string;
  mime?: string;
  sizeBytes: number;
  originalSource: string;
}

export interface ResolverOptions {
  /** Directorio donde se escriben las descargas. Ej: /data/tmp */
  tmpDir: string;
  /** Timeout por descarga en ms. Default: 120s */
  downloadTimeoutMs?: number;
  /** Tamaño máximo permitido en bytes. Default: 100 MB (límite práctico de WA) */
  maxSizeBytes?: number;
}

export class MediaResolver {
  private s3: S3Client | null = null;

  constructor(private readonly opts: ResolverOptions) {}

  private getS3(): S3Client {
    if (!this.s3) {
      this.s3 = new S3Client({
        region: process.env.AWS_REGION ?? 'eu-west-1',
      });
    }
    return this.s3;
  }

  async resolve(source: string): Promise<ResolvedMedia> {
    if (source.startsWith('/') || source.startsWith('file://')) {
      return this.resolveLocal(source.replace(/^file:\/\//, ''));
    }

    if (source.startsWith('s3://')) {
      return this.resolveS3(source);
    }

    if (source.startsWith('http://') || source.startsWith('https://')) {
      return this.resolveHttp(source);
    }

    throw new Error(`Unsupported media source scheme: ${source}`);
  }

  private async resolveLocal(path: string): Promise<ResolvedMedia> {
    const st = await stat(path);
    this.assertSize(st.size, path);
    return {
      localPath: path,
      mime: mimeFromExtension(path),
      sizeBytes: st.size,
      originalSource: path,
    };
  }

  private async resolveS3(source: string): Promise<ResolvedMedia> {
    const m = source.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!m) throw new Error(`invalid s3 uri: ${source}`);
    const [, bucket, key] = m;

    const target = this.targetPathFor(source, extname(key));
    await mkdir(dirname(target), { recursive: true });

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const resp = await this.getS3().send(cmd);
    if (!resp.Body) throw new Error(`empty S3 body: ${source}`);

    await pipeline(resp.Body as Readable, createWriteStream(target));
    const st = await stat(target);
    this.assertSize(st.size, source);

    return {
      localPath: target,
      mime: resp.ContentType ?? mimeFromExtension(target),
      sizeBytes: st.size,
      originalSource: source,
    };
  }

  private async resolveHttp(url: string): Promise<ResolvedMedia> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.downloadTimeoutMs ?? 120_000);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${url}`);
      }

      const urlExt = extname(new URL(url).pathname);
      const target = this.targetPathFor(url, urlExt || '.bin');
      await mkdir(dirname(target), { recursive: true });

      const buf = Buffer.from(await resp.arrayBuffer());
      this.assertSize(buf.byteLength, url);
      await writeFile(target, buf);

      return {
        localPath: target,
        mime: resp.headers.get('content-type') ?? mimeFromExtension(target),
        sizeBytes: buf.byteLength,
        originalSource: url,
      };
    } finally {
      clearTimeout(t);
    }
  }

  private targetPathFor(source: string, ext: string): string {
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    const safeExt = ext.match(/^\.[A-Za-z0-9]+$/) ? ext : '.bin';
    return join(this.opts.tmpDir, `${hash}${safeExt}`);
  }

  private assertSize(size: number, source: string): void {
    const max = this.opts.maxSizeBytes ?? 100 * 1024 * 1024;
    if (size > max) {
      throw new Error(
        `media exceeds max size: ${size} > ${max} bytes (source=${source})`,
      );
    }
  }
}

/**
 * Deduce MIME type a partir de la extensión. Cobertura suficiente para el
 * PoC (WA Channels solo acepta imagen y vídeo); amplía si añades formatos.
 */
function mimeFromExtension(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.heic': 'image/heic',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.m4v': 'video/x-m4v',
    '.3gp': 'video/3gpp',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
  };
  return map[ext];
}
