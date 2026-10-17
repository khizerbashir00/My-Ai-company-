/**
 * Minimal HTTP boundary for OAuth providers. Injected as SOCIAL_HTTP so e2e tests can stand in for
 * LinkedIn/Facebook/Reddit/X without network access. Production uses global fetch with a timeout.
 */
export interface SocialHttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** application/x-www-form-urlencoded body */
  form?: Record<string, string>;
}

export interface SocialHttpResponse {
  status: number;
  /** Parsed JSON body, or null when the body is empty / not JSON */
  json: unknown;
}

export type SocialHttp = (req: SocialHttpRequest) => Promise<SocialHttpResponse>;

export const SOCIAL_HTTP = Symbol('SOCIAL_HTTP');

const TIMEOUT_MS = 15_000;

export const fetchSocialHttp: SocialHttp = async (req) => {
  const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(req.form).toString();
  }
  const res = await fetch(req.url, { method: req.method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
};
