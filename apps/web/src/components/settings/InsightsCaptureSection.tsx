import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card';
import { BarChart3, Check, Loader2 } from 'lucide-react';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function InsightsCaptureSection() {
  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState(3);
  const [minute, setMinute] = useState(0);
  const [lastRunDate, setLastRunDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.getInsightsAutoCapture();
        setEnabled(cfg.enabled);
        setHour(cfg.hour);
        setMinute(cfg.minute);
        setLastRunDate(cfg.lastRunDate);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function onSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const cfg = await api.putInsightsAutoCapture({
        enabled,
        hour: Math.min(23, Math.max(0, hour)),
        minute: Math.min(59, Math.max(0, minute)),
      });
      setEnabled(cfg.enabled);
      setHour(cfg.hour);
      setMinute(cfg.minute);
      setLastRunDate(cfg.lastRunDate);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-foreground">
          <BarChart3 className="h-4 w-4" /> Captura automática de estadísticas
        </CardTitle>
        <CardDescription>
          Captura sola, cada día a la hora indicada, las Estadísticas (Alcance/Crecimiento/Seguidores)
          de todos los canales activos — mismo resultado que "Actualizar todas las estadísticas" en Canales.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              Habilitada
            </label>

            <div className="flex items-end gap-3">
              <div className="space-y-1.5">
                <Label>Hora</Label>
                <Input
                  type="number" min={0} max={23} value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  className="w-20"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Minuto</Label>
                <Input
                  type="number" min={0} max={59} value={minute}
                  onChange={(e) => setMinute(Number(e.target.value))}
                  className="w-20"
                />
              </div>
              <span className="text-sm text-muted-foreground pb-2">
                {pad2(hour)}:{pad2(minute)} (hora de Madrid)
              </span>
            </div>

            {lastRunDate && (
              <p className="text-xs text-muted-foreground">Última ejecución: {lastRunDate}</p>
            )}

            {error && (
              <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 p-2 text-xs text-red-600 break-all">
                {error}
              </div>
            )}

            <Button onClick={onSave} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : saved ? <Check className="h-4 w-4 mr-1" /> : null}
              {saved ? 'Guardado' : 'Guardar'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
