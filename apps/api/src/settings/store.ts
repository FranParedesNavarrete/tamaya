import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@tamaya/db';
import type { SelectorOverrides } from '@tamaya/shared-types';

/**
 * Acceso al almacén clave/valor `app_settings`.
 *
 * Convención de claves (namespaced con punto):
 *   - 'security.apiTokenHash'  → hash SHA-256 (hex) del API token. Nunca se
 *                                guarda el token plano.
 *   - (futuro) 'whatsapp.*', 'selectors.*', 'embed.*', flags varios.
 */

export const API_TOKEN_HASH_KEY = 'security.apiTokenHash';
export const SELECTOR_OVERRIDES_KEY = 'selectors.overrides';
const TOKEN_PREFIX = 'tamaya_';

/** Lee un valor de settings; null si no existe. */
export async function getSetting(key: string): Promise<string | null> {
  // Usamos el protocolo text de mysql2 (`query`) para este almacén KV porque
  // algunos RDS/MySQL antiguos dan errores opacos con prepared statements de
  // Drizzle (`Failed query ... params ...`) incluso en SELECTs simples.
  const [rows] = await getPool().query('SELECT `value` FROM `app_settings` WHERE `key` = ?', [key]);
  const first = Array.isArray(rows) ? rows[0] as { value?: string | null } | undefined : undefined;
  return first?.value ?? null;
}

/** Upsert de un valor de settings. */
export async function setSetting(key: string, value: string): Promise<void> {
  await getPool().query(
    'INSERT INTO `app_settings` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    [key, value],
  );
}

/** Borra una clave de settings (si existe). */
export async function deleteSetting(key: string): Promise<void> {
  await getPool().query('DELETE FROM `app_settings` WHERE `key` = ?', [key]);
}

/**
 * Overrides de selectores guardados en `app_settings` (JSON). Devuelve `{}` si
 * no hay overrides o si el valor guardado no es JSON válido.
 */
export async function getSelectorOverrides(): Promise<SelectorOverrides> {
  const raw = await getSetting(SELECTOR_OVERRIDES_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as SelectorOverrides) : {};
  } catch {
    return {};
  }
}

/** Persiste los overrides de selectores como JSON. */
export async function setSelectorOverrides(overrides: SelectorOverrides): Promise<void> {
  await setSetting(SELECTOR_OVERRIDES_KEY, JSON.stringify(overrides));
}

/** SHA-256 en hex del texto dado. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** ¿Hay un API token configurado? */
export async function isApiTokenConfigured(): Promise<boolean> {
  const hash = await getSetting(API_TOKEN_HASH_KEY);
  return Boolean(hash && hash.length > 0);
}

/**
 * Genera un nuevo API token, persiste solo su hash y devuelve el token plano.
 * El token plano solo existe en este momento — no vuelve a estar disponible.
 */
export async function generateAndStoreApiToken(): Promise<string> {
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  await setSetting(API_TOKEN_HASH_KEY, sha256Hex(token));
  return token;
}

/**
 * Comparación en tiempo constante del token recibido contra el hash guardado.
 * Devuelve false si no hay token configurado o no coincide.
 */
export async function verifyApiToken(candidate: string): Promise<boolean> {
  const storedHash = await getSetting(API_TOKEN_HASH_KEY);
  if (!storedHash) return false;
  const candidateHash = sha256Hex(candidate);
  // Ambos son hex de SHA-256 → siempre 64 chars, misma longitud de buffer.
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
