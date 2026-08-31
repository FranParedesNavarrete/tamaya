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

async function callCapture(body: { channelId?: string }, timeoutMs?: number): Promise<ControlProxyResult> {
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
 * Dispara la captura de TODOS los canales activos. control-server la corre en
 * SEGUNDO PLANO y responde al instante (202 + estado 'running') — no hay que
 * esperar aquí los minutos que tarde el recorrido completo. Idempotente: si
 * ya hay una en curso, control-server devuelve el estado actual sin duplicar
 * el trabajo. El progreso se consulta con `getCaptureAllStatus`.
 */
export function captureAllChannelInsights(): Promise<ControlProxyResult> {
  return callCapture({});
}

/** Estado de la captura de todos los canales en curso (o de la última). */
export async function getCaptureAllStatus(): Promise<ControlProxyResult> {
  try {
    const { status, body } = await controlFetch('GET', '/insights/capture/status');
    return { status, body };
  } catch (err) {
    if (err instanceof ControlUnavailableError) {
      return { status: 503, body: { status: 'error', total: 0, processed: 0, results: [], startedAt: null, finishedAt: null, error: 'worker-publish control server not available' } };
    }
    throw err;
  }
}
