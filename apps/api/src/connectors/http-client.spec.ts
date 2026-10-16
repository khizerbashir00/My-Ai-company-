import { ConnectorHttpError, httpGetJson } from './http-client';

describe('httpGetJson', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns JSON on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ hits: [] }),
    }) as unknown as typeof fetch;

    await expect(httpGetJson({ url: 'https://example.test/api', maxRetries: 0 })).resolves.toEqual({ hits: [] });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 with backoff then succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '0' }),
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ ok: true }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(httpGetJson({ url: 'https://example.test/api', maxRetries: 2, baseBackoffMs: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable 4xx', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      json: async () => ({}),
    }) as unknown as typeof fetch;

    await expect(httpGetJson({ url: 'https://example.test/api', maxRetries: 3, baseBackoffMs: 1 })).rejects.toBeInstanceOf(
      ConnectorHttpError,
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('honors AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(httpGetJson({ url: 'https://example.test/api', signal: controller.signal, maxRetries: 0 })).rejects.toMatchObject({
      message: expect.stringMatching(/abort/i),
    });
  });
});
