import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer,
  Line,
  AreaChart, Area,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from 'recharts';
import { format, formatDistanceToNow, subDays } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  Activity, CheckCircle2, XCircle, Clock, Zap, Gauge, Search,
  AlertTriangle, Image as ImageIcon, Video, FileText, Filter,
} from 'lucide-react';

import { api } from '../api/client';
import type {
  StatsSummary, StatsByStatus, StatsByChannel, StatsTimelinePoint,
  StatsMediaTypes, StatsDurationBucket, StatsHeatmapPoint,
  RecentFailure, StatsRange,
} from '../api/client';
import type { Channel, Job } from '@tamaya/shared-types';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';

// ---------------------------------------------------------------------------
// Paleta
// ---------------------------------------------------------------------------
const STATUS_COLORS: Record<string, string> = {
  sent: '#22c55e',
  failed: '#ef4444',
  pending: '#94a3b8',
  publishing: '#3b82f6',
  resolving: '#3b82f6',
  ready: '#6366f1',
  cancelled: '#a78bfa',
};
const MEDIA_COLORS = ['#64748b', '#3b82f6', '#a855f7', '#f59e0b', '#6b7280'];

const STATUS_LABEL: Record<string, string> = {
  sent: 'Enviado',
  failed: 'Fallido',
  pending: 'Pendiente',
  publishing: 'Publicando',
  resolving: 'Resolviendo',
  ready: 'Listo',
  cancelled: 'Cancelado',
};

// ---------------------------------------------------------------------------
// Range presets
// ---------------------------------------------------------------------------
type Preset = '24h' | '7d' | '30d' | '90d' | 'all';
function rangeFromPreset(p: Preset): StatsRange {
  const now = new Date();
  if (p === 'all') return {};
  const days = p === '24h' ? 1 : p === '7d' ? 7 : p === '30d' ? 30 : 90;
  return {
    from: subDays(now, days).toISOString(),
    to: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------
export function Dashboard() {
  const [preset, setPreset] = useState<Preset>('30d');
  const [channelId, setChannelId] = useState<string>('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [granularity, setGranularity] = useState<'hour' | 'day' | 'week'>('day');

  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [byStatus, setByStatus] = useState<StatsByStatus[]>([]);
  const [byChannel, setByChannel] = useState<StatsByChannel[]>([]);
  const [timeline, setTimeline] = useState<StatsTimelinePoint[]>([]);
  const [mediaTypes, setMediaTypes] = useState<StatsMediaTypes | null>(null);
  const [durations, setDurations] = useState<StatsDurationBucket[]>([]);
  const [heatmap, setHeatmap] = useState<StatsHeatmapPoint[]>([]);
  const [failures, setFailures] = useState<RecentFailure[]>([]);

  // --- Search section ---
  const [searchQ, setSearchQ] = useState('');
  const [searchStatus, setSearchStatus] = useState('');
  const [searchResults, setSearchResults] = useState<Job[]>([]);
  const [searching, setSearching] = useState(false);

  const range: StatsRange = useMemo(() => ({
    ...rangeFromPreset(preset),
    channelId: channelId || undefined,
  }), [preset, channelId]);

  useEffect(() => {
    api.listChannels().then(setChannels).catch(() => setChannels([]));
  }, []);

  useEffect(() => {
    let alive = true;
    async function loadStats() {
      const [sm, bs, bc, tl, mt, dr, hm, rf] = await Promise.all([
        api.statsSummary(range),
        api.statsByStatus(range),
        api.statsByChannel(range),
        api.statsTimeline({ ...range, granularity }),
        api.statsMediaTypes(range),
        api.statsDuration(range),
        api.statsHeatmap(range),
        api.statsRecentFailures(8),
      ]);
      if (!alive) return;
      setSummary(sm);
      setByStatus(bs);
      setByChannel(bc);
      setTimeline(tl);
      setMediaTypes(mt);
      setDurations(dr);
      setHeatmap(hm);
      setFailures(rf);
    }
    void loadStats();
    const id = setInterval(() => void loadStats(), 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [range, granularity]);

  // Búsqueda al cambiar cualquiera de los filtros (debounced con efecto)
  useEffect(() => {
    const t = setTimeout(() => {
      setSearching(true);
      api.listJobs({
        ...range,
        q: searchQ || undefined,
        status: searchStatus || undefined,
        limit: 50,
      }).then(setSearchResults).finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [range, searchQ, searchStatus]);

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Resumen de publicaciones en tus canales de WhatsApp.
          </p>
        </div>
        <FilterBar
          preset={preset} onPreset={setPreset}
          channels={channels} channelId={channelId} onChannelId={setChannelId}
          granularity={granularity} onGranularity={setGranularity}
        />
      </header>

      {/* KPIs */}
      <section className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <Kpi icon={<Activity className="h-4 w-4" />} label="Total jobs" value={summary?.total ?? 0} />
        <Kpi icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />} label="Enviados" value={summary?.sent ?? 0} accent="text-emerald-600" />
        <Kpi icon={<XCircle className="h-4 w-4 text-red-600" />} label="Fallidos" value={summary?.failed ?? 0} accent="text-red-600" />
        <Kpi icon={<Clock className="h-4 w-4" />} label="Pendientes" value={summary?.pending ?? 0} />
        <Kpi
          icon={<Gauge className="h-4 w-4" />}
          label="Tasa de éxito"
          value={summary ? `${Math.round(summary.successRate * 100)}%` : '—'}
        />
        <Kpi
          icon={<Zap className="h-4 w-4" />}
          label="Duración media"
          value={summary?.avgDurationMs ? formatDuration(summary.avgDurationMs) : '—'}
        />
      </section>

      {/* Timeline + Status */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Actividad en el tiempo</CardTitle>
              <p className="text-xs text-muted-foreground">
                Jobs por {granularity === 'hour' ? 'hora' : granularity === 'week' ? 'semana' : 'día'}
              </p>
            </div>
          </CardHeader>
          <CardContent>
            {timeline.length === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={timeline}>
                  <defs>
                    <linearGradient id="gSent" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={STATUS_COLORS.sent} stopOpacity={0.4} />
                      <stop offset="95%" stopColor={STATUS_COLORS.sent} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gFailed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={STATUS_COLORS.failed} stopOpacity={0.4} />
                      <stop offset="95%" stopColor={STATUS_COLORS.failed} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="sent" name="Enviados"
                        stroke={STATUS_COLORS.sent} fill="url(#gSent)" strokeWidth={2} />
                  <Area type="monotone" dataKey="failed" name="Fallidos"
                        stroke={STATUS_COLORS.failed} fill="url(#gFailed)" strokeWidth={2} />
                  <Line type="monotone" dataKey="cancelled" name="Cancelados"
                        stroke={STATUS_COLORS.cancelled} strokeWidth={1.5} strokeDasharray="4 4" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Por estado</CardTitle>
          </CardHeader>
          <CardContent>
            {byStatus.length === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={byStatus}
                    dataKey="count"
                    nameKey="status"
                    innerRadius={55}
                    outerRadius={95}
                    paddingAngle={2}
                    label={(e: any) => `${STATUS_LABEL[e.status] ?? e.status}: ${e.count}`}
                    labelLine={false}
                  >
                    {byStatus.map((s) => (
                      <Cell key={s.status} fill={STATUS_COLORS[s.status] ?? '#888'} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: any, _n: any, p: any) => [
                      Number(v),
                      STATUS_LABEL[p.payload.status] ?? p.payload.status,
                    ]}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Channels + Media types */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Top canales</CardTitle>
            <p className="text-xs text-muted-foreground">Jobs enviados y fallidos por canal</p>
          </CardHeader>
          <CardContent>
            {byChannel.length === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(220, byChannel.length * 30)}>
                <BarChart data={byChannel} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="channelName"
                    width={140}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="sent" name="Enviados" fill={STATUS_COLORS.sent} radius={[0, 4, 4, 0]} />
                  <Bar dataKey="failed" name="Fallidos" fill={STATUS_COLORS.failed} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tipos de contenido</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {mediaTypes && (
              <>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'Solo texto', value: mediaTypes.textOnly, icon: 'text' },
                        { name: 'Imagen', value: mediaTypes.image, icon: 'image' },
                        { name: 'Vídeo', value: mediaTypes.video, icon: 'video' },
                        { name: 'Mixto', value: mediaTypes.mixed, icon: 'mixed' },
                        { name: 'Otros', value: mediaTypes.other, icon: 'other' },
                      ].filter(d => d.value > 0)}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={40}
                      outerRadius={70}
                    >
                      {[0, 1, 2, 3, 4].map((i) => (
                        <Cell key={i} fill={MEDIA_COLORS[i]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} />
                  </PieChart>
                </ResponsiveContainer>
                <MediaLegend mediaTypes={mediaTypes} />
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Duration distribution + Heatmap */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Distribución de duración (jobs enviados)</CardTitle>
          </CardHeader>
          <CardContent>
            {durations.length === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={sortDurationBuckets(durations)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name="Jobs" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Heatmap de actividad</CardTitle>
            <p className="text-xs text-muted-foreground">Jobs por día de la semana y hora</p>
          </CardHeader>
          <CardContent>
            <Heatmap points={heatmap} />
          </CardContent>
        </Card>
      </section>

      {/* Recent failures */}
      <section>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <CardTitle>Fallos recientes</CardTitle>
            </div>
            <Link to="/jobs?status=failed" className="text-xs text-primary underline">Ver todos</Link>
          </CardHeader>
          <CardContent>
            {failures.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">Sin fallos recientes 🎉</p>
            ) : (
              <div className="divide-y">
                {failures.map((f) => (
                  <div key={f.id} className="py-2 flex gap-3 items-start">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{f.channelName}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {f.text ?? <em>(sin texto)</em>}
                      </p>
                      <p className="text-xs text-red-600 truncate mt-1">{f.lastError ?? 'Error desconocido'}</p>
                    </div>
                    <div className="text-right text-xs text-muted-foreground whitespace-nowrap">
                      <div>{formatDistanceToNow(new Date(f.scheduledAt), { locale: es, addSuffix: true })}</div>
                      <div>Intentos: {f.attemptCount}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Mensajes / Búsqueda */}
      <section>
        <Card>
          <CardHeader>
            <CardTitle>Mensajes</CardTitle>
            <p className="text-xs text-muted-foreground">
              Busca en el texto, filtra por estado y canal.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-3 flex-wrap items-center">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                  placeholder="Buscar texto…"
                  className="pl-8"
                />
              </div>
              <Select value={searchStatus} onChange={e => setSearchStatus(e.target.value)}>
                <option value="">Todos los estados</option>
                <option value="pending">Pendiente</option>
                <option value="publishing">Publicando</option>
                <option value="sent">Enviado</option>
                <option value="failed">Fallido</option>
                <option value="cancelled">Cancelado</option>
              </Select>
              {searching && <span className="text-xs text-muted-foreground">Buscando…</span>}
              <span className="text-xs text-muted-foreground ml-auto">{searchResults.length} resultados</span>
            </div>

            {searchResults.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">Sin resultados.</p>
            ) : (
              <div className="overflow-auto max-h-[480px]">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground border-b sticky top-0 bg-background">
                    <tr>
                      <th className="py-2 pr-3">Canal</th>
                      <th className="py-2 pr-3">Texto</th>
                      <th className="py-2 pr-3">Media</th>
                      <th className="py-2 pr-3">Estado</th>
                      <th className="py-2 pr-3">Programado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchResults.map((j) => (
                      <tr key={j.id} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="py-2 pr-3 font-medium max-w-[180px] truncate">{j.channelName}</td>
                        <td className="py-2 pr-3 max-w-[360px] truncate">{j.text ?? <em className="text-muted-foreground">—</em>}</td>
                        <td className="py-2 pr-3">{j.media.length}</td>
                        <td className="py-2 pr-3">
                          <StatusBadge status={j.status} />
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted-foreground">
                          {format(new Date(j.scheduledAt), 'dd/MM HH:mm')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componentes
// ---------------------------------------------------------------------------

function FilterBar({
  preset, onPreset, channels, channelId, onChannelId, granularity, onGranularity,
}: {
  preset: Preset; onPreset: (p: Preset) => void;
  channels: Channel[]; channelId: string; onChannelId: (id: string) => void;
  granularity: 'hour' | 'day' | 'week'; onGranularity: (g: 'hour' | 'day' | 'week') => void;
}) {
  const presets: { v: Preset; label: string }[] = [
    { v: '24h', label: '24h' },
    { v: '7d', label: '7 días' },
    { v: '30d', label: '30 días' },
    { v: '90d', label: '90 días' },
    { v: 'all', label: 'Todo' },
  ];
  return (
    <div className="flex gap-2 flex-wrap items-center">
      <div className="flex rounded-md border bg-card overflow-hidden">
        {presets.map((p) => (
          <button key={p.v} onClick={() => onPreset(p.v)}
                  className={`px-3 py-1.5 text-xs ${preset === p.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>
            {p.label}
          </button>
        ))}
      </div>
      <Select value={channelId} onChange={e => onChannelId(e.target.value)} className="min-w-[180px]">
        <option value="">Todos los canales</option>
        {channels.map(c => (
          <option key={c.id} value={c.id}>
            {c.acronym ? `[${c.acronym}] ` : ''}{c.name}
          </option>
        ))}
      </Select>
      <Select value={granularity} onChange={e => onGranularity(e.target.value as any)} className="min-w-[110px]">
        <option value="hour">Por hora</option>
        <option value="day">Por día</option>
        <option value="week">Por semana</option>
      </Select>
    </div>
  );
}

function Kpi({ icon, label, value, accent }: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="text-muted-foreground">{icon}</span>
        </div>
        <div className={`text-2xl font-bold tabular-nums ${accent ?? ''}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function MediaLegend({ mediaTypes }: { mediaTypes: StatsMediaTypes }) {
  const items = [
    { label: 'Solo texto', value: mediaTypes.textOnly, icon: <FileText className="h-4 w-4" />, color: MEDIA_COLORS[0] },
    { label: 'Imagen', value: mediaTypes.image, icon: <ImageIcon className="h-4 w-4" />, color: MEDIA_COLORS[1] },
    { label: 'Vídeo', value: mediaTypes.video, icon: <Video className="h-4 w-4" />, color: MEDIA_COLORS[2] },
    { label: 'Mixto', value: mediaTypes.mixed, icon: <Filter className="h-4 w-4" />, color: MEDIA_COLORS[3] },
  ];
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map(i => (
        <li key={i.label} className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />
            {i.icon}
            {i.label}
          </span>
          <span className="font-medium tabular-nums">{i.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Heatmap({ points }: { points: StatsHeatmapPoint[] }) {
  // Matriz 7 (Mon-Sun) x 24
  const DOW_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const p of points) {
    // MySQL dayofweek: 1=Sun..7=Sat. Convertimos a 0=Mon..6=Sun.
    const dow = (p.dow + 5) % 7;
    matrix[dow][p.hour] = p.count;
    if (p.count > max) max = p.count;
  }
  return (
    <div className="space-y-1">
      <div className="grid" style={{ gridTemplateColumns: '24px repeat(24, 1fr)' }}>
        <div></div>
        {Array.from({ length: 24 }).map((_, h) => (
          <div key={h} className="text-[9px] text-center text-muted-foreground">{h % 3 === 0 ? h : ''}</div>
        ))}
      </div>
      {matrix.map((row, i) => (
        <div key={i} className="grid items-center" style={{ gridTemplateColumns: '24px repeat(24, 1fr)' }}>
          <div className="text-[10px] text-muted-foreground text-center">{DOW_LABELS[i]}</div>
          {row.map((v, h) => {
            const intensity = max > 0 ? v / max : 0;
            const bg = v === 0
              ? 'hsl(var(--muted))'
              : `hsla(217, 90%, 50%, ${0.15 + intensity * 0.85})`;
            return (
              <div
                key={h}
                className="aspect-square rounded-sm mx-[1px]"
                style={{ background: bg }}
                title={`${DOW_LABELS[i]} ${h}:00 — ${v} jobs`}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const bg = STATUS_COLORS[status] ?? '#888';
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-[10px] font-medium text-white"
      style={{ background: bg }}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function EmptyChart() {
  return (
    <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">
      Sin datos en el rango seleccionado
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function sortDurationBuckets(data: StatsDurationBucket[]): StatsDurationBucket[] {
  const order = ['<5s', '5-15s', '15-30s', '30-60s', '1-2m', '2-5m', '>5m'];
  return [...data].sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
}

const tooltipStyle = {
  background: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 6,
  fontSize: 12,
};
