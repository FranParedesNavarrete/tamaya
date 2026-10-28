/**
 * Captura automática programada de Estadísticas de canal.
 *
 * Un `setInterval` de 60s (mismo espíritu que el heartbeat de worker-publish):
 * cada tick lee la config de `app_settings` (ver `settings/store.ts`) y, si
 * está habilitada y ya ha pasado la hora configurada (Europe/Madrid) sin que
 * se haya disparado hoy, llama a `captureAllChannelInsights` — la misma
 * función que usa `POST /channels/insights/refresh-all` — y marca `lastRunDate`.
 *
 * Se usa "ya ha pasado la hora" (>=) en vez de "coincide exactamente" para que
 * un reinicio de `api` justo después de la hora programada no se salte el día
 * entero esperando a mañana.
 */
import pino from 'pino';
import { getInsightsAutoCaptureConfig, setInsightsAutoCaptureConfig } from './settings/store.js';
import { captureAllChannelInsights } from './insights-capture.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const TICK_MS = 60_000;
const TIMEZONE = 'Europe/Madrid';

function madridNowParts(): { date: string; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const minutesOfDay = Number(get('hour')) * 60 + Number(get('minute'));
  return { date, minutesOfDay };
}

// Evita solapes si una captura anterior (potencialmente de minutos) sigue viva
// cuando llega el siguiente tick.
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  const cfg = await getInsightsAutoCaptureConfig();
  if (!cfg.enabled) return;

  const { date, minutesOfDay } = madridNowParts();
  if (cfg.lastRunDate === date) return;
  const targetMinutesOfDay = cfg.hour * 60 + cfg.minute;
  if (minutesOfDay < targetMinutesOfDay) return;

  running = true;
  logger.info({ hour: cfg.hour, minute: cfg.minute }, 'insights auto-capture: disparando refresh-all');
  try {
    const { status, body } = await captureAllChannelInsights();
    logger.info({ status, body }, 'insights auto-capture: terminado');
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'insights auto-capture: fallo',
    );
  } finally {
    // Se marca el día como "disparado" incluso si falló, para no reintentar en
    // bucle cada minuto — el próximo intento será mañana (o vía botón manual).
    await setInsightsAutoCaptureConfig({ ...cfg, lastRunDate: date });
    running = false;
  }
}

/** Arranca el scheduler. Devuelve una función para pararlo (shutdown). */
export function startInsightsScheduler(): () => void {
  // Un fallo transitorio (DNS/BD caída) no debe tumbar la API: se registra y se
  // reintenta en el siguiente tick.
  const interval = setInterval(() => {
    tick().catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'insights auto-capture: tick fallido');
    });
  }, TICK_MS);
  logger.info('insights auto-capture scheduler started');
  return () => clearInterval(interval);
}
