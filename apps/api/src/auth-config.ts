/**
 * Configuración de autenticación de la API, resuelta UNA vez al arrancar desde
 * variables de entorno. Es una función pura (recibe el entorno) para poder
 * probarla sin levantar el servidor. Nunca incluye el token en los mensajes de
 * error ni en logs.
 *
 *  - Producción (`NODE_ENV=production` o `TAMAYA_REQUIRE_ENV_TOKEN=true`):
 *    exige `TAMAYA_API_TOKEN` (>= 32 caracteres), rechaza `API_AUTH_DISABLED`
 *    y no existe la API abierta.
 *  - Desarrollo: `TAMAYA_API_TOKEN` si está definido; si no, hay que elegir
 *    explícitamente `TAMAYA_DEV_TOKEN_BOOTSTRAP=true` (flujo antiguo: API abierta
 *    hasta generar un token desde Ajustes) o `API_AUTH_DISABLED=true`.
 */

export const MIN_TOKEN_LENGTH = 32;

export type AuthMode = 'disabled' | 'env' | 'stored';

export interface AuthConfig {
  /**
   * - `disabled`: sin autenticación (solo desarrollo).
   * - `env`: el token viene de `TAMAYA_API_TOKEN`.
   * - `stored`: token generado desde Ajustes y guardado como hash en BD
   *   (solo desarrollo, con opt-in explícito).
   */
  mode: AuthMode;
  production: boolean;
  /** Token de entorno (solo en modo `env`). No se loguea nunca. */
  envToken?: string;
  /**
   * En modo `env`, aceptar además el token antiguo guardado en BD. Transitorio
   * para migrar clientes (VISTA, n8n, navegadores) sin cortar el servicio.
   */
  allowStoredToken: boolean;
  /** `/docs` público (sin token). Si es false, exige token como el resto. */
  docsPublic: boolean;
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

type Env = Record<string, string | undefined>;

const isTrue = (v: string | undefined) => v?.trim().toLowerCase() === 'true';

export function resolveAuthConfig(env: Env): AuthConfig {
  const production = env.NODE_ENV === 'production' || isTrue(env.TAMAYA_REQUIRE_ENV_TOKEN);
  const disabled = isTrue(env.API_AUTH_DISABLED);
  const envToken = env.TAMAYA_API_TOKEN?.trim() || undefined;
  const allowStoredToken = isTrue(env.TAMAYA_ALLOW_STORED_TOKEN);
  const docsRaw = env.TAMAYA_DOCS_ENABLED?.trim().toLowerCase();
  const docsPublic = docsRaw === undefined || docsRaw === '' ? !production : docsRaw === 'true';

  if (production) {
    if (disabled) {
      throw new AuthConfigError(
        'API_AUTH_DISABLED=true no está permitido en producción (NODE_ENV=production o TAMAYA_REQUIRE_ENV_TOKEN=true). Quita la variable.',
      );
    }
    if (!envToken) {
      throw new AuthConfigError(
        'Falta TAMAYA_API_TOKEN: en producción la API no arranca sin token. Genera uno con `openssl rand -hex 32` y ponlo en el .env.',
      );
    }
    if (envToken.length < MIN_TOKEN_LENGTH) {
      throw new AuthConfigError(
        `TAMAYA_API_TOKEN es demasiado corto (mínimo ${MIN_TOKEN_LENGTH} caracteres). Genera uno con \`openssl rand -hex 32\`.`,
      );
    }
    return { mode: 'env', production, envToken, allowStoredToken, docsPublic };
  }

  if (disabled) return { mode: 'disabled', production, allowStoredToken: false, docsPublic };
  if (envToken) return { mode: 'env', production, envToken, allowStoredToken, docsPublic };
  if (isTrue(env.TAMAYA_DEV_TOKEN_BOOTSTRAP)) {
    return { mode: 'stored', production, allowStoredToken: true, docsPublic };
  }
  throw new AuthConfigError(
    'No hay autenticación configurada. Define TAMAYA_API_TOKEN, o en desarrollo TAMAYA_DEV_TOKEN_BOOTSTRAP=true (generar el token desde Ajustes) o API_AUTH_DISABLED=true.',
  );
}
