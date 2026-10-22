import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { BASE, getStoredToken } from '../api/client';
import { useTheme } from '../lib/use-theme';

/**
 * Referencia de la API (OpenAPI) dentro de la app. Lee el spec que publica la
 * API en /docs/json y precarga el token guardado en este navegador para poder
 * probar endpoints sin pegarlo. Se carga en lazy desde App.tsx.
 */
export default function ApiDocs() {
  const { theme } = useTheme();
  const token = getStoredToken();
  return (
    <ApiReferenceReact
      configuration={{
        url: `${BASE.replace(/\/$/, '')}/docs/json`,
        forceDarkModeState: theme,
        hideDarkModeToggle: true,
        authentication: {
          preferredSecurityScheme: 'bearerAuth',
          securitySchemes: { bearerAuth: { token: token ?? '' } },
        },
      }}
    />
  );
}
