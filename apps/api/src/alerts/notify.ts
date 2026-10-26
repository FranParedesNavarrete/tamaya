/**
 * Envío de alertas por el flujo de n8n (webhook `send-notification`).
 *
 * Configuración (todo por .env, ver .env.example):
 *   N8N_BASE_URL            → p.ej. https://n8n.k1t.eu (pruebas) o http://n8n:5678 (red docker en prod)
 *   N8N_NOTIFICATION_PATH   → p.ej. /webhook/autoritas/send-notification
 *   ALERT_EMAIL             → destinatario del correo (opcional)
 *   ALERT_WHATSAPP          → teléfono con prefijo y sin '+': 34671242673 (opcional)
 *   ALERT_TO_NAME           → nombre del destinatario (por defecto "Tamaya")
 *
 * Si falta la URL, o no hay ni email ni teléfono, las alertas quedan
 * desactivadas. Enviar una alerta NUNCA lanza: un fallo de n8n no debe tumbar
 * a la API ni a quien la llama.
 */
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const REQUEST_TIMEOUT_MS = 10_000;

export interface AlertConfig {
  url: string | null;
  email: string | null;
  phone: string | null;
  toName: string;
}

/** Quita '+', espacios y '00' inicial; devuelve null si no parece un teléfono. */
export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

/** Une base y path sin perder el path de la base ni duplicar barras. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function readAlertConfig(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const base = env.N8N_BASE_URL?.trim();
  const path = env.N8N_NOTIFICATION_PATH?.trim();
  const rawPhone = env.ALERT_WHATSAPP?.trim();
  const phone = normalizePhone(rawPhone);
  if (rawPhone && !phone) {
    logger.warn({ ALERT_WHATSAPP: rawPhone }, 'ALERT_WHATSAPP no es válido (prefijo + número, ej. 34671242673): se ignora');
  }
  return {
    url: base && path ? joinUrl(base, path) : null,
    email: env.ALERT_EMAIL?.trim() || null,
    phone,
    toName: env.ALERT_TO_NAME?.trim() || 'Tamaya',
  };
}

export function alertsEnabled(cfg: AlertConfig): boolean {
  return Boolean(cfg.url && (cfg.email || cfg.phone));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Mismo contrato que el resto de correos que pasan por el flujo de n8n. */
export function buildEmailPayload(cfg: AlertConfig, subject: string, lines: string[]) {
  const body = lines.map((l) => `<p style="margin:0 0 10px">${escapeHtml(l)}</p>`).join('');
  return {
    type: 'email',
    to_email: cfg.email,
    to_phone: null,
    to_name: cfg.toName,
    cc: [] as string[],
    subject,
    html: `<!DOCTYPE html><html lang="es"><body style="font-family:Arial,Helvetica,sans-serif;color:#0A1414;font-size:14px;line-height:1.5">${body}</body></html>`,
    files: [] as string[],
  };
}

/**
 * Mensaje de WhatsApp. Contrato del flujo de n8n: el texto va en `html`
 * (texto plano), `subject` va a null y no se envía `cc`.
 */
export function buildWhatsappPayload(cfg: AlertConfig, subject: string, lines: string[]) {
  return {
    type: 'whatsapp',
    to_email: null,
    to_phone: cfg.phone,
    to_name: cfg.toName,
    subject: null,
    html: [`*${subject}*`, ...lines].join('\n'),
    files: [] as string[],
  };
}

async function post(url: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error({ status: res.status, url }, 'alerta: n8n respondió con error');
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), url }, 'alerta: no se pudo llamar a n8n');
    return false;
  }
}

/**
 * Envía la alerta por los canales configurados. Devuelve true si TODOS los
 * canales configurados se entregaron (para que el llamador pueda reintentar).
 */
export async function sendAlert(
  subject: string,
  lines: string[],
  cfg: AlertConfig = readAlertConfig(),
): Promise<boolean> {
  if (!alertsEnabled(cfg) || !cfg.url) return false;
  const jobs: Array<Promise<boolean>> = [];
  if (cfg.email) jobs.push(post(cfg.url, buildEmailPayload(cfg, subject, lines)));
  if (cfg.phone) jobs.push(post(cfg.url, buildWhatsappPayload(cfg, subject, lines)));
  const results = await Promise.all(jobs);
  const ok = results.every(Boolean);
  logger.info({ subject, ok, channels: results.length }, 'alerta enviada');
  return ok;
}
