/**
 * Modo embed (`?embed=1`): oculta navbar, theme toggle y elementos globales
 * para incrustar vistas de Tamaya en otras apps/iframes.
 *
 * Una vez detectado en la URL, se persiste en sessionStorage para que la
 * navegación interna (que no arrastra el query param) siga en modo embed
 * durante la sesión.
 *
 * NOTA: el modo embed NO cambia la seguridad. Las llamadas a la API siguen
 * necesitando el API token (localStorage `tamaya_api_token`). Para iframes
 * internos se puede bootstrappear con `?token=...`; evita usarlo en páginas
 * públicas porque el token queda en historial/logs del navegador.
 */
import { setStoredToken } from '../api/client';

const EMBED_STORAGE_KEY = 'tamaya_embed';

export function isEmbed(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) setStoredToken(token);
    if (params.get('embed') === '1' || window.location.pathname.startsWith('/embed')) {
      sessionStorage.setItem(EMBED_STORAGE_KEY, '1');
      return true;
    }
    if (params.get('embed') === '0') {
      sessionStorage.removeItem(EMBED_STORAGE_KEY);
      return false;
    }
    return sessionStorage.getItem(EMBED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
