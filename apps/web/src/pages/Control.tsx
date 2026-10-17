import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  ExternalLink,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  Square,
  Unplug,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Empty, ErrorNote, Loading, PageHeader, Section, StatusBadge, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AGENT_KIND_LABEL, formatInt, timeAgo } from '../lib/format';
import type {
  AgentState,
  ConnectAllResult,
  ControlActionResult,
  ControlAgent,
  ControlStatus,
  ControlWorkflow,
  SocialPlatformStatus,
  SocialStatus,
  WorkflowState,
} from '../lib/types';

const REASONS: Record<string, string> = {
  denied: 'You cancelled or declined the authorization.',
  invalid_state: 'The sign-in link was invalid or already used. Start the connection again.',
  expired_state: 'The sign-in link expired (10 minutes). Start the connection again.',
  exchange_failed: 'The platform rejected the authorization code. Check the client ID/secret and redirect URL, then try again.',
  missing_code: 'The platform did not return an authorization code.',
  not_allowed: 'Only an active CEO account can connect company social accounts.',
  not_configured: 'Server configuration changed during sign-in. Try again.',
  provider_error: 'The platform returned an error during authorization.',
};

export function ControlPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canWrite = user?.role === 'CEO' || user?.role === 'ADMIN';
  const isCeo = user?.role === 'CEO';
  const [params, setParams] = useSearchParams();
  const [result, setResult] = useState<ControlActionResult | null>(null);

  const status = useQuery({
    queryKey: ['control-status'],
    queryFn: () => api.get<ControlStatus>('/control/status'),
    // SSE invalidates on change; polling keeps timers and durations fresh and covers missed events.
    refetchInterval: 5_000,
    staleTime: 2_000,
  });

  const afterAction = (r: ControlActionResult) => {
    setResult(r);
    void qc.invalidateQueries({ queryKey: ['control-status'] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['metrics'] });
  };

  const startAll = useMutation({ mutationFn: () => api.post<ControlActionResult>('/control/start-all'), onSuccess: afterAction });
  const stopAll = useMutation({ mutationFn: () => api.post<ControlActionResult>('/control/stop-all'), onSuccess: afterAction });
  const restartFailed = useMutation({ mutationFn: () => api.post<ControlActionResult>('/control/restart-failed'), onSuccess: afterAction });
  const connectAll = useMutation({
    mutationFn: () => api.post<ConnectAllResult>('/control/connect-all'),
    onSuccess: (r) => {
      if (r.next) {
        // Real redirect to the platform's official consent screen; the callback brings the browser back here.
        window.location.assign(r.next.authorizationUrl);
        return;
      }
      afterAction(r);
    },
  });

  // Return from an OAuth callback: show the outcome, and keep the Connect All chain going on success.
  const handled = useRef(false);
  const [oauthBanner, setOauthBanner] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (handled.current) return;
    const social = params.get('social');
    const res = params.get('result');
    if (!social || !res) return;
    handled.current = true;
    const name = { linkedin: 'LinkedIn', facebook: 'Facebook', reddit: 'Reddit', x: 'X (Twitter)' }[social] ?? social;
    const chain = params.get('connectAll') === '1';
    setOauthBanner(
      res === 'connected'
        ? { ok: true, text: `${name} connected.${chain ? ' Continuing with the next platform…' : ''}` }
        : { ok: false, text: `${name} was not connected. ${REASONS[params.get('reason') ?? ''] ?? 'Please try again.'}` },
    );
    setParams({}, { replace: true });
    void qc.invalidateQueries({ queryKey: ['control-status'] });
    if (res === 'connected' && chain && isCeo) connectAll.mutate();
  }, [params, setParams, qc, isCeo, connectAll]);

  const busy = startAll.isPending || stopAll.isPending || restartFailed.isPending || connectAll.isPending;
  const actionError = startAll.error ?? stopAll.error ?? restartFailed.error ?? connectAll.error;

  return (
    <>
      <PageHeader
        title="Control Center"
        description="Start, stop and watch every AI agent, background job and social connection. Each button runs a real server operation and is recorded in the audit log."
        actions={
          canWrite ? (
            <>
              {isCeo && (
                <Button onClick={() => connectAll.mutate()} busy={connectAll.isPending} disabled={busy}>
                  <Plug className="size-4" aria-hidden />
                  Connect All
                </Button>
              )}
              <Button onClick={() => restartFailed.mutate()} busy={restartFailed.isPending} disabled={busy}>
                <RotateCcw className="size-4" aria-hidden />
                Restart Failed
              </Button>
              <ConfirmButton onConfirm={() => stopAll.mutate()} busy={stopAll.isPending} disabled={busy} label="Stop All" confirmLabel="Confirm Stop All" />
              <Button variant="primary" onClick={() => startAll.mutate()} busy={startAll.isPending} disabled={busy}>
                <Play className="size-4" aria-hidden />
                Start All
              </Button>
            </>
          ) : (
            <p className="text-sm text-ink-3">Read-only: ask the CEO or an admin to start or stop work.</p>
          )
        }
      />

      {oauthBanner && <Banner ok={oauthBanner.ok} onClose={() => setOauthBanner(null)}>{oauthBanner.text}</Banner>}
      <ErrorNote error={actionError} className="mb-4" />
      {result && <ResultPanel result={result} onClose={() => setResult(null)} />}

      {status.isPending ? (
        <Loading label="Loading company status" />
      ) : status.isError ? (
        <ErrorNote error={status.error} />
      ) : (
        <Dashboard data={status.data} canWrite={canWrite} isCeo={isCeo} />
      )}
    </>
  );
}

function Dashboard({ data, canWrite, isCeo }: { data: ControlStatus; canWrite: boolean; isCeo: boolean }) {
  const t = data.totals;
  const worker = data.workflows.find((w) => w.key === 'ai-task-worker');
  const attention = (t.tasks.FAILED ?? 0) + (t.tasks.AWAITING_APPROVAL ?? 0);
  const jobsRunning = (worker?.detail.current ? 1 : 0) + t.scansActive;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Agents working" value={`${t.agents.working}`} sub={`of ${t.agents.enabled} enabled`} tone={t.agents.working ? 'running' : undefined} />
        <Stat label="Queued tasks" value={formatInt(t.tasks.QUEUED ?? 0)} sub={`${formatInt(t.tasks.RUNNING ?? 0)} running`} />
        <Stat label="Needs attention" value={formatInt(attention)} sub="failed or awaiting you" tone={attention ? 'waiting' : undefined} />
        <Stat label="Jobs running" value={formatInt(jobsRunning)} sub={`${t.scansActive} scan(s)`} tone={jobsRunning ? 'running' : undefined} />
        <Stat label="Social connected" value={`${t.socialConnected}/${t.socialTotal}`} sub="LinkedIn · Facebook · Reddit · X" />
      </div>

      {data.recovery && data.recovery.tasksFailed + data.recovery.scanRunsFailed + data.recovery.scanRunsRequeued > 0 && (
        <p role="status" className="rounded-md bg-st-waiting-wash px-3 py-2 text-sm text-st-waiting">
          After the last server restart, {data.recovery.tasksFailed} interrupted task(s) and {data.recovery.scanRunsFailed} scan(s) were marked failed so they can be
          retried — use <span className="font-medium">Restart Failed</span>.
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_1fr]">
        <Section title="Workflows & background jobs">
          <ul className="divide-y divide-rule">
            {data.workflows.map((w) => (
              <WorkflowRow key={w.key} w={w} canWrite={canWrite} />
            ))}
          </ul>
          {data.monitors.map((m) => (
            <p key={m.key} className="border-t border-rule px-4 py-2.5 text-[13px] text-ink-3">
              <span className="font-medium text-ink-2">{m.name}:</span> {m.enabled ? 'on' : 'off (no budget set)'} — {m.note}
            </p>
          ))}
        </Section>

        <Section title="Social connections" aside={<span className="num text-[13px] text-ink-3">{t.socialConnected} of {t.socialTotal} connected</span>}>
          <ul className="divide-y divide-rule">
            {data.social.map((s) => (
              <SocialRow key={s.platform} s={s} isCeo={isCeo} canWrite={canWrite} redditScanAuth={s.platform === 'REDDIT' ? data.redditScanAuth : null} />
            ))}
          </ul>
        </Section>
      </div>

      <AgentsSection agents={data.agents} people={data.people} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <JobsSection jobs={data.jobs} />
        <LogSection events={data.events} />
      </div>
    </div>
  );
}

// ───────────────────────────── pieces ─────────────────────────────

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'running' | 'waiting' }) {
  return (
    <div className="rounded-lg border border-rule bg-panel px-4 py-3">
      <p className="text-[13px] text-ink-3">{label}</p>
      <p className={cx('num mt-0.5 text-2xl font-semibold', tone === 'running' ? 'text-st-running' : tone === 'waiting' ? 'text-st-waiting' : 'text-ink')}>{value}</p>
      <p className="text-[13px] text-ink-3">{sub}</p>
    </div>
  );
}

const WF_STYLE: Record<WorkflowState, { label: string; cls: string; dot: string }> = {
  running: { label: 'Running', cls: 'text-st-running', dot: 'bg-st-running motion-safe:animate-pulse' },
  idle: { label: 'On · idle', cls: 'text-st-done', dot: 'bg-st-done' },
  stopped: { label: 'Stopped', cls: 'text-ink-3', dot: 'bg-st-cancelled' },
  blocked: { label: 'Blocked', cls: 'text-st-waiting bg-st-waiting-wash', dot: 'bg-st-waiting' },
};

function Pill({ label, cls, dot }: { label: string; cls: string; dot: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[13px] font-medium', cls)}>
      <span aria-hidden className={cx('size-2 rounded-full', dot)} />
      {label}
    </span>
  );
}

function WorkflowRow({ w, canWrite }: { w: ControlWorkflow; canWrite: boolean }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => api.post<ControlActionResult>(`/control/workflows/${w.key}/${w.enabled ? 'stop' : 'start'}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['control-status'] }),
  });
  const d = w.detail;
  const lastFailure = toggle.data && !toggle.data.ok ? toggle.data.items.find((i) => !i.ok)?.message : null;

  return (
    <li className="px-4 py-3.5" data-testid={`workflow-${w.key}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-ink">{w.name}</p>
            <Pill {...WF_STYLE[w.state]} />
          </div>
          <p className="mt-1 max-w-[70ch] text-[13px] text-ink-3">{w.description}</p>
        </div>
        {canWrite && (
          <Button variant={w.enabled ? 'danger' : 'secondary'} onClick={() => toggle.mutate()} busy={toggle.isPending} aria-label={`${w.enabled ? 'Stop' : 'Start'} ${w.name}`}>
            {w.enabled ? <Square className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            {w.enabled ? 'Stop' : 'Start'}
          </Button>
        )}
      </div>

      <div className="mt-2 space-y-1 text-[13px] text-ink-2">
        {w.key === 'ai-task-worker' && (
          <>
            {d.current ? (
              <p>
                <Activity className="mr-1 inline size-3.5 text-st-running" aria-hidden />
                Now: <Link className="font-medium text-brand hover:underline" to={`/tasks/${d.current.taskId}`}>{d.current.title}</Link>
                {d.current.agentName ? ` · ${d.current.agentName}` : ''} · started {timeAgo(d.current.startedAt)}
              </p>
            ) : null}
            <p className="num">
              {d.eligibleQueuedTasks ?? 0} eligible queued task(s) · since restart: {d.processed ?? 0} run, {d.succeeded ?? 0} completed, {d.failed ?? 0} failed/blocked
            </p>
          </>
        )}
        {w.key === 'lead-source-scans' && (
          <p className="num">
            {d.jobsMode === 'bullmq' ? 'BullMQ (Redis)' : 'Inline (no Redis)'} · queue {d.queuePaused ? 'paused' : 'active'} · {d.activeScans ?? 0} scan(s) in progress ·{' '}
            {d.authorizedSources ?? 0} authorized source(s)
          </p>
        )}
        {w.key === 'outreach-follow-ups' && (
          <p className="num">
            {d.dueNow ?? 0} due now · {d.scheduled ?? 0} scheduled · email {d.emailConfigured ? 'configured' : 'not configured (sends stay blocked)'}
          </p>
        )}
        {w.blockedReason && <p className="text-st-waiting">{w.blockedReason}</p>}
        {lastFailure && <p className="text-st-waiting">{lastFailure}</p>}
        {w.lastTickAt && (
          <p className="text-ink-3">
            Last check {timeAgo(w.lastTickAt)}
            {w.lastResult ? ` — ${w.lastResult}` : ''}
          </p>
        )}
        {w.lastError && w.lastErrorAt && (
          <p className="text-st-failed">
            Last error {timeAgo(w.lastErrorAt)}: {w.lastError}
          </p>
        )}
        <ErrorNote error={toggle.error} />
      </div>
    </li>
  );
}

const SOCIAL_STYLE: Record<SocialStatus, { label: string; cls: string; dot: string }> = {
  CONNECTED: { label: 'Connected', cls: 'text-st-done', dot: 'bg-st-done' },
  NOT_CONNECTED: { label: 'Not connected', cls: 'text-ink-3', dot: 'bg-st-cancelled' },
  NOT_CONFIGURED: { label: 'Needs setup', cls: 'text-st-waiting bg-st-waiting-wash', dot: 'bg-st-waiting' },
  EXPIRED: { label: 'Expired', cls: 'text-st-waiting bg-st-waiting-wash', dot: 'bg-st-waiting' },
  ERROR: { label: 'Error', cls: 'text-st-failed bg-st-failed-wash', dot: 'bg-st-failed' },
};

function SocialRow({
  s,
  isCeo,
  canWrite,
  redditScanAuth,
}: {
  s: SocialPlatformStatus;
  isCeo: boolean;
  canWrite: boolean;
  redditScanAuth: ControlStatus['redditScanAuth'];
}) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['control-status'] });
  const connect = useMutation({
    mutationFn: () => api.post<{ authorizationUrl: string }>(`/social/${s.platform.toLowerCase()}/connect`),
    onSuccess: (r) => window.location.assign(r.authorizationUrl),
  });
  const verify = useMutation({ mutationFn: () => api.post<SocialPlatformStatus>(`/social/${s.platform.toLowerCase()}/verify`), onSettled: refresh });
  const disconnect = useMutation({ mutationFn: () => api.post(`/social/${s.platform.toLowerCase()}/disconnect`), onSettled: refresh });
  const [copied, setCopied] = useState(false);
  const pages = useMemo(() => {
    const m = s.account?.metadata as { pages?: { name: string }[] } | null | undefined;
    return m?.pages?.map((p) => p.name).filter(Boolean) ?? [];
  }, [s.account]);

  return (
    <li className="px-4 py-3.5" data-testid={`social-${s.platform.toLowerCase()}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-ink">{s.name}</p>
            <Pill {...SOCIAL_STYLE[s.status]} />
          </div>
          {s.account && (
            <p className="mt-0.5 text-sm text-ink-2">
              {s.account.profileUrl ? (
                <a className="font-medium text-brand hover:underline" href={s.account.profileUrl} target="_blank" rel="noreferrer">
                  {s.account.displayName}
                </a>
              ) : (
                <span className="font-medium">{s.account.displayName}</span>
              )}
              {pages.length > 0 && <span className="text-ink-3"> · Pages: {pages.join(', ')}</span>}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {s.status === 'CONNECTED' || s.status === 'EXPIRED' || s.status === 'ERROR' ? (
            <>
              {canWrite && s.status !== 'EXPIRED' && (
                <Button variant="quiet" onClick={() => verify.mutate()} busy={verify.isPending} aria-label={`Test ${s.name} connection`}>
                  <RefreshCw className="size-3.5" aria-hidden />
                  Test
                </Button>
              )}
              {isCeo && (
                <Button variant="secondary" onClick={() => connect.mutate()} busy={connect.isPending} disabled={!s.configured}>
                  <Plug className="size-3.5" aria-hidden />
                  Reconnect
                </Button>
              )}
              {isCeo && (
                <Button variant="danger" onClick={() => disconnect.mutate()} busy={disconnect.isPending} aria-label={`Disconnect ${s.name}`}>
                  <Unplug className="size-3.5" aria-hidden />
                </Button>
              )}
            </>
          ) : (
            isCeo && (
              <Button variant="primary" onClick={() => connect.mutate()} busy={connect.isPending} disabled={!s.configured} title={s.configured ? undefined : `Set ${s.missing.join(', ')} first`}>
                <Plug className="size-3.5" aria-hidden />
                Connect
              </Button>
            )
          )}
        </div>
      </div>

      <div className="mt-2 space-y-1 text-[13px] text-ink-3">
        {s.status === 'CONNECTED' && (
          <p className="num">
            Connected {s.connectedAt ? timeAgo(s.connectedAt) : ''}
            {s.lastVerifiedAt ? ` · verified ${timeAgo(s.lastVerifiedAt)}` : ''}
            {s.expiresAt ? ` · token ${new Date(s.expiresAt) > new Date() ? 'expires' : 'expired'} ${timeAgo(s.expiresAt)}` : ''}
            {s.hasRefreshToken ? ' · auto-refresh on' : s.expiresAt ? ' · reconnect before expiry' : ''}
          </p>
        )}
        {s.grantedScopes.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {s.grantedScopes.map((sc) => (
              <code key={sc} className="rounded bg-sunken px-1 text-[12px] text-ink-2">
                {sc}
              </code>
            ))}
          </p>
        )}
        {s.platform === 'REDDIT' && s.status === 'CONNECTED' && (
          <p>Lead-source scans use this account{redditScanAuth ? ` (last scan auth: ${redditScanAuth.replace(/_/g, ' ')})` : ''}.</p>
        )}
        {s.lastError && <p className="text-st-failed">{s.lastError}</p>}
        {!s.configured && (
          <p className="text-st-waiting">
            Server needs: {s.missing.map((m) => <code key={m} className="mr-1 rounded bg-sunken px-1 text-[12px]">{m}</code>)}
          </p>
        )}
        {s.status !== 'CONNECTED' && (
          <details className="group">
            <summary className="cursor-pointer select-none font-medium text-ink-2 hover:text-ink">Setup steps</summary>
            <ol className="mt-1.5 list-decimal space-y-1 pl-5">
              {s.setupNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ol>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span>Redirect URL:</span>
              <code className="break-all rounded bg-sunken px-1.5 py-0.5 text-[12px] text-ink-2">{s.redirectUri}</code>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-brand hover:bg-sunken"
                onClick={() => {
                  void navigator.clipboard?.writeText(s.redirectUri).then(() => setCopied(true));
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                <Copy className="size-3.5" aria-hidden />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-1.5">
              <a className="inline-flex items-center gap-1 font-medium text-brand hover:underline" href={s.developerConsoleUrl} target="_blank" rel="noreferrer">
                Open {s.name} developer console <ExternalLink className="size-3" aria-hidden />
              </a>
              {' · '}
              <a className="inline-flex items-center gap-1 text-brand hover:underline" href={s.docsUrl} target="_blank" rel="noreferrer">
                OAuth docs <ExternalLink className="size-3" aria-hidden />
              </a>
            </p>
          </details>
        )}
        <ErrorNote error={connect.error ?? verify.error ?? disconnect.error} />
      </div>
    </li>
  );
}

const AGENT_STATE: Record<AgentState, { label: string; cls: string; dot: string }> = {
  working: { label: 'Working', cls: 'text-st-running', dot: 'bg-st-running motion-safe:animate-pulse' },
  queued: { label: 'Has queued work', cls: 'text-ink-2', dot: 'bg-st-queued' },
  attention: { label: 'Needs attention', cls: 'text-st-waiting bg-st-waiting-wash', dot: 'bg-st-waiting' },
  idle: { label: 'Idle', cls: 'text-ink-3', dot: 'bg-st-done' },
  disabled: { label: 'Disabled', cls: 'text-ink-3', dot: 'bg-st-cancelled' },
};

function AgentsSection({ agents, people }: { agents: ControlAgent[]; people: ControlStatus['people'] }) {
  const groups = useMemo(() => {
    const map = new Map<string, ControlAgent[]>();
    for (const a of agents) {
      const k = a.department?.name ?? 'Leadership';
      map.set(k, [...(map.get(k) ?? []), a]);
    }
    return [...map.entries()];
  }, [agents]);

  return (
    <Section title="Company members" aside={<span className="text-[13px] text-ink-3">{agents.length} AI agents · {people.length} people</span>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-[13px] text-ink-3">
              <th className="px-4 py-2 font-medium">Member</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="num px-3 py-2 text-right font-medium">Queued</th>
              <th className="num px-3 py-2 text-right font-medium">Running</th>
              <th className="num px-3 py-2 text-right font-medium">Waiting</th>
              <th className="num px-3 py-2 text-right font-medium">Failed</th>
              <th className="num px-3 py-2 text-right font-medium">Done today</th>
              <th className="px-4 py-2 font-medium">Last run</th>
            </tr>
          </thead>
          {groups.map(([dept, list]) => (
            <tbody key={dept} className="border-b border-rule last:border-b-0">
              <tr>
                <th colSpan={8} scope="colgroup" className="bg-sunken px-4 py-1.5 text-left text-[12px] font-semibold uppercase tracking-wide text-ink-3">
                  {dept}
                </th>
              </tr>
              {list.map((a) => (
                <tr key={a.id} className="border-t border-rule first:border-t-0" data-testid={`agent-${a.key}`}>
                  <td className="px-4 py-2.5">
                    <Link to={`/organization/${a.id}`} className="font-medium text-ink hover:text-brand hover:underline">
                      {a.name}
                    </Link>
                    <span className="block text-[13px] text-ink-3">{AGENT_KIND_LABEL[a.kind]}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <Pill {...AGENT_STATE[a.state]} />
                  </td>
                  <Num n={a.tasks.queued} />
                  <Num n={a.tasks.running} tone="running" />
                  <Num n={a.tasks.awaitingApproval} tone="waiting" />
                  <Num n={a.tasks.failed} tone="failed" />
                  <Num n={a.tasks.completedToday} />
                  <td className="max-w-[280px] px-4 py-2.5 text-[13px] text-ink-3">
                    {a.lastRun ? (
                      <>
                        <span className={cx('font-medium', a.lastRun.status === 'FAILED' ? 'text-st-failed' : a.lastRun.status === 'RUNNING' ? 'text-st-running' : 'text-st-done')}>
                          {a.lastRun.status === 'SUCCEEDED' ? 'Succeeded' : a.lastRun.status === 'FAILED' ? 'Failed' : 'Running'}
                        </span>{' '}
                        {timeAgo(a.lastRun.startedAt)}
                        {a.lastRun.task && (
                          <Link to={`/tasks/${a.lastRun.task.id}`} className="block truncate text-brand hover:underline" title={a.lastRun.task.title}>
                            {a.lastRun.task.title}
                          </Link>
                        )}
                        {a.lastRun.errorMessage && (
                          <span className="block truncate text-st-failed" title={a.lastRun.errorMessage}>
                            {a.lastRun.errorMessage}
                          </span>
                        )}
                      </>
                    ) : (
                      'Never run'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <div className="border-t border-rule px-4 py-3">
        <p className="mb-1.5 text-[13px] font-medium text-ink-2">People</p>
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {people.map((p) => (
            <li key={p.id} className={cx(!p.isActive && 'text-ink-3 line-through')}>
              <span className="font-medium">{p.name}</span> <span className="text-ink-3">· {p.role === 'CEO' ? 'CEO' : p.role === 'ADMIN' ? 'Admin' : 'Viewer'}</span>
              <span className="text-[13px] text-ink-3"> · {p.lastLoginAt ? `signed in ${timeAgo(p.lastLoginAt)}` : 'never signed in'}</span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function Num({ n, tone }: { n: number; tone?: 'running' | 'waiting' | 'failed' }) {
  return (
    <td
      className={cx(
        'num px-3 py-2.5 text-right',
        n === 0 ? 'text-ink-3' : tone === 'running' ? 'font-medium text-st-running' : tone === 'waiting' ? 'font-medium text-st-waiting' : tone === 'failed' ? 'font-medium text-st-failed' : 'text-ink',
      )}
    >
      {n}
    </td>
  );
}

const RUN_TONE: Record<string, string> = {
  RUNNING: 'text-st-running',
  QUEUED: 'text-st-queued',
  SUCCEEDED: 'text-st-done',
  FAILED: 'text-st-failed',
  CANCELLED: 'text-st-cancelled',
};

function duration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function JobsSection({ jobs }: { jobs: ControlStatus['jobs'] }) {
  return (
    <Section title="Jobs & results">
      {jobs.goals.length > 0 && (
        <div className="border-b border-rule px-4 py-3">
          <p className="mb-2 text-[13px] font-medium text-ink-2">Goals</p>
          <ul className="space-y-2.5">
            {jobs.goals.map((g) => {
              const pct = g.subtasks ? Math.round((g.subtasksDone / g.subtasks) * 100) : g.status === 'COMPLETED' ? 100 : 0;
              return (
                <li key={g.id}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <Link to={`/tasks/${g.id}`} className="min-w-0 truncate font-medium text-ink hover:text-brand hover:underline">
                      {g.title}
                    </Link>
                    <StatusBadge status={g.status} />
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div
                      className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken"
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${g.title} progress`}
                    >
                      <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="num w-24 text-right text-[12px] text-ink-3">
                      {g.subtasksDone}/{g.subtasks} subtasks
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="border-b border-rule px-4 py-3">
        <p className="mb-1.5 text-[13px] font-medium text-ink-2">AI agent runs</p>
        {jobs.agentRuns.length === 0 ? (
          <p className="text-sm text-ink-3">No AI runs yet.</p>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {jobs.agentRuns.map((r) => (
              <li key={r.id} className="py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">
                    <span className={cx('font-medium', RUN_TONE[r.status])}>{r.status === 'SUCCEEDED' ? 'Succeeded' : r.status === 'FAILED' ? 'Failed' : 'Running'}</span> ·{' '}
                    {r.agentName}
                    {r.task && (
                      <>
                        {' · '}
                        <Link to={`/tasks/${r.task.id}`} className="text-brand hover:underline">
                          {r.task.title}
                        </Link>
                      </>
                    )}
                  </span>
                  <span className="num shrink-0 text-[12px] text-ink-3">
                    {duration(r.startedAt, r.finishedAt)} · {formatInt(r.tokens)} tok · {timeAgo(r.startedAt)}
                  </span>
                </div>
                {r.errorMessage && <p className="mt-0.5 text-[13px] text-st-failed">{r.errorMessage}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="px-4 py-3">
        <p className="mb-1.5 text-[13px] font-medium text-ink-2">Lead-source scans</p>
        {jobs.scans.length === 0 ? (
          <p className="text-sm text-ink-3">No scans yet.</p>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {jobs.scans.map((s) => (
              <li key={s.id} className="py-2">
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <span className={cx('font-medium', RUN_TONE[s.status])}>{s.status.charAt(0) + s.status.slice(1).toLowerCase()}</span> · {s.source}
                    <span className="text-ink-3"> · {s.trigger.toLowerCase()}</span>
                  </span>
                  <span className="num shrink-0 text-[12px] text-ink-3">
                    {s.itemsFound} found · {s.itemsCreated} new · {s.itemsDeduped} dup · {duration(s.startedAt, s.finishedAt)} · {timeAgo(s.createdAt)}
                  </span>
                </div>
                {s.errorMessage && <p className="mt-0.5 text-[13px] text-st-failed">{s.errorMessage}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function LogSection({ events }: { events: ControlStatus['events'] }) {
  return (
    <Section title="Operations log" aside={<span className="text-[13px] text-ink-3">live</span>}>
      {events.length === 0 ? (
        <Empty title="Nothing logged yet">Start, stop, connection and recovery events appear here as they happen.</Empty>
      ) : (
        <ol className="max-h-[560px] divide-y divide-rule overflow-y-auto" aria-live="polite" data-testid="control-log">
          {events.map((e) => (
            <li key={e.id} className="flex gap-2.5 px-4 py-2.5 text-sm">
              {e.level === 'ERROR' ? (
                <CircleX className="mt-0.5 size-4 shrink-0 text-st-failed" aria-label="Error" />
              ) : e.level === 'WARN' ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-st-waiting" aria-label="Warning" />
              ) : (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-st-done" aria-label="Info" />
              )}
              <div className="min-w-0">
                <p className="text-ink">{e.message}</p>
                <p className="text-[12px] text-ink-3">
                  {timeAgo(e.createdAt)} · <code>{e.action}</code>
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function ResultPanel({ result, onClose }: { result: ControlActionResult; onClose: () => void }) {
  return (
    <div role="status" className={cx('mb-5 rounded-lg border px-4 py-3', result.ok ? 'border-rule bg-panel' : 'border-st-waiting/40 bg-st-waiting-wash')} data-testid="control-result">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium text-ink">{result.summary}</p>
        <button onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Dismiss result">
          <X className="size-4" />
        </button>
      </div>
      <ul className="mt-1.5 space-y-1 text-sm">
        {result.items.map((i) => (
          <li key={i.target + i.message} className="flex gap-2">
            {i.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-st-done" aria-label="Done" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-st-waiting" aria-label="Not done" />}
            <span className="text-ink-2">{i.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Banner({ ok, onClose, children }: { ok: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <div role="status" className={cx('mb-4 flex items-start justify-between gap-3 rounded-md px-3 py-2 text-sm', ok ? 'bg-brand-wash text-brand-ink' : 'bg-st-failed-wash text-st-failed')}>
      <span>{children}</span>
      <button onClick={onClose} className="rounded p-0.5 hover:bg-black/5" aria-label="Dismiss">
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Two-step button for disruptive actions: first click arms it, second click confirms. Disarms after 5s. */
function ConfirmButton({ onConfirm, busy, disabled, label, confirmLabel }: { onConfirm: () => void; busy: boolean; disabled: boolean; label: string; confirmLabel: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      variant="danger"
      busy={busy}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      className={cx(armed && 'border-st-failed bg-st-failed-wash')}
    >
      <Square className="size-4" aria-hidden />
      {armed ? confirmLabel : label}
    </Button>
  );
}
