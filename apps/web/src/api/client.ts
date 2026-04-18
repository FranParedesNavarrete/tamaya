import type {
  CreateJobInput, Job,
  Channel, CreateChannelInput, UpdateChannelInput,
} from '@tamaya/shared-types';

const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
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

export const api = {
  // Jobs
  createJob: (input: CreateJobInput) =>
    req<{ id: string; status: string }>('/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listJobs: (status?: string) =>
    req<Job[]>(`/jobs${status ? `?status=${status}` : ''}`),
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
};
