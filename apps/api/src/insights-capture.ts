/**
 * Disparo de la captura de Estadísticas de canal contra el control server
 * nativo (Playwright). Usado tanto por las rutas de `routes/channels.ts` como
 * por el scheduler de captura automática (`insights-scheduler.ts`) — un solo
 * sitio que sabe traducir la no-disponibilidad del control server a 503.
 */
import { controlFetch, ControlUnavailableError } from './control-client.js';

export interface ControlProxyResult {
  status: number;
  body: unknown;
}

async function callCapture(body: { channelId?: string }, timeoutMs: number): Promise<ControlProxyResult> {
  try {
    const { status, body: respBody } = await controlFetch('POST', '/insights/capture', { body, timeoutMs });
    return { status, body: respBody };
  } catch (err) {
    if (err instanceof ControlUnavailableError) {
      return { status: 503, body: { ok: false, results: [], error: 'worker-publish control server not available' } };
    }
    throw err;
  }
}

/** Captura las estadísticas de un único canal. */
export function captureChannelInsightsById(channelId: string, timeoutMs = 90_000): Promise<ControlProxyResult> {
  return callCapture({ channelId }, timeoutMs);
}

/**
 * Captura las estadísticas de TODOS los canales activos (un solo contexto de
 * Chromium, recorrido secuencial). Timeout generoso: puede tardar minutos.
 */
export function captureAllChannelInsights(timeoutMs = 20 * 60_000): Promise<ControlProxyResult> {
  return callCapture({}, timeoutMs);
}
