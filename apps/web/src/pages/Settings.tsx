import { useEffect, useState } from 'react';
import {
  api, getStoredToken, setStoredToken, clearStoredToken,
} from '../api/client';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from '../components/ui/card';
import { ConfirmDialog, AlertDialog } from '../components/ui/alert-dialog';
import { WhatsAppSection } from '../components/settings/WhatsAppSection';
import { SelectorsSection } from '../components/settings/SelectorsSection';
import { OpsSection } from '../components/settings/OpsSection';
import {
  KeyRound, Copy, Check, Trash2, ShieldCheck, ShieldAlert, LayoutTemplate,
} from 'lucide-react';

export function Settings() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [localToken, setLocalToken] = useState<string | null>(getStoredToken());
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [pasteToken, setPasteToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshStatus() {
    try {
      const s = await api.getSecurity();
      setConfigured(s.apiTokenConfigured);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refreshStatus(); }, []);

  async function doGenerate() {
    setError(null);
    setConfirmRotate(false);
    try {
      const { token } = await api.generateApiToken();
      setGeneratedToken(token);
      // Guardamos automáticamente en local para que la UI pueda seguir llamando
      // a la API tras rotar (el token anterior queda invalidado en el servidor).
      setStoredToken(token);
      setLocalToken(token);
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function onGenerateClick() {
    if (configured) setConfirmRotate(true);
    else void doGenerate();
  }

  async function copyToken() {
    if (!generatedToken) return;
    try {
      await navigator.clipboard.writeText(generatedToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('No se pudo copiar al portapapeles.');
    }
  }

  function savePastedToken() {
    const t = pasteToken.trim();
    if (!t) return;
    setStoredToken(t);
    setLocalToken(t);
    setPasteToken('');
  }

  function removeLocalToken() {
    clearStoredToken();
    setLocalToken(null);
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Ajustes</h1>
        <p className="text-sm text-muted-foreground">
          Configuración de Tamaya. La seguridad de la API se gestiona aquí.
        </p>
      </div>

      {/* ---------- Diagnóstico del pipeline (Iteración 3) ---------- */}
      <OpsSection />

      {/* ---------- Seguridad API ---------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-foreground">
            <KeyRound className="h-4 w-4" /> Seguridad API
          </CardTitle>
          <CardDescription>
            Protege la API con un token Bearer. Solo se muestra el token completo
            en el momento de generarlo — guárdalo en un lugar seguro.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Estado servidor */}
          <div className="flex items-center gap-2 text-sm">
            {loading ? (
              <span className="text-muted-foreground">Comprobando estado…</span>
            ) : configured ? (
              <span className="flex items-center gap-1.5 text-green-600">
                <ShieldCheck className="h-4 w-4" /> Hay un API token configurado.
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-amber-600">
                <ShieldAlert className="h-4 w-4" /> No hay API token configurado (API abierta).
              </span>
            )}
          </div>

          {/* Token recién generado (una sola vez) */}
          {generatedToken && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                Este token solo se muestra una vez. Cópialo ahora.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-background px-2 py-1.5 text-xs">
                  {generatedToken}
                </code>
                <Button size="sm" variant="outline" onClick={copyToken}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  <span className="ml-1">{copied ? 'Copiado' : 'Copiar'}</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Se ha guardado automáticamente en este navegador.
              </p>
            </div>
          )}

          {/* Generar / rotar */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onGenerateClick}>
              <KeyRound className="h-4 w-4 mr-1" />
              {configured ? 'Rotar token' : 'Generar primer token'}
            </Button>
            {configured && (
              <span className="text-xs text-muted-foreground">
                Rotar invalida el token anterior.
              </span>
            )}
          </div>

          {/* Token local (cliente) */}
          <div className="border-t pt-4 space-y-3">
            <div className="text-sm">
              <span className="font-medium">Token en este navegador: </span>
              {localToken ? (
                <span className="text-green-600">
                  guardado (…{localToken.slice(-6)})
                </span>
              ) : (
                <span className="text-muted-foreground">ninguno</span>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Pegar un token existente</Label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder="tamaya_…"
                  value={pasteToken}
                  onChange={(e) => setPasteToken(e.target.value)}
                />
                <Button variant="outline" onClick={savePastedToken} disabled={!pasteToken.trim()}>
                  Guardar
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Útil si generaste el token en otra máquina.
              </p>
            </div>

            {localToken && (
              <Button variant="destructive" size="sm" onClick={removeLocalToken}>
                <Trash2 className="h-4 w-4 mr-1" /> Borrar token local
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---------- WhatsApp (Iteración 2) ---------- */}
      <WhatsAppSection />

      {/* ---------- Selectores editables (Iteración 2) ---------- */}
      <SelectorsSection />

      {/* ---------- Placeholder (iteración futura) ---------- */}
      <PlaceholderCard
        icon={<LayoutTemplate className="h-4 w-4" />}
        title="Embeds"
        text="Próximamente: configuración avanzada de vistas embebibles (el modo ?embed=1 ya está disponible)."
      />

      <ConfirmDialog
        open={confirmRotate}
        title="Rotar API token"
        description="Se generará un token nuevo y el anterior dejará de funcionar. ¿Continuar?"
        confirmLabel="Rotar token"
        cancelLabel="Cancelar"
        onConfirm={doGenerate}
        onCancel={() => setConfirmRotate(false)}
      />
      <AlertDialog
        open={Boolean(error)}
        message={error}
        onClose={() => setError(null)}
      />
    </div>
  );
}

function PlaceholderCard({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <Card className="opacity-70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-foreground">
          {icon} {title}
          <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
            próximamente
          </span>
        </CardTitle>
        <CardDescription>{text}</CardDescription>
      </CardHeader>
    </Card>
  );
}
