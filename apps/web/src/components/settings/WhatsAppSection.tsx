import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type WhatsAppStatus } from '../../api/client';
import { Button } from '../ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card';
import { ConfirmDialog } from '../ui/alert-dialog';
import {
  MessageCircle, RefreshCw, Link2, RotateCcw, CheckCircle2,
  AlertTriangle, Loader2, ServerCrash,
} from 'lucide-react';

const ACTIVE_STATES = ['starting', 'qr'];
const POLL_MS = 2500;

const STATE_LABEL: Record<string, string> = {
  idle: 'Inactivo',
  starting: 'Iniciando…',
  qr: 'Esperando escaneo de QR',
  authenticated: 'Autenticado',
  ready: 'Listo',
  error: 'Error',
};

export function WhatsAppSection() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [controlAvailable, setControlAvailable] = useState<boolean | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.whatsappStatus();
      setControlAvailable(true);
      setStatus(s);
      if (ACTIVE_STATES.includes(s.loginState)) {
        try {
          const qr = await api.whatsappQr();
          setQrDataUrl(qr.qrDataUrl ?? null);
        } catch {
          /* qr puede no estar aún */
        }
      } else {
        setQrDataUrl(null);
      }
      return s;
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setControlAvailable(false);
        setStatus(null);
        return null;
      }
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  // Carga inicial.
  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  // Polling mientras el login está activo.
  useEffect(() => {
    const active = status ? ACTIVE_STATES.includes(status.loginState) : false;
    if (active && !pollRef.current) {
      pollRef.current = setInterval(() => { void refresh(); }, POLL_MS);
    } else if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [status, refresh]);

  async function startLogin() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.whatsappLoginStart();
      if (!r.started && r.error) setError(r.error);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setControlAvailable(false);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doReset() {
    setConfirmReset(false);
    setBusy(true);
    setError(null);
    try {
      await api.whatsappReset();
      setQrDataUrl(null);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setControlAvailable(false);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const loginState = status?.loginState ?? 'idle';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-foreground">
          <MessageCircle className="h-4 w-4" /> WhatsApp
        </CardTitle>
        <CardDescription>
          Vincula la sesión de WhatsApp Web de forma headless (sin abrir ventana).
          Pensado para Ubuntu Server: escanea el QR desde tu móvil.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Control server no disponible */}
        {controlAvailable === false && (
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-700 dark:text-amber-400 flex gap-2">
            <ServerCrash className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Control server no disponible.</p>
              <p className="text-xs mt-1">
                Arráncalo en el host (nativo, fuera de Docker):
                <code className="mx-1 rounded bg-background px-1">npm run control -w apps/worker-publish</code>
                o <code className="mx-1 rounded bg-background px-1">npm run pm2:control:start</code>.
              </p>
            </div>
          </div>
        )}

        {/* Estado */}
        {controlAvailable && status && (
          <div className="space-y-1.5 text-sm">
            <StatusRow label="Sesión existente" value={status.sessionExists ? 'Sí' : 'No'} ok={status.sessionExists} />
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-40">Estado de login</span>
              <StateBadge state={loginState} />
              {status.headless === false && (
                <span className="text-[10px] text-muted-foreground">(headless off)</span>
              )}
            </div>
            {status.lastError && (
              <div className="flex items-start gap-1.5 text-red-600">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span className="text-xs break-all">{status.lastError}</span>
              </div>
            )}
          </div>
        )}

        {/* QR */}
        {loginState === 'qr' && (
          <div className="rounded-md border p-4 flex flex-col items-center gap-2">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="QR de vinculación de WhatsApp" className="h-56 w-56 bg-white p-2 rounded" />
            ) : (
              <div className="h-56 w-56 flex items-center justify-center text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            )}
            <p className="text-xs text-muted-foreground text-center">
              Abre WhatsApp en tu móvil → Dispositivos vinculados → Vincular un dispositivo, y escanea.
            </p>
          </div>
        )}

        {/* Éxito */}
        {(loginState === 'ready' || loginState === 'authenticated') && (
          <div className="rounded-md border border-green-300 bg-green-50 dark:bg-green-950/30 p-3 text-sm text-green-700 dark:text-green-400 flex gap-2">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Sesión vinculada y lista. Ya puedes reiniciar worker-publish para publicar.</span>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 p-2 text-xs text-red-600 break-all">
            {error}
          </div>
        )}

        {/* Acciones */}
        <div className="flex flex-wrap gap-2">
          <Button onClick={startLogin} disabled={busy || controlAvailable === false || ACTIVE_STATES.includes(loginState)}>
            <Link2 className="h-4 w-4 mr-1" /> Iniciar vinculación
          </Button>
          <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refrescar estado
          </Button>
          <Button
            variant="destructive"
            onClick={() => setConfirmReset(true)}
            disabled={busy || controlAvailable === false}
          >
            <RotateCcw className="h-4 w-4 mr-1" /> Resetear sesión
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Nota headless: el control server comparte el perfil con worker-publish. Haz la vinculación
          cuando no haya publicaciones en curso (idealmente detén worker-publish durante el login).
          Si WhatsApp bloquea el QR en headless, ejecuta el control server bajo Xvfb.
        </p>
      </CardContent>

      <ConfirmDialog
        open={confirmReset}
        title="Resetear sesión de WhatsApp"
        description="Se cerrará el navegador y se borrará el perfil (userDataDir). Tendrás que volver a escanear el QR. No afecta a la base de datos. ¿Continuar?"
        confirmLabel="Resetear"
        cancelLabel="Cancelar"
        variant="destructive"
        onConfirm={doReset}
        onCancel={() => setConfirmReset(false)}
      />
    </Card>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-40">{label}</span>
      <span className={ok ? 'text-green-600' : 'text-foreground'}>{value}</span>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const color =
    state === 'ready' || state === 'authenticated' ? 'bg-green-100 text-green-800'
    : state === 'qr' || state === 'starting' ? 'bg-blue-100 text-blue-800'
    : state === 'error' ? 'bg-red-100 text-red-800'
    : 'bg-gray-200 text-gray-800';
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>
      {STATE_LABEL[state] ?? state}
    </span>
  );
}
