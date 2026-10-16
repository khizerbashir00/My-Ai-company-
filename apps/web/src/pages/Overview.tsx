import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Hourglass, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Empty, ErrorNote, Loading, PageHeader, Section, Select, StatusBadge, cx } from '../components/ui';
import { api, qs } from '../lib/api';
import { STAGE_LABEL, STATUS_LABEL, formatInt, formatMoney, timeAgo } from '../lib/format';
import type { Metrics, SystemStatus } from '../lib/types';

type RangeKey = '7d' | '30d' | '90d' | 'all';
const RANGES: { key: RangeKey; label: string; days?: number }[] = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: 'all', label: 'All time' },
];

export function OverviewPage() {
  const [range, setRange] = useState<RangeKey>('30d');
  const [sourceId, setSourceId] = useState('');
  const from = useMemo(() => {
    const days = RANGES.find((r) => r.key === range)?.days;
    if (!days) return undefined;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - days + 1);
    return d.toISOString();
  }, [range]);

  const metrics = useQuery({
    queryKey: ['metrics', range, sourceId],
    queryFn: () => api.get<Metrics>(`/dashboard/metrics${qs({ from, sourceId })}`),
  });
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api.get<SystemStatus>('/system/status') });

  return (
    <>
      <PageHeader
        title="Overview"
        description="Every number here is counted from records in your database."
        actions={
          <>
            <label className="sr-only" htmlFor="src">
              Lead source
            </label>
            <div className="w-48">
              <Select id="src" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">All lead sources</option>
                {status.data?.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div role="radiogroup" aria-label="Date range" className="flex rounded-md border border-rule-strong bg-panel p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  role="radio"
                  aria-checked={range === r.key}
                  onClick={() => setRange(r.key)}
                  className={cx('rounded px-2.5 py-1.5 text-[13px] font-medium', range === r.key ? 'bg-ink text-panel' : 'text-ink-2 hover:text-ink')}
                >
                  {r.label.replace('Last ', '')}
                </button>
              ))}
            </div>
          </>
        }
      />

      {metrics.isPending ? (
        <Loading label="Counting" />
      ) : metrics.isError ? (
        <ErrorNote error={metrics.error} />
      ) : (
        <Dashboard m={metrics.data} aiReady={Boolean(status.data?.ai.apiKeyConfigured && status.data.ai.routineModel)} />
      )}
    </>
  );
}

function Dashboard({ m, aiReady }: { m: Metrics; aiReady: boolean }) {
  const waiting = m.tasks.byStatus.find((s) => s.status === 'AWAITING_APPROVAL')?.count ?? 0;
  const [showDefs, setShowDefs] = useState(false);
  const d: Record<string, string | undefined> = showDefs ? m.definitions : {};

  return (
    <div className="space-y-6">
      <NeedsYou failed={m.tasks.failed} waitingTasks={waiting} approvals={m.tasks.pendingApprovals} aiReady={aiReady} />

      <Pipeline pipeline={m.sales.pipeline} total={m.sales.leadsTotal} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Section
          title="Sales"
          aside={
            <button onClick={() => setShowDefs(!showDefs)} aria-expanded={showDefs} className="text-sm font-medium text-brand hover:underline">
              {showDefs ? 'Hide definitions' : 'How these are counted'}
            </button>
          }
        >
          <dl className="divide-y divide-rule">
            <Line label="Leads discovered" value={m.sales.leadsTotal} hint={d.leadsTotal} />
            <Line label="Qualified" value={m.sales.leadsQualified} hint={d.leadsQualified} />
            <Line label="High intent" value={m.sales.leadsHighIntent} hint={d.leadsHighIntent} />
            <Line label="Outreach drafts" value={m.sales.outreachDrafts} hint={d.outreachDrafts} />
            <Line label="Messages sent" value={m.sales.messagesSent} hint={d.messagesSent} />
            <Line label="Replies received" value={m.sales.repliesReceived} hint={d.repliesReceived} />
            <Line label="Interested prospects" value={m.sales.interestedProspects} hint={d.interestedProspects} />
            <Line label="Demo requests" value={m.sales.demoRequests} hint={d.demoRequests} />
            <Line label="Meetings scheduled" value={m.sales.meetingsScheduled} hint={d.meetingsScheduled} />
            <Line label="Deals won" value={m.sales.dealsWon} hint={d.dealsWon} />
            <Line label="Deals lost" value={m.sales.dealsLost} hint={d.dealsLost} />
            <div className="flex items-baseline justify-between gap-4 px-4 py-3.5">
              <dt>
                <span className="font-medium text-ink">Revenue from confirmed deals</span>
                {d.revenue && <span className="block text-[13px] text-ink-3">{d.revenue}</span>}
              </dt>
              <dd className="num text-right text-xl font-semibold">
                {m.sales.revenue.length ? (
                  m.sales.revenue.map((r) => <div key={r.currency}>{formatMoney(r.amount, r.currency)}</div>)
                ) : (
                  <span className="text-ink-3">—</span>
                )}
              </dd>
            </div>
          </dl>
        </Section>

        <div className="space-y-6">
          <TaskSummary m={m} />
          <Section title="Marketing">
            <dl className="divide-y divide-rule">
              <Line label="Content published" value={m.marketing.assetsPublished} />
              <Line label="Campaigns" value={m.marketing.campaignsByStatus.reduce((n, c) => n + c.count, 0)} />
              <Line label="Attributed leads" value={m.marketing.attributedLeads} />
              <Line label="Metric imports" value={m.marketing.metricImports} />
            </dl>
            {!m.marketing.performance.measured && (
              <p className="border-t border-rule px-4 py-3 text-sm text-ink-3">
                Reach, engagement and conversion appear here once an analytics source is connected or a report is imported. Nothing is estimated until then.
              </p>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function NeedsYou({ failed, waitingTasks, approvals, aiReady }: { failed: number; waitingTasks: number; approvals: number; aiReady: boolean }) {
  const items = [
    approvals > 0 && { icon: ShieldCheck, tone: 'waiting', text: `${approvals} ${approvals === 1 ? 'action needs' : 'actions need'} your approval`, to: '/approvals' },
    waitingTasks > 0 && { icon: Hourglass, tone: 'waiting', text: `${waitingTasks} ${waitingTasks === 1 ? 'task is' : 'tasks are'} waiting on you`, to: '/tasks?status=AWAITING_APPROVAL' },
    failed > 0 && { icon: CircleAlert, tone: 'failed', text: `${failed} failed ${failed === 1 ? 'task' : 'tasks'} to review`, to: '/tasks?status=FAILED' },
    !aiReady && { icon: CircleAlert, tone: 'neutral', text: 'AI isn’t configured yet, so managers can’t start work. Add an OpenAI key and model', to: '/settings' },
  ].filter(Boolean) as { icon: typeof ShieldCheck; tone: 'waiting' | 'failed' | 'neutral'; text: string; to: string }[];

  return (
    <section aria-labelledby="needs-you" className="rounded-lg border border-rule bg-panel px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <h2 id="needs-you" className="text-[15px] font-semibold">
          Needs you
        </h2>
        {items.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing right now. No approvals pending and no failed work.</p>
        ) : (
          items.map(({ icon: Icon, tone, text, to }) => (
            <Link
              key={text}
              to={to}
              className={cx(
                'inline-flex items-center gap-2 text-sm font-medium underline-offset-4 hover:underline',
                tone === 'waiting' && 'text-st-waiting',
                tone === 'failed' && 'text-st-failed',
                tone === 'neutral' && 'text-ink-2',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {text}
            </Link>
          ))
        )}
      </div>
    </section>
  );
}

/** One continuous track of all 13 stages: the shape of the pipeline at a glance. */
function Pipeline({ pipeline, total }: { pipeline: Metrics['sales']['pipeline']; total: number }) {
  const active = pipeline.filter((p) => !['LOST', 'DO_NOT_CONTACT'].includes(p.stage));
  const closed = pipeline.filter((p) => ['LOST', 'DO_NOT_CONTACT'].includes(p.stage));
  const max = Math.max(1, ...pipeline.map((p) => p.count));

  return (
    <Section
      title="Sales pipeline"
      aside={<span className="num text-sm text-ink-3">{formatInt(total)} leads in range</span>}
    >
      {total === 0 ? (
        <Empty title="No leads yet">Leads appear here once you import them (Phase 3) or connect an authorized source (Phase 4).</Empty>
      ) : null}
      <ol className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-4 lg:grid-cols-11" aria-label="Leads by stage">
        {active.map((p, i) => (
          <li
            key={p.stage}
            // 11 stages: Won spans two cells on 2- and 4-column layouts so no row has a gap
            className={cx('flex flex-col justify-between gap-3 bg-panel px-3 py-3', p.stage === 'WON' && 'col-span-2 lg:col-span-1')}
          >
            <span className={cx('text-[13px] leading-snug', p.stage === 'WON' ? 'font-semibold text-st-done' : 'text-ink-2')}>{STAGE_LABEL[p.stage]}</span>
            <div>
              <span className={cx('num text-[22px] font-semibold leading-none', p.count === 0 && 'text-ink-3')}>{formatInt(p.count)}</span>
              <div className="mt-2 h-1.5 rounded-full bg-sunken">
                <div
                  className={cx('grow-x h-full rounded-full', p.stage === 'WON' ? 'bg-st-done' : 'bg-brand')}
                  style={{ width: `${p.count ? Math.max(6, (p.count / max) * 100) : 0}%`, animationDelay: `${i * 40}ms` }}
                />
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-rule px-4 py-2.5 text-sm text-ink-3">
        {closed.map((p) => (
          <span key={p.stage}>
            {STAGE_LABEL[p.stage]} <span className="num font-medium text-ink-2">{formatInt(p.count)}</span>
          </span>
        ))}
      </div>
    </Section>
  );
}

function TaskSummary({ m }: { m: Metrics }) {
  const rate = m.tasks.completionRate;
  return (
    <Section title="AI work" aside={<Link to="/tasks" className="text-sm font-medium text-brand hover:underline">All tasks</Link>}>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3 px-4 pb-3 pt-4">
        <div>
          <p className="num text-[32px] font-semibold leading-none">{rate === null ? '—' : `${Math.round(rate * 100)}%`}</p>
          <p className="mt-1 text-[13px] text-ink-3" title={m.definitions.taskCompletionRate}>
            Completion rate of finished tasks
          </p>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {m.tasks.byStatus
            .filter((s) => s.count > 0)
            .map((s) => (
              <li key={s.status} className="text-ink-2">
                {STATUS_LABEL[s.status]} <span className="num font-semibold text-ink">{s.count}</span>
              </li>
            ))}
        </ul>
      </div>
      {m.tasks.recent.length === 0 ? (
        <Empty title="No tasks yet">
          <Link to="/tasks?new=1" className="font-medium text-brand hover:underline">
            Assign your first task
          </Link>{' '}
          to the General Manager or a department.
        </Empty>
      ) : (
        <ul className="divide-y divide-rule border-t border-rule">
          {m.tasks.recent.map((t) => (
            <li key={t.id}>
              <Link to={`/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-sunken">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{t.title}</span>
                  <span className="block truncate text-[13px] text-ink-3">
                    {t.assignedAgent?.name ?? t.department?.name ?? 'Unassigned'}, {timeAgo(t.updatedAt)}
                  </span>
                </span>
                <StatusBadge status={t.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Line({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
      <dt className="min-w-0">
        <span className="text-ink">{label}</span>
        {hint && <span className="block text-[13px] leading-snug text-ink-3">{hint}</span>}
      </dt>
      <dd className={cx('num shrink-0 text-lg font-semibold', value === 0 && 'text-ink-3')}>{formatInt(value)}</dd>
    </div>
  );
}
