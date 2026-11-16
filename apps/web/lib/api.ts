import type { AuthResponse } from '@assessiq/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

// The access token lives only in memory. The refresh token is an httpOnly cookie the browser
// sends automatically, so no token is ever readable by page scripts or stored in localStorage.
let accessToken: string | null = null;
let refreshing: Promise<AuthResponse | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send the access token (default true). */
  auth?: boolean;
}

async function send(path: string, { method = 'GET', body, auth = true }: Options) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`${API_URL}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function toError(res: Response): Promise<ApiError> {
  let data: { message?: string | string[]; code?: string; errors?: Record<string, string[]> } = {};
  try {
    data = await res.json();
  } catch {
    // not JSON
  }
  const message = Array.isArray(data.message) ? data.message.join(', ') : data.message;
  return new ApiError(message ?? 'Something went wrong', res.status, data.code, data.errors);
}

/** Exchanges the refresh cookie for a new access token. Resolves to null when signed out. */
export function refreshSession(): Promise<AuthResponse | null> {
  // Share one in-flight refresh: refresh tokens rotate, so two parallel calls would clash.
  refreshing ??= (async () => {
    try {
      const res = await send('/auth/refresh', { method: 'POST', auth: false });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const data = (await res.json()) as AuthResponse;
      accessToken = data.accessToken;
      return data;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  let res = await send(path, options);

  if (res.status === 401 && options.auth !== false && !path.startsWith('/auth/')) {
    const renewed = await refreshSession();
    if (renewed) res = await send(path, options);
  }

  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
