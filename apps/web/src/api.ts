import type { JoinRequest, JoinResponse, Me } from '@party/shared';

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? 'Something went wrong'), { status: res.status });
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const api = {
  me: () => request<{ me: Me }>('/api/me').then((r) => r.me).catch((e) => (e.status === 401 ? null : Promise.reject(e))),
  join: (body: JoinRequest) => post<JoinResponse>('/api/join', body),
  setPin: (pin: string | null) => post<{ me: Me }>('/api/pin', { pin }).then((r) => r.me),
  logout: () => post<{ ok: true }>('/api/logout'),
};

export const adminApi = {
  me: () => request<{ ok: true }>('/api/admin/me').then(() => true).catch(() => false),
  login: (password: string) => post<{ ok: true }>('/api/admin/login', { password }),
  logout: () => post<{ ok: true }>('/api/admin/logout'),
};
