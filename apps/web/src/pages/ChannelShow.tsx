import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import {
  ArrowLeft, BarChart3, Loader2, RefreshCw, TrendingUp, TrendingDown, Users,
} from 'lucide-react';
import { api, ApiError, type ChannelInsightsSnapshot } from '../api/client';
import type { Channel } from '@tamaya/shared-types';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';

function DeltaBadge({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  const positive = percent >= 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${positive ? 'text-green-600' : 'text-red-600'}`}>
      <Icon className="h-3 w-3" />
      {positive ? '+' : ''}{percent}%
    </span>
  );
}

function BarRows({ rows }: { rows: { label: string; value: { raw: string }; percent: number | null }[] }) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">Sin datos.</p>;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="text-sm">
          <div className="flex justify-between">
            <span>{r.label}</span>
            <span className="text-muted-foreground">
              {r.value.raw}{r.percent !== null ? ` · ${r.percent}%` : ''}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, Math.max(0, r.percent ?? 0))}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChannelShow() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [snapshot, setSnapshot] = useState<ChannelInsightsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noSnapshot, setNoSnapshot] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const ch = await api.getChannel(id);
      setChannel(ch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
      return;
    }
    try {
      const snap = await api.getChannelInsights(id);
      setSnapshot(snap);
      setNoSnapshot(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setSnapshot(null);
        setNoSnapshot(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function onRefresh() {
    if (!id) return;
    setRefreshing(true);
    setError(null);
    try {
      const r = await api.refreshChannelInsights(id);
      const item = r.results[0];
      if (!r.ok || (item && !item.ok)) {
        setError(item?.error ?? r.error ?? 'No se pudo actualizar');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) return <div className="p-6 max-w-4xl mx-auto">Cargando…</div>;
  if (!channel) return <div className="p-6 max-w-4xl mx-auto">Canal no encontrado.</div>;

  const insights = snapshot?.data;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => nav('/channels')} className="mb-2 -ml-2">
          <ArrowLeft className="h-4 w-4 mr-1" /> Canales
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              {channel.name}
              {channel.acronym && (
                <span className="text-sm font-mono text-muted-foreground">({channel.acronym})</span>
              )}
            </h1>
            {channel.description && (
              <p className="text-sm text-muted-foreground mt-1">{channel.description}</p>
            )}
          </div>
          <Button onClick={onRefresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            Actualizar estadísticas
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-600 break-all">
          {error}
        </div>
      )}

      {noSnapshot && !insights && (
        <Card>
          <CardContent className="py-10 flex flex-col items-center gap-3 text-center">
            <BarChart3 className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Aún no se han capturado estadísticas de este canal.
            </p>
            <Button onClick={onRefresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Capturar ahora
            </Button>
          </CardContent>
        </Card>
      )}

      {insights && (
        <>
          <p className="text-xs text-muted-foreground">
            Última captura: {format(new Date(snapshot!.capturedAt), 'dd/MM/yy HH:mm')}
            {insights.dateRange.label && ` · ${insights.dateRange.label}`}
            {insights.dateRange.range && ` (${insights.dateRange.range})`}
          </p>

          <div className="grid gap-4 md:grid-cols-3">
            {insights.reach && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="h-4 w-4" /> Alcance
                  </CardTitle>
                  <CardDescription>Cuentas alcanzadas</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="text-3xl font-bold">{insights.reach.accountsReached.raw || '—'}</div>
                  <div className="space-y-1.5 text-sm">
                    {insights.reach.segments.map((s) => (
                      <div key={s.label} className="flex justify-between">
                        <span>{s.label}</span>
                        <span className="text-muted-foreground">
                          {s.count.raw}{s.percent !== null ? ` · ${s.percent}%` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                  {insights.reach.topRegions.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">Principales regiones</p>
                      <BarRows rows={insights.reach.topRegions} />
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {insights.growth && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" /> Crecimiento
                  </CardTitle>
                  <CardDescription>Variación de seguidores</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {insights.growth.items.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Sin datos.</p>
                  ) : insights.growth.items.map((it) => (
                    <div key={it.label} className="flex justify-between text-sm">
                      <span>{it.label}</span>
                      <span className="font-medium">{it.value.raw}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {insights.followers && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="h-4 w-4" /> Seguidores
                  </CardTitle>
                  <CardDescription>{insights.followers.periodLabel ?? 'Total'}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-baseline gap-2">
                    <div className="text-3xl font-bold">{insights.followers.total.raw || '—'}</div>
                    <DeltaBadge percent={insights.followers.deltaPercent} />
                  </div>
                  {insights.followers.topRegions.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">Principales regiones</p>
                      <BarRows rows={insights.followers.topRegions} />
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}

      {channel.inviteLink && (
        <p className="text-xs text-muted-foreground">
          <Link to={`/channels/${channel.id}/edit`} className="underline">Editar canal</Link>
        </p>
      )}
    </div>
  );
}
