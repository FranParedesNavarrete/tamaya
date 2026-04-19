import type {
  CreateJobInput, Job,
  Channel, CreateChannelInput, UpdateChannelInput,
} from '@tamaya/shared-types';

const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Solo enviamos Content-Type cuando hay body. Fastify rechaza requests con
  // `Content-Type: application/json` y body vacío (ej. DELETE, POST cancel).
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> ?? {}) };
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}: ${body}`);
  }
  return r.json();
}

export interface UploadedMedia {
  source: string;
  mime: string;
  size: number;
  originalName: string;
}

export interface StatsRange {
  from?: string;
  to?: string;
  channelId?: string;
}

export interface StatsSummary {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  publishing: number;
  cancelled: number;
  avgDurationMs: number | null;
  totalAttempts: number;
  successRate: number;
}

export interface StatsByStatus { status: string; count: number }
export interface StatsByChannel {
  channelId: string;
  channelName: string;
  total: number;
  sent: number;
  failed: number;
}
export interface StatsTimelinePoint {
  bucket: string;
  sent: number;
  failed: number;
  pending: number;
  cancelled: number;
  publishing: number;
}
export interface StatsMediaTypes {
  textOnly: number;
  image: number;
  video: number;
  mixed: number;
  other: number;
}
export interface StatsHeatmapPoint { dow: number; hour: number; count: number }
export interface StatsDurationBucket { bucket: string; count: number }
export interface RecentFailure {
  id: string;
  channelName: string;
  text: string | null;
  lastError: string | null;
  scheduledAt: string;
  attemptCount: number;
}

export interface JobSearchParams extends StatsRange {
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

function toQuery(params: object): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

export const api = {
  // Jobs
  createJob: (input: CreateJobInput) =>
    req<{ id: string; status: string }>('/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listJobs: (params?: JobSearchParams | string) => {
    if (typeof params === 'string') {
      return req<Job[]>(`/jobs${params ? `?status=${params}` : ''}`);
    }
    return req<Job[]>(`/jobs${toQuery(params ?? {})}`);
  },
  getJob: (id: string) => req<Job>(`/jobs/${id}`),
  cancelJob: (id: string) =>
    req<{ id: string; status: string }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  deleteJob: (id: string) =>
    req<{ id: string; deleted: boolean }>(`/jobs/${id}`, { method: 'DELETE' }),

  // Channels
  listChannels: () => req<Channel[]>('/channels'),
  getChannel: (id: string) => req<Channel>(`/channels/${id}`),
  createChannel: (input: CreateChannelInput) =>
    req<{ id: string }>('/channels', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateChannel: (id: string, input: UpdateChannelInput) =>
    req<{ id: string }>(`/channels/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteChannel: (id: string) =>
    req<{ id: string; deleted: boolean }>(`/channels/${id}`, { method: 'DELETE' }),

  // Media
  uploadMedia: async (file: File): Promise<UploadedMedia> => {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${BASE}/media/upload`, { method: 'POST', body: fd });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`${r.status} ${r.statusText}: ${body}`);
    }
    return r.json();
  },

  // Stats
  statsSummary: (range?: StatsRange) =>
    req<StatsSummary>(`/stats/summary${toQuery(range ?? {})}`),
  statsByStatus: (range?: StatsRange) =>
    req<StatsByStatus[]>(`/stats/by-status${toQuery(range ?? {})}`),
  statsByChannel: (range?: StatsRange) =>
    req<StatsByChannel[]>(`/stats/by-channel${toQuery(range ?? {})}`),
  statsTimeline: (range: StatsRange & { granularity?: 'hour' | 'day' | 'week' } = {}) =>
    req<StatsTimelinePoint[]>(`/stats/timeline${toQuery(range)}`),
  statsMediaTypes: (range?: StatsRange) =>
    req<StatsMediaTypes>(`/stats/media-types${toQuery(range ?? {})}`),
  statsHeatmap: (range?: StatsRange) =>
    req<StatsHeatmapPoint[]>(`/stats/hourly-heatmap${toQuery(range ?? {})}`),
  statsDuration: (range?: StatsRange) =>
    req<StatsDurationBucket[]>(`/stats/duration-distribution${toQuery(range ?? {})}`),
  statsRecentFailures: (limit = 10) =>
    req<RecentFailure[]>(`/stats/recent-failures?limit=${limit}`),
};
