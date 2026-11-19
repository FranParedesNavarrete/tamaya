import { useEffect, useState } from 'react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { BASE, authHeaders, getStoredToken } from '../api/client';
import { useTheme } from '../lib/use-theme';

/**
 * Referencia de la API (OpenAPI) dentro de la app. En producción /docs/json
 * exige token, así que el spec se descarga aquí con el token guardado en este
 * navegador (Scalar no envía cabeceras al cargar por URL) y se le pasa ya
 * cargado. También precarga el token para probar endpoints sin pegarlo.
 * Se carga en lazy desde App.tsx.
 */
export default function ApiDocs() {
  const { theme } = useTheme();
  const token = getStoredToken();
  const [spec, setSpec] = useState<object | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE.replace(/\/$/, '')}/docs/json`, { headers: authHeaders() })
      .then(async (r) => {
        if (r.status === 401) throw new Error('La API exige token: pégalo en Ajustes y recarga.');
        if (!r.ok) throw new Error(`No se pudo cargar el spec (${r.status}).`);
        return r.json();
      })
      .then((json) => { if (!cancelled) setSpec(json); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>;
  if (!spec) return <div className="p-6 text-sm text-muted-foreground">Cargando referencia de la API…</div>;

  return (
    <ApiReferenceReact
      configuration={{
        content: spec,
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
