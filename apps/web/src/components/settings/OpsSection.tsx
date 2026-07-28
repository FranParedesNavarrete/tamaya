import { useCallback, useEffect, useState } from 'react';
import { api, type OpsQueues, type OpsPublisher, type OpsHealth } from '../../api/client';
import { Button } from '../ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card';
import { Activity, RefreshCw, CheckCircle2, XCircle, HelpCircle } from 'lucide-react';

function Dot({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600 inline" />
    : <XCircle className="h-3.5 w-3.5 text-red-600 inline" />;
}

function QueueTable({ title, q }: { title: string; q: OpsQueues['resolve'] }) {
  return (
    <div className="text-xs">
      <div className="font-medium mb-1">{title}</div>
      <div className="grid grid-cols-6 gap-1 text-center">
        {(['waiting', 'active', 'delayed', 'completed', 'failed', 'paused'] as const).map((k) => (
          <div key={k} className="rounded bg-muted px-1 py-1">
            <div className="text-muted-foreground text-[10px] uppercase">{k}</div>
            <div className="font-mono">{q[k]}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OpsSection() {
  const [queues, setQueues] = useState<OpsQueues | null>(null);
  const [publisher, setPublisher] = useState<OpsPublisher | null>(null);
  const [health, setHealth] = useState<OpsHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [q, p, h] = await Promise.all([api.opsQueues(), api.opsPublisher(), api.opsHealth()]);
      setQueues(q); setPublisher(p); setHealth(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const hb = publisher?.publisherHeartbeat;

  const restartPublisher = useCallback(async () => {
    if (!window.confirm('¿Reiniciar worker-publish ahora?')) return;
    setRestarting(true);
    setError(null);
    setRestartMessage(null);
    try {
      const r = await api.restartPublisher();
      setRestartMessage(r.ok ? `Reinicio solicitado para ${r.process}.` : (r.error ?? 'No se pudo reiniciar worker-publish.'));
      setTimeout(() => void refresh(), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestarting(false);
    }
  }, [refresh]);

  return (
    <Card id="diagnostico">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-foreground">
          <Activity className="h-4 w-4" /> Diagnóstico del pipeline
        </CardTitle>
        <CardDescription>
          Estado de colas, publisher y dependencias. Se actualiza cada 5 s.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <>
            {health && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span><Dot ok={health.db} /> DB</span>
                <span><Dot ok={health.redis} /> Redis</span>
                <span><Dot ok={health.controlServer} /> Control server</span>
                <span><Dot ok={health.publisherOnline} /> Publisher</span>
              </div>
            )}

            {publisher && (
              <div className={`rounded-md p-2 text-xs ${
                publisher.publisherLikelyRunning
                  ? 'bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400'
                  : 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400'
              }`}>
                <div className="font-medium">{publisher.message}</div>
                <div className="mt-1 text-[11px] opacity-80">
                  publisher online: {String(publisher.publisherOnline)} · en cola publish: {publisher.publishQueueWaiting} · activos: {publisher.publishActive}
                  {hb?.pid ? ` · pid ${hb.pid}@${hb.hostname ?? '?'}` : ''}
                  {typeof hb?.ageMs === 'number' ? ` · latido hace ${Math.round(hb.ageMs / 1000)}s` : ''}
                </div>
                {!publisher.publisherLikelyRunning && (
                  <div className="mt-1.5 text-[11px]">
                    En el servidor: <code className="rounded bg-background px-1">npm run native:start</code> + <code className="rounded bg-background px-1">pm2 save</code>.
                  </div>
                )}
              </div>
            )}

            {queues && (
              <div className="space-y-3">
                <QueueTable title="resolve-queue" q={queues.resolve} />
                <QueueTable title="publish-queue" q={queues.publish} />
              </div>
            )}

            {restartMessage && <div className="text-xs text-green-600">{restartMessage}</div>}
            {error && <div className="text-xs text-red-600 break-all">{error}</div>}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                <RefreshCw className="h-4 w-4 mr-1" /> Refrescar
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void restartPublisher()}
                disabled={restarting || health?.controlServer === false}
              >
                <RefreshCw className={`h-4 w-4 mr-1 ${restarting ? 'animate-spin' : ''}`} />
                {restarting ? 'Reiniciando…' : 'Reiniciar worker-publish'}
              </Button>
              <span title="Sirve para refrescar worker-publish tras vincular WhatsApp o cambiar ajustes/selectores. Lanza un pm2 restart tamaya-worker-publish en el host.">
                <HelpCircle
                  className="h-4 w-4 text-muted-foreground"
                  aria-label="Ayuda sobre reiniciar worker-publish"
                />
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
