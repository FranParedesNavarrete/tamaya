import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { subDays } from 'date-fns';
import { AlertTriangle, CheckCircle2, Clock, Gauge, XCircle, Activity } from 'lucide-react';
import { api } from '../api/client';
import type { OpsQueues, RecentFailure, StatsByStatus, StatsSummary, StatsTimelinePoint } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const STATUS_COLORS: Record<string, string> = {
  sent: '#22c55e',
  failed: '#ef4444',
  pending: '#94a3b8',
  publishing: '#3b82f6',
  resolving: '#3b82f6',
  ready: '#6366f1',
  cancelled: '#a78bfa',
};

const STATUS_LABEL: Record<string, string> = {
  sent: 'Enviado', failed: 'Fallido', pending: 'Pendiente', publishing: 'Publicando',
  resolving: 'Resolviendo', ready: 'Listo', cancelled: 'Cancelado',
};

type Widget = 'kpis' | 'timeline' | 'status' | 'queues' | 'failures' | 'overview';

function rangeFromQuery(params: URLSearchParams) {
  const preset = params.get('range') ?? '30d';
  if (preset === 'all') return {};
  const days = preset === '24h' ? 1 : preset === '7d' ? 7 : preset === '90d' ? 90 : 30;
  return { from: subDays(new Date(), days).toISOString(), to: new Date().toISOString() };
}

function useEmbedRange() {
  const [params] = useSearchParams();
  return useMemo(() => ({
    ...rangeFromQuery(params),
    channelId: params.get('channelId') || undefined,
  }), [params]);
}

export function EmbedWidget() {
  const { widget = 'overview' } = useParams();
  const w = widget as Widget;
  const [params] = useSearchParams();
  const title = params.get('title');

  return (
    <div className="min-h-screen bg-background p-3" data-embed-widget={w}>
      {title && <h1 className="mb-3 text-sm font-semibold text-muted-foreground">{title}</h1>}
      {w === 'kpis' && <KpisWidget />}
      {w === 'timeline' && <TimelineWidget />}
      {w === 'status' && <StatusWidget />}
      {w === 'queues' && <QueuesWidget />}
      {w === 'failures' && <FailuresWidget />}
      {w === 'overview' && <OverviewWidget />}
    </div>
  );
}

function OverviewWidget() {
  return (
    <div className="space-y-3">
      <KpisWidget />
      <div className="grid gap-3 md:grid-cols-2">
        <TimelineWidget compact />
        <StatusWidget compact />
      </div>
      <QueuesWidget />
    </div>
  );
}

function KpisWidget() {
  const range = useEmbedRange();
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.statsSummary(range).then((s) => alive && setSummary(s)).catch(() => undefined);
    void load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [range]);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
      <Kpi icon={<Activity className="h-4 w-4" />} label="Total" value={summary?.total ?? '—'} />
      <Kpi icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />} label="Enviados" value={summary?.sent ?? '—'} />
      <Kpi icon={<XCircle className="h-4 w-4 text-red-600" />} label="Fallidos" value={summary?.failed ?? '—'} />
      <Kpi icon={<Clock className="h-4 w-4" />} label="Pendientes" value={summary?.pending ?? '—'} />
      <Kpi icon={<Gauge className="h-4 w-4" />} label="Éxito" value={summary ? `${Math.round(summary.successRate * 100)}%` : '—'} />
      <Kpi icon={<Activity className="h-4 w-4" />} label="Publicando" value={summary?.publishing ?? '—'} />
    </div>
  );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between text-muted-foreground">{icon}<span className="text-[11px] uppercase">{label}</span></div>
        <div className="mt-1 text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}

function TimelineWidget({ compact = false }: { compact?: boolean }) {
  const range = useEmbedRange();
  const [params] = useSearchParams();
  const [data, setData] = useState<StatsTimelinePoint[]>([]);
  const granularity = (params.get('granularity') as 'hour' | 'day' | 'week') || 'day';
  useEffect(() => {
    let alive = true;
    const load = () => api.statsTimeline({ ...range, granularity }).then((d) => alive && setData(d)).catch(() => undefined);
    void load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [range, granularity]);
  return (
    <Card>
      {!compact && <CardHeader><CardTitle className="text-base">Actividad</CardTitle></CardHeader>}
      <CardContent className={compact ? 'p-3' : undefined}>
        <ResponsiveContainer width="100%" height={compact ? 220 : 300}>
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
            <Tooltip />
            <Area type="monotone" dataKey="sent" name="Enviados" stroke={STATUS_COLORS.sent} fill={STATUS_COLORS.sent} fillOpacity={0.25} />
            <Area type="monotone" dataKey="failed" name="Fallidos" stroke={STATUS_COLORS.failed} fill={STATUS_COLORS.failed} fillOpacity={0.18} />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function StatusWidget({ compact = false }: { compact?: boolean }) {
  const range = useEmbedRange();
  const [data, setData] = useState<StatsByStatus[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.statsByStatus(range).then((d) => alive && setData(d)).catch(() => undefined);
    void load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [range]);
  return (
    <Card>
      {!compact && <CardHeader><CardTitle className="text-base">Estados</CardTitle></CardHeader>}
      <CardContent className={compact ? 'p-3' : undefined}>
        <ResponsiveContainer width="100%" height={compact ? 220 : 300}>
          <PieChart>
            <Pie data={data} dataKey="count" nameKey="status" innerRadius={compact ? 45 : 65} outerRadius={compact ? 75 : 105}>
              {data.map((s) => <Cell key={s.status} fill={STATUS_COLORS[s.status] ?? '#888'} />)}
            </Pie>
            <Tooltip formatter={(v: any, _n: any, p: any) => [Number(v), STATUS_LABEL[p.payload.status] ?? p.payload.status]} />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function QueuesWidget() {
  const [queues, setQueues] = useState<OpsQueues | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.opsQueues().then((q) => alive && setQueues(q)).catch(() => undefined);
    void load();
    const id = setInterval(load, 5_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Colas</CardTitle></CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <QueueMini title="resolve" q={queues?.resolve} />
        <QueueMini title="publish" q={queues?.publish} />
      </CardContent>
    </Card>
  );
}

function QueueMini({ title, q }: { title: string; q?: OpsQueues['resolve'] }) {
  const keys = ['waiting', 'active', 'delayed', 'failed'] as const;
  return (
    <div className="rounded-md border p-2">
      <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">{title}</div>
      <div className="grid grid-cols-4 gap-1 text-center text-xs">
        {keys.map((k) => <div key={k} className="rounded bg-muted p-1"><div className="text-[10px] text-muted-foreground">{k}</div><div className="font-mono">{q?.[k] ?? '—'}</div></div>)}
      </div>
    </div>
  );
}

function FailuresWidget() {
  const [items, setItems] = useState<RecentFailure[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.statsRecentFailures(8).then((d) => alive && setItems(d)).catch(() => undefined);
    void load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="h-4 w-4 text-amber-500" /> Fallos recientes</CardTitle></CardHeader>
      <CardContent>
        {items.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Sin fallos recientes 🎉</p> : (
          <div className="divide-y">
            {items.map((f) => <div key={f.id} className="py-2 text-xs"><div className="font-medium">{f.channelName}</div><div className="truncate text-muted-foreground">{f.text}</div><div className="truncate text-red-600">{f.lastError}</div></div>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
