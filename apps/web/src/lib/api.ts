/** Thin fetch wrapper. The session lives in an httpOnly cookie, so no token handling happens here. */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

export const UNAUTHORIZED_EVENT = 'hq:unauthorized';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Can’t reach the server. Check that the API is running.');
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const raw = (data as { message?: string | string[]; requestId?: string } | null) ?? {};
    const message = Array.isArray(raw.message) ? raw.message.join('. ') : (raw.message ?? res.statusText);
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, capitalize(message), raw.requestId);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
};

/** Builds a query string, skipping empty values. */
export function qs(params: Record<string, string | number | undefined | null | string[]>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(','));
    } else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
