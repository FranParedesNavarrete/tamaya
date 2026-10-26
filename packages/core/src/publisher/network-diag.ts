/**
 * Diagnóstico de red durante un envío: registra las peticiones a hosts de
 * WhatsApp que FALLAN (`requestfailed`: DNS, TLS, conexión cortada…) o que
 * responden >= 400 (subida rechazada, 401/403/429…).
 *
 * Existe porque WhatsApp Web, cuando no consigue subir una imagen, solo pinta un
 * icono rojo con el texto genérico "Se produjo un error" y el motivo real queda
 * detrás de un clic. El navegador, en cambio, sí sabe por qué falló la petición.
 * Es solo observación: no interviene en el flujo ni puede hacerlo fallar.
 */
import type { Page } from 'playwright';

const MAX_EVENTS = 25;
const WA_HOST = /(^|\.)(whatsapp\.net|whatsapp\.com|wa\.me)$/i;

export interface NetworkDiagnostics {
  /** Eventos recogidos (únicos, en orden de aparición). */
  events: string[];
  /** Resumen corto para meter en un mensaje de error. */
  summary(max?: number): string;
  stop(): void;
}

/** host + ruta sin query ni ids largos (la query lleva tokens y no aporta). */
function describeUrl(rawUrl: string): { host: string; path: string } | null {
  try {
    const u = new URL(rawUrl);
    if (!WA_HOST.test(u.hostname)) return null;
    return { host: u.hostname, path: u.pathname.replace(/[A-Za-z0-9_-]{24,}/g, '…') };
  } catch {
    return null;
  }
}

export function startNetworkDiagnostics(page: Page): NetworkDiagnostics {
  const events: string[] = [];
  const add = (line: string) => {
    if (events.length < MAX_EVENTS && !events.includes(line)) events.push(line);
  };

  const onFailed = (req: import('playwright').Request) => {
    try {
      const d = describeUrl(req.url());
      if (!d) return;
      add(`${req.method()} ${d.host}${d.path} → ${req.failure()?.errorText ?? 'fallo de red'}`);
    } catch { /* observación: nunca debe romper el envío */ }
  };
  const onResponse = (res: import('playwright').Response) => {
    try {
      if (res.status() < 400) return;
      const d = describeUrl(res.url());
      if (!d) return;
      add(`${res.request().method()} ${d.host}${d.path} → HTTP ${res.status()}`);
    } catch { /* idem */ }
  };

  page.on('requestfailed', onFailed);
  page.on('response', onResponse);

  return {
    events,
    summary: (max = 4) => (events.length === 0
      ? ''
      : events.slice(0, max).join('; ') + (events.length > max ? ` (+${events.length - max} más)` : '')),
    stop: () => {
      page.off('requestfailed', onFailed);
      page.off('response', onResponse);
    },
  };
}
