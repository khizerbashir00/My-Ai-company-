import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Play, RefreshCw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Empty, ErrorNote, Field, Input, Loading, PageHeader, Pagination, Section, Textarea, cx } from '../components/ui';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, timeAgo } from '../lib/format';
import type { Page } from '../lib/types';

type DisplayStatus =
  | 'MANUAL_FALLBACK'
  | 'UNIMPLEMENTED'
  | 'UNCONFIGURED'
  | 'UNAUTHORIZED'
  | 'UNAVAILABLE'
  | 'DISABLED'
  | 'ERROR'
  | 'CONFIGURED'
  | 'WORKING';

interface SourceItem {
  id: string;
  key: string;
  name: string;
  platform: string;
  accessMethod: string;
  description: string;
  complianceNotes: string;
  capabilities: string[];
  scanIntervalMinutes: number;
  isEnabled: boolean;
  displayStatus: DisplayStatus;
  implemented: boolean;
  authorized: boolean;
  configErrors: string[];
  connector: {
    documentationUrl: string;
    credentialsEnv: string | null;
    requiredConfigKeys: string[];
    defaultMaxResults: number;
    defaultScanIntervalMinutes: number;
  } | null;
  connection: {
    id: string;
    label: string;
    status: string;
    config: Record<string, unknown> | null;
    lastSyncAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastSuccessfulRun: { id: string; finishedAt: string | null; itemsCreated: number; itemsFound: number } | null;
  } | null;
  permissions: { canScan: boolean; canConfigure: boolean; manualImportFallback: boolean };
}

interface SourcesResponse {
  jobsMode: 'bullmq' | 'inline';
  redisConfigured: boolean;
  implementedConnectors: { key: string; name: string; documentationUrl: string }[];
  items: SourceItem[];
}

interface ScanRun {
  id: string;
  status: string;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  itemsFound: number;
  itemsCreated: number;
  itemsDeduped: number;
  itemsSkipped: number;
  errorMessage: string | null;
  createdAt: string;
  connection: { id: string; label: string; source: { id: string; key: string; name: string } };
}

const STATUS_LABEL: Record<DisplayStatus, string> = {
  MANUAL_FALLBACK: 'Manual fallback',
  UNIMPLEMENTED: 'Not implemented',
  UNCONFIGURED: 'Unconfigured',
  UNAUTHORIZED: 'Unauthorized',
  UNAVAILABLE: 'Unavailable',
  DISABLED: 'Disabled',
  ERROR: 'Error',
  CONFIGURED: 'Configured',
  WORKING: 'Working',
};

const STATUS_CLASS: Record<DisplayStatus, string> = {
  MANUAL_FALLBACK: 'text-ink-2',
  UNIMPLEMENTED: 'text-ink-3',
  UNCONFIGURED: 'text-st-waiting',
  UNAUTHORIZED: 'text-st-failed',
  UNAVAILABLE: 'text-st-waiting',
  DISABLED: 'text-ink-3',
  ERROR: 'text-st-failed',
  CONFIGURED: 'text-st-queued',
  WORKING: 'text-st-done',
};

export function SourcesPage() {
  const { canWrite } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'connectors';
  const qc = useQueryClient();

  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.get<SourcesResponse>('/sources') });

  return (
    <>
      <PageHeader
        title="Sources"
        description="Lead connectors use only official or permitted APIs. Unimplemented platforms are never shown as connected. Manual import remains the fallback."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant={tab === 'connectors' ? 'secondary' : 'quiet'} onClick={() => setParams({}, { replace: true })}>
              Connectors
            </Button>
            <Button
              variant={tab === 'history' ? 'secondary' : 'quiet'}
              onClick={() => setParams({ tab: 'history' }, { replace: true })}
            >
              Scan history
            </Button>
            {canWrite && (
              <Link
                to="/leads?import=1"
                className="inline-flex h-9 items-center gap-2 rounded-md border border-rule-strong bg-panel px-3 text-sm font-medium text-ink-2 hover:text-ink"
              >
                Manual CSV import
              </Link>
            )}
          </div>
        }
      />

      {sources.isPending ? (
        <Loading label="Loading sources" />
      ) : sources.isError ? (
        <ErrorNote error={sources.error} />
      ) : tab === 'history' ? (
        <ScanHistory />
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-ink-2">
            Job runner: <span className="font-medium text-ink">{sources.data.jobsMode === 'bullmq' ? 'BullMQ + Redis' : 'Inline (Redis not connected)'}</span>
            {sources.data.redisConfigured && sources.data.jobsMode === 'inline' ? ' — REDIS_URL is set but Redis was unreachable at boot.' : null}
            . Implemented connectors: {sources.data.implementedConnectors.map((c) => c.name).join(', ') || 'none'}.
          </p>

          <div className="grid gap-4">
            {sources.data.items.map((s) => (
              <SourceCard key={s.id} source={s} canWrite={canWrite} onChanged={() => void qc.invalidateQueries({ queryKey: ['sources'] })} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function SourceCard({ source: s, canWrite, onChanged }: { source: SourceItem; canWrite: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState(String(s.connection?.config?.query ?? ''));
  const [maxResults, setMaxResults] = useState(String(s.connection?.config?.maxResults ?? s.connector?.defaultMaxResults ?? 40));
  const [intervalMin, setIntervalMin] = useState(String(s.scanIntervalMinutes));
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/sources/connections/${s.connection!.id}`, {
        config: {
          ...(s.connection?.config ?? {}),
          query: query.trim(),
          maxResults: Number(maxResults) || 40,
        },
        scanIntervalMinutes: Number(intervalMin) || 0,
      }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });

  const scan = useMutation({
    mutationFn: () => api.post<{ scanRunId: string; jobsMode: string }>(`/sources/connections/${s.connection!.id}/scan`),
    onSuccess: (res) => {
      setScanMsg(`Scan queued (${res.jobsMode}). Run ${res.scanRunId.slice(0, 8)}…`);
      onChanged();
      void setTimeout(onChanged, 1500);
    },
  });

  return (
    <Section
      title={s.name}
      aside={
        <span className={cx('text-[13px] font-semibold', STATUS_CLASS[s.displayStatus])}>{STATUS_LABEL[s.displayStatus]}</span>
      }
    >
      <div className="space-y-3 px-4 py-4 text-sm">
        <p className="text-ink-2">{s.description}</p>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-[13px] text-ink-3">Access</dt>
            <dd>{s.accessMethod.replace(/_/g, ' ')}</dd>
          </div>
          <div>
            <dt className="text-[13px] text-ink-3">Capabilities</dt>
            <dd>{s.capabilities.length ? s.capabilities.join(', ') : '—'}</dd>
          </div>
          <div>
            <dt className="text-[13px] text-ink-3">Last success</dt>
            <dd>{s.connection?.lastSuccessAt ? timeAgo(s.connection.lastSuccessAt) : 'Never'}</dd>
          </div>
          <div>
            <dt className="text-[13px] text-ink-3">Scan interval</dt>
            <dd>{s.scanIntervalMinutes > 0 ? `${s.scanIntervalMinutes} min` : 'Manual only'}</dd>
          </div>
        </dl>
        {s.complianceNotes && <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-2">{s.complianceNotes}</p>}
        {s.connection?.lastError && <p className="text-[13px] text-st-failed">Last error: {s.connection.lastError}</p>}
        {s.configErrors.length > 0 && <p className="text-[13px] text-st-waiting">Config: {s.configErrors.join(' ')}</p>}

        {s.key === 'manual_import' && (
          <p className="text-ink-2">
            Use <Link className="font-medium text-brand hover:underline" to="/leads?new=1">New lead</Link> or{' '}
            <Link className="font-medium text-brand hover:underline" to="/leads?import=1">CSV import</Link> when remote connectors are
            unavailable.
          </p>
        )}

        {s.connector && (
          <p className="text-[13px] text-ink-3">
            Docs:{' '}
            <a className="text-brand hover:underline" href={s.connector.documentationUrl} target="_blank" rel="noreferrer">
              {s.connector.documentationUrl}
            </a>
            {s.connector.credentialsEnv ? ` · Credentials env: ${s.connector.credentialsEnv}` : ' · No API key required'}
          </p>
        )}

        {canWrite && s.permissions.canConfigure && s.connection && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="quiet" onClick={() => setEditing((v) => !v)}>
              <Link2 className="size-4" aria-hidden />
              {editing ? 'Close' : 'Configure'}
            </Button>
            <Button
              variant="primary"
              busy={scan.isPending}
              disabled={!s.permissions.canScan}
              onClick={() => scan.mutate()}
            >
              <Play className="size-4" aria-hidden />
              Run scan
            </Button>
          </div>
        )}
        {scanMsg && <p className="text-[13px] text-st-done">{scanMsg}</p>}
        {scan.isError && <ErrorNote error={scan.error} />}

        {editing && s.connection && (
          <form
            className="mt-2 space-y-3 rounded-md border border-rule p-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Field label="Search query" hint="Full-text query sent to the provider API.">
              {(id) => <Textarea id={id} value={query} onChange={(e) => setQuery(e.target.value)} rows={3} required />}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Max results per scan">
                {(id) => <Input id={id} type="number" min={1} max={200} value={maxResults} onChange={(e) => setMaxResults(e.target.value)} />}
              </Field>
              <Field label="Scan interval (minutes)" hint="0 = manual only.">
                {(id) => <Input id={id} type="number" min={0} max={10080} value={intervalMin} onChange={(e) => setIntervalMin(e.target.value)} />}
              </Field>
            </div>
            {save.isError && <ErrorNote error={save.error} />}
            <Button type="submit" variant="primary" busy={save.isPending}>
              Save configuration
            </Button>
          </form>
        )}
      </div>
    </Section>
  );
}

function ScanHistory() {
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: ['source-scans', page],
    queryFn: () =>
      api.get<
        Page<ScanRun> & {
          summary: { failed: number; succeeded: number; lastSuccessfulRun: { id: string; finishedAt: string | null } | null };
        }
      >(`/sources/scans${qs({ page, pageSize: 20 })}`),
    refetchInterval: 4_000,
  });

  if (history.isPending) return <Loading label="Loading scan history" />;
  if (history.isError) return <ErrorNote error={history.error} />;

  const { items, total, totalPages, summary } = history.data;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Successful runs" value={String(summary.succeeded)} />
        <Stat label="Failed runs" value={String(summary.failed)} />
        <Stat
          label="Last successful run"
          value={summary.lastSuccessfulRun?.finishedAt ? formatDate(summary.lastSuccessfulRun.finishedAt) : '—'}
        />
      </div>

      {items.length === 0 ? (
        <Empty title="No scans yet">Run a scan from the Connectors tab.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-md border border-rule">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-rule bg-sunken text-[13px] text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Counts</th>
                <th className="px-3 py-2 font-medium">Duration</th>
                <th className="px-3 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {items.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 font-medium">{r.connection.source.name}</td>
                  <td className="px-3 py-2">
                    <span className={cx(r.status === 'FAILED' ? 'text-st-failed' : r.status === 'SUCCEEDED' ? 'text-st-done' : 'text-ink-2')}>
                      {r.status}
                    </span>
                    {r.errorMessage && <p className="max-w-[28ch] truncate text-[12px] text-st-failed" title={r.errorMessage}>{r.errorMessage}</p>}
                  </td>
                  <td className="px-3 py-2 text-ink-2">{r.trigger}</td>
                  <td className="px-3 py-2 num text-ink-2">
                    {r.itemsCreated} new · {r.itemsDeduped} dup · {r.itemsFound} found
                  </td>
                  <td className="px-3 py-2 num text-ink-2">{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="px-3 py-2 text-ink-3">{timeAgo(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button variant="quiet" onClick={() => void history.refetch()} aria-label="Refresh">
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      </div>
      <Pagination page={page} totalPages={totalPages} total={total} onPage={setPage} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-rule px-4 py-3">
      <p className="text-[13px] text-ink-3">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}
