/**
 * Cliente HTTP hacia el "control server" nativo de worker-publish.
 *
 * El control server corre NATIVO en el host (Playwright/Chromium), fuera de
 * Docker. La API (dentro de Docker) lo alcanza vía `TAMAYA_CONTROL_URL`
 * (típicamente http://host.docker.internal:3010). Esta URL NUNCA se expone al
 * cliente: la UI solo habla con la API, y la API hace de gateway protegido.
 */

const CONTROL_URL = process.env.TAMAYA_CONTROL_URL ?? 'http://host.docker.internal:3010';
const CONTROL_TOKEN = process.env.TAMAYA_CONTROL_TOKEN?.trim() || '';
const DEFAULT_TIMEOUT_MS = 15_000;

/** Se lanza cuando el control server no está accesible (no levantado, red, etc.). */
export class ControlUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('worker-publish control server not available');
    this.name = 'ControlUnavailableError';
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

export interface ControlResponse {
  status: number;
  body: unknown;
}

/**
 * Reenvía una petición al control server y devuelve { status, body }.
 * Si el control server no responde (ECONNREFUSED, timeout, DNS), lanza
 * `ControlUnavailableError` para que la ruta traduzca a 503.
 */
export async function controlFetch(
  method: 'GET' | 'POST',
  path: string,
  opts: { timeoutMs?: number } = {},
): Promise<ControlResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (CONTROL_TOKEN) headers['x-tamaya-control-token'] = CONTROL_TOKEN;
    const res = await fetch(`${CONTROL_URL}${path}`, {
      method,
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body };
  } catch (err) {
    throw new ControlUnavailableError(err);
  } finally {
    clearTimeout(timeout);
  }
}
