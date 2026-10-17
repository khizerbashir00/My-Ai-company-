export class ConnectorHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ConnectorHttpError';
  }
}

export interface HttpGetOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  /** Minimum delay between attempts (ms). Doubles each retry. */
  baseBackoffMs?: number;
}

/**
 * Shared GET helper for connectors: timeout, 429/5xx retry with exponential backoff,
 * AbortSignal support. Does not follow opaque redirects across hosts aggressively —
 * uses fetch defaults.
 */
export async function httpGetJson<T>(opts: HttpGetOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRetries = opts.maxRetries ?? 3;
  const baseBackoffMs = opts.baseBackoffMs ?? 500;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) throw new ConnectorHttpError('Request aborted', undefined, false);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(opts.url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...(opts.headers ?? {}) },
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        const retryable = true;
        if (attempt >= maxRetries) {
          throw new ConnectorHttpError(`Upstream HTTP ${res.status}`, res.status, retryable);
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseBackoffMs * 2 ** attempt;
        await sleep(delay, opts.signal);
        continue;
      }

      if (!res.ok) {
        throw new ConnectorHttpError(`Upstream HTTP ${res.status}`, res.status, false);
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof ConnectorHttpError && !err.retryable) throw err;
      if (attempt >= maxRetries) {
        if (err instanceof ConnectorHttpError) throw err;
        const aborted = err instanceof Error && err.name === 'AbortError';
        throw new ConnectorHttpError(aborted ? 'Request timed out or was cancelled' : 'Network request failed', undefined, !aborted);
      }
      await sleep(baseBackoffMs * 2 ** attempt, opts.signal);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError instanceof Error ? lastError : new ConnectorHttpError('Request failed');
}

export interface HttpPostFormOptions {
  url: string;
  body: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  baseBackoffMs?: number;
}

/** POST application/x-www-form-urlencoded (e.g. OAuth token exchange). */
export async function httpPostForm<T>(opts: HttpPostFormOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRetries = opts.maxRetries ?? 3;
  const baseBackoffMs = opts.baseBackoffMs ?? 500;
  let lastError: unknown;
  const formBody = new URLSearchParams(opts.body).toString();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) throw new ConnectorHttpError('Request aborted', undefined, false);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(opts.headers ?? {}),
        },
        body: formBody,
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxRetries) {
          throw new ConnectorHttpError(`Upstream HTTP ${res.status}`, res.status, true);
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseBackoffMs * 2 ** attempt;
        await sleep(delay, opts.signal);
        continue;
      }

      if (!res.ok) {
        throw new ConnectorHttpError(`Upstream HTTP ${res.status}`, res.status, false);
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof ConnectorHttpError && !err.retryable) throw err;
      if (attempt >= maxRetries) {
        if (err instanceof ConnectorHttpError) throw err;
        const aborted = err instanceof Error && err.name === 'AbortError';
        throw new ConnectorHttpError(aborted ? 'Request timed out or was cancelled' : 'Network request failed', undefined, !aborted);
      }
      await sleep(baseBackoffMs * 2 ** attempt, opts.signal);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError instanceof Error ? lastError : new ConnectorHttpError('Request failed');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ConnectorHttpError('Request aborted', undefined, false));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ConnectorHttpError('Request aborted', undefined, false));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
