import type {
  CreateJobInput, Job,
  Channel, CreateChannelInput, UpdateChannelInput,
} from '@tamaya/shared-types';

// VITE_API_BASE_URL se inyecta en build a partir de APP_URL:API_PORT en
// docker-compose.yml. Fallback a localhost para dev fuera de Docker.
const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

// Clave del token de API en localStorage. La UI lo guarda tras generarlo en
// Ajustes y lo envía en cada petición como `Authorization: Bearer <token>`.
export const API_TOKEN_STORAGE_KEY = 'tamaya_api_token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(API_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  localStorage.setItem(API_TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(API_TOKEN_STORAGE_KEY);
}

/** Error de API con el status HTTP para que la UI pueda reaccionar (ej. 401). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Añade el header Authorization si hay token guardado. */
export function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = getStoredToken();
  if (token) base['Authorization'] = `Bearer ${token}`;
  return base;
}

/** Notifica a la app un 401 para mostrar el aviso "ve a Ajustes". */
function notifyUnauthorized(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('tamaya:unauthorized'));
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Solo enviamos Content-Type cuando hay body. Fastify rechaza requests con
  // `Content-Type: application/json` y body vacío (ej. DELETE, POST cancel).
  const headers = authHeaders({ ...(init?.headers as Record<string, string> ?? {}) });
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    if (r.status === 401) notifyUnauthorized();
    throw new ApiError(r.status, `${r.status} ${r.statusText}: ${body}`);
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

export type WhatsAppLoginState = 'idle' | 'starting' | 'qr' | 'authenticated' | 'ready' | 'error';
export interface WhatsAppStatus {
  sessionExists: boolean;
  loginState: WhatsAppLoginState;
  lastError: string | null;
  updatedAt: string;
  headless?: boolean;
}
export interface WhatsAppQr {
  qrDataUrl?: string;
  state: WhatsAppLoginState;
}
export interface SelectorsResponse {
  defaults: Record<string, string[]>;
  overrides: Record<string, string[]>;
  effective: Record<string, string[]>;
  editableKeys: string[];
  nonEditableKeys: string[];
}

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
}
export interface OpsQueues {
  resolve: QueueCounts;
  publish: QueueCounts;
}
export interface OpsPublisher {
  controlServerAvailable: boolean;
  controlOnline: boolean;
  sessionExists: boolean | null;
  publisherOnline: boolean;
  publisherLikelyRunning: boolean;
  publisherHeartbeat: { pid?: number; hostname?: string; updatedAt?: string; ageMs?: number } | null;
  publishQueueWaiting: number;
  publishActive: number;
  message: string;
}
export interface OpsHealth {
  ok: boolean;
  db: boolean;
  redis: boolean;
  controlServer: boolean;
  publisherOnline: boolean;
  ts: string;
}
export interface OpsRestartPublisher {
  ok: boolean;
  process: string;
  stdout?: string;
  stderr?: string;
  error?: string;
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
  requeuePublish: (id: string) =>
    req<{ id: string; status: string; requeued: boolean }>(`/jobs/${id}/requeue-publish`, { method: 'POST' }),

  // Ops / diagnóstico
  opsQueues: () => req<OpsQueues>('/ops/queues'),
  opsPublisher: () => req<OpsPublisher>('/ops/publisher'),
  opsHealth: () => req<OpsHealth>('/ops/health'),
  restartPublisher: () => req<OpsRestartPublisher>('/ops/publisher/restart', { method: 'POST' }),

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
    const r = await fetch(`${BASE}/media/upload`, {
      method: 'POST',
      body: fd,
      headers: authHeaders(),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      if (r.status === 401) notifyUnauthorized();
      throw new ApiError(r.status, `${r.status} ${r.statusText}: ${body}`);
    }
    return r.json();
  },

  // Settings — seguridad API
  getSecurity: () => req<{ apiTokenConfigured: boolean }>('/settings/security'),
  generateApiToken: () =>
    req<{ token: string; shownOnce: boolean }>('/settings/security/api-token', {
      method: 'POST',
    }),

  // Settings — WhatsApp (proxy al control server nativo)
  whatsappStatus: () => req<WhatsAppStatus>('/settings/whatsapp/status'),
  whatsappLoginStart: () =>
    req<{ started: boolean; error?: string }>('/settings/whatsapp/login/start', { method: 'POST' }),
  whatsappQr: () => req<WhatsAppQr>('/settings/whatsapp/login/qr'),
  whatsappReset: () =>
    req<{ ok: boolean }>('/settings/whatsapp/session/reset', { method: 'POST' }),

  // Settings — selectores editables
  getSelectors: () => req<SelectorsResponse>('/settings/selectors'),
  putSelectors: (overrides: Record<string, string[]>) =>
    req<{ ok: boolean; overrides: Record<string, string[]>; effective: Record<string, string[]>; note: string }>(
      '/settings/selectors',
      { method: 'PUT', body: JSON.stringify(overrides) },
    ),
  resetSelectors: () =>
    req<{ ok: boolean; overrides: Record<string, string[]>; effective: Record<string, string[]>; note: string }>(
      '/settings/selectors/reset',
      { method: 'POST' },
    ),

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
