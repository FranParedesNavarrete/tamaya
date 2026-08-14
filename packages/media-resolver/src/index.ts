import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat, rename, open } from 'node:fs/promises';
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

export interface MediaResolveHint {
  /** "png" | "jpg" | "mp4" o MIME completo "image/png" | "video/mp4". */
  mimeType?: string;
  /** Nombre original; se usa su extensión como fallback si es compatible. */
  originalName?: string;
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

  async resolve(source: string, hint: MediaResolveHint = {}): Promise<ResolvedMedia> {
    if (source.startsWith('/') || source.startsWith('file://')) {
      return this.resolveLocal(source.replace(/^file:\/\//, ''));
    }

    if (source.startsWith('s3://')) {
      return this.resolveS3(source);
    }

    if (source.startsWith('http://') || source.startsWith('https://')) {
      return this.resolveHttp(source, hint);
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

    // La extensión de la key es solo una pista: muchos objetos se suben sin
    // extensión y/o sin ContentType, y ahí acabábamos en .bin — que WA Web
    // rechaza sin decir nada. El contenido se comprueba abajo.
    const declaredExt = allowedExt(extname(key));
    const stagingPath = this.targetPathFor(source, declaredExt ?? '.part');
    await mkdir(dirname(stagingPath), { recursive: true });

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const resp = await this.getS3().send(cmd);
    if (!resp.Body) throw new Error(`empty S3 body: ${source}`);

    await pipeline(resp.Body as Readable, createWriteStream(stagingPath));
    const st = await stat(stagingPath);
    this.assertSize(st.size, source);

    const sniffedExt = sniffExtension(await readHead(stagingPath, 16));
    const chosenExt = sniffedExt ?? declaredExt ?? extensionFromMime(resp.ContentType ?? '');
    if (chosenExt === undefined) {
      throw new Error(
        `no se pudo determinar el tipo de ${source}: ContentType=${resp.ContentType ?? 'ninguno'}, ` +
          `key sin extensión reconocible. WhatsApp Web rechaza los archivos sin tipo reconocible.`,
      );
    }

    const target = this.targetPathFor(source, chosenExt);
    if (target !== stagingPath) await rename(stagingPath, target);

    return {
      localPath: target,
      mime: mimeFromExtension(target) ?? resp.ContentType,
      sizeBytes: st.size,
      originalSource: source,
    };
  }

  private async resolveHttp(url: string, hint: MediaResolveHint): Promise<ResolvedMedia> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.downloadTimeoutMs ?? 120_000);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${url}`);
      }

      // Prioridad de extensión:
      //  1. Pista explícita de integración (`mimeType`: png/image/png/mp4/...)
      //  2. Extensión del nombre original (`originalName`)
      //  3. Derivar de Content-Type (lo envía el servidor)
      //  4. Extraer del pathname de la URL
      //  5. Último recurso: .bin (suele causar rechazo por WA Web)
      // Saber la extensión correcta es CRÍTICO: Playwright infiere el MIME del
      // archivo por extensión al subirlo, y WA Web rechaza tipos desconocidos.
      const contentType = resp.headers.get('content-type')?.split(';')[0].trim();
      const hintMime = normalizeMimeHint(hint.mimeType);
      const hintExt = hintMime ? extensionFromMime(hintMime) : undefined;
      const nameExt = hint.originalName ? allowedExt(extname(hint.originalName)) : undefined;
      const ctExt = contentType ? extensionFromMime(contentType) : undefined;
      const urlExt = allowedExt(extname(new URL(url).pathname));
      const declaredExt = hintExt || nameExt || ctExt || urlExt;

      const buf = Buffer.from(await resp.arrayBuffer());
      this.assertSize(buf.byteLength, url);

      // 6. El contenido manda. Las cabeceras y las pistas mienten (o faltan):
      // un servidor que responde `application/octet-stream` nos dejaba en .bin,
      // y con .bin Playwright sube el archivo como octet-stream, WA Web no lo
      // reconoce y NO abre preview — el job se quedaba 25s esperando un preview
      // que no iba a existir, sin un error que lo explicase.
      const sniffedExt = sniffExtension(buf);
      if (sniffedExt !== undefined && declaredExt !== undefined && sniffedExt !== declaredExt) {
        // Discrepancia real: gana el contenido, porque es lo que WA va a leer.
        console.warn(
          `[media-resolver] extensión declarada ${declaredExt} != contenido ${sniffedExt} (${url}); se usa el contenido`,
        );
      }
      const chosenExt = sniffedExt ?? declaredExt;

      if (chosenExt === undefined) {
        throw new Error(
          `no se pudo determinar el tipo de ${url}: content-type=${contentType ?? 'ninguno'}, ` +
            `mimeType hint=${hint.mimeType ?? 'ninguno'}, primeros bytes=${buf
              .subarray(0, 8)
              .toString('hex')}. WhatsApp Web rechaza los archivos sin tipo reconocible.`,
        );
      }

      const target = this.targetPathFor(url, chosenExt);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buf);

      const mime = mimeFromExtension(target) ?? hintMime ?? contentType;
      return {
        localPath: target,
        mime,
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
  return EXT_TO_MIME[ext];
}

function allowedExt(ext: string): string | undefined {
  const normalized = ext.toLowerCase();
  return EXT_TO_MIME[normalized] ? normalized : undefined;
}

function normalizeMimeHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const normalized = hint.trim().toLowerCase().replace(/^\./, '');
  if (normalized.includes('/')) return MIME_TO_EXT[normalized] ? normalized : undefined;
  return EXT_TO_MIME[`.${normalized}`];
}

/**
 * Dado un MIME, devuelve la extensión canónica (con punto). Se usa al descargar
 * desde URLs donde el pathname no tiene extensión útil (CDNs, proxies) —
 * tomamos la extensión del `Content-Type` para que WA Web y Playwright
 * reconozcan correctamente el archivo.
 */
function extensionFromMime(mime: string): string | undefined {
  return MIME_TO_EXT[mime.toLowerCase()];
}

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  // Mantenemos la allow-list intencionadamente corta para WhatsApp Channels:
  // imágenes comunes y vídeos web. MP4 es el vídeo más fiable.
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

/**
 * Extensión deducida de los magic bytes del propio archivo.
 *
 * Es la única fuente fiable: el `Content-Type` lo pone el servidor de origen y
 * puede faltar o ser `application/octet-stream`, y las pistas de la integración
 * pueden venir vacías. Cubre exactamente los formatos de la allow-list.
 */
export function sniffExtension(buf: Buffer): string | undefined {
  const hex = (start: number, end: number) => buf.subarray(start, end).toString('hex');
  const ascii = (start: number, end: number) => buf.subarray(start, end).toString('latin1');

  if (buf.byteLength < 12) return undefined;
  if (hex(0, 8) === '89504e470d0a1a0a') return '.png';
  if (hex(0, 3) === 'ffd8ff') return '.jpg';
  if (ascii(0, 3) === 'GIF') return '.gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  // ISO-BMFF: "....ftyp<brand>". qt = MOV; el resto de brands → mp4.
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    return brand.startsWith('qt') ? '.mov' : '.mp4';
  }
  // WebM/Matroska.
  if (hex(0, 4) === '1a45dfa3') return '.webm';
  return undefined;
}

/** Primeros `n` bytes de un archivo, para sniffing. */
async function readHead(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
