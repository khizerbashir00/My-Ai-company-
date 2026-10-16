import { HackerNewsConnector } from '../connectors/hacker-news/hn.connector';
import { ConnectorRegistry } from '../connectors/connector.registry';
import { ScanService } from './scan.service';
import * as http from '../connectors/http-client';

describe('ScanService (dedupe + ingest)', () => {
  const connector = new HackerNewsConnector();
  const registry = {
    get: (key: string) => (key === 'hacker_news' ? connector : undefined),
    require: (key: string) => {
      if (key !== 'hacker_news') throw new Error('missing');
      return connector;
    },
  } as unknown as ConnectorRegistry;

  function makeScan() {
    const created: string[] = [];
    const leads = {
      ingestFromConnector: jest.fn(async (dto: { externalId?: string }) => {
        if (created.includes(dto.externalId ?? '')) {
          return { created: false, leadId: 'existing', duplicate: true, match: 'external_id' };
        }
        created.push(dto.externalId ?? '');
        return { created: true, leadId: `lead-${dto.externalId}`, duplicate: false };
      }),
    };
    const tasks = { createAs: jest.fn(async () => ({ task: { id: 't1' }, deduplicated: false })) };
    const events = { emit: jest.fn() };
    const runRow = {
      id: 'run-1',
      status: 'QUEUED',
      connectionId: 'conn-1',
      connection: {
        id: 'conn-1',
        sourceId: 'src-1',
        cursor: null,
        config: { query: 'website', maxResults: 10, maxPages: 1, hitsPerPage: 20 },
        source: { key: 'hacker_news', id: 'src-1' },
      },
    };

    const prisma = {
      sourceScanRun: {
        findUnique: jest.fn(async () => runRow),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...runRow, ...data })),
      },
      sourceConnection: {
        update: jest.fn(async () => ({})),
      },
      agentDefinition: {
        findUnique: jest.fn(async () => ({ id: 'worker', isEnabled: true })),
      },
      user: {
        findFirst: jest.fn(async () => ({ id: 'ceo' })),
      },
      $transaction: jest.fn(async (ops: unknown) => {
        if (Array.isArray(ops)) return Promise.all(ops);
        return ops;
      }),
    };

    const scan = new ScanService(prisma as never, registry, leads as never, tasks as never, events as never);
    return { scan, leads, tasks, prisma, created };
  }

  afterEach(() => jest.restoreAllMocks());

  it('ingests new items and dedupes repeats without creating duplicates', async () => {
    jest.spyOn(http, 'httpGetJson').mockResolvedValue({
      hits: [
        { objectID: '99', title: 'Need a website', author: 'x', created_at_i: 1_700_000_000 },
        { objectID: '99', title: 'Need a website', author: 'x', created_at_i: 1_700_000_000 },
      ],
      page: 0,
      nbPages: 1,
      hitsPerPage: 20,
      nbHits: 2,
    });

    const { scan, leads, prisma } = makeScan();
    // First call creates; second same externalId reports duplicate inside ingestFromConnector mock.
    // Simulate prepare-level dedupe by tracking in the mock (see makeScan).
    await scan.executeRun('run-1');

    expect(leads.ingestFromConnector).toHaveBeenCalled();
    const updates = (prisma.sourceScanRun.update as jest.Mock).mock.calls.map((c) => c[0].data);
    const final = updates.find((d) => d.status === 'SUCCEEDED');
    expect(final).toBeDefined();
    expect(final.itemsCreated).toBe(1);
    expect(final.itemsDeduped).toBe(1);
  });

  it('marks the run FAILED and connection ERROR on upstream failure', async () => {
    jest.spyOn(http, 'httpGetJson').mockRejectedValue(new http.ConnectorHttpError('Upstream HTTP 503', 503, true));
    const { scan, prisma } = makeScan();
    await expect(scan.executeRun('run-1')).rejects.toBeInstanceOf(http.ConnectorHttpError);
    const failUpdate = (prisma.sourceScanRun.update as jest.Mock).mock.calls.map((c) => c[0].data).find((d) => d.status === 'FAILED');
    expect(failUpdate?.errorMessage).toMatch(/503/);
  });
});
