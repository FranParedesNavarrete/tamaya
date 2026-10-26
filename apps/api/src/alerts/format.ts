/** Funciones puras del vigilante de alertas (sin BD ni Redis, fáciles de probar). */

const TIMEZONE = 'Europe/Madrid';
const STATE_RETENTION_MS = 14 * 24 * 60 * 60_000;

export type NotifiedMap = Record<string, number>;

export function fmtMadrid(date: Date): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: TIMEZONE,
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** Traduce los errores más habituales a una acción concreta. */
export function hintForError(err: string | null | undefined): string | null {
  if (!err) return null;
  if (err.includes('qr_login')) {
    return 'WhatsApp pide vincular el dispositivo de nuevo: Ajustes → WhatsApp.';
  }
  if (err.includes('ENOENT')) {
    return 'Falta el fichero de media (la URL original caduca a los 5 min): hay que recrear el job.';
  }
  if (err.includes('POST_SEND_VERIFICATION_FAILED')) {
    return 'Puede haberse publicado: revisa el canal antes de reintentar.';
  }
  return null;
}

export function pruneNotified(map: NotifiedMap, now: number): NotifiedMap {
  return Object.fromEntries(Object.entries(map).filter(([, ts]) => now - ts < STATE_RETENTION_MS));
}

/** Recorta a `max` caracteres y lo indica con «…» (para que no parezca un error cortado por accidente). */
export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
