import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Button, Empty, ErrorNote, Field, Input, Loading, Section, Textarea, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { STAGE_LABEL, formatDate } from '../lib/format';
import type { LeadDetail, LeadStage, OutreachMessage, ScoringRubric } from '../lib/types';

type Tab = 'overview' | 'briefing' | 'drafts' | 'score';

export function LeadDetailPage() {
  const { id = '' } = useParams();
  const lead = useQuery({ queryKey: ['lead', id], queryFn: () => api.get<LeadDetail>(`/leads/${id}`) });
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <>
      <Link to="/leads" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-ink-2 hover:text-ink">
        <ChevronLeft className="size-4" aria-hidden />
        Leads
      </Link>
      {lead.isPending ? (
        <Loading />
      ) : lead.isError ? (
        <ErrorNote error={lead.error} />
      ) : (
        <LeadView lead={lead.data} tab={tab} setTab={setTab} />
      )}
    </>
  );
}

function LeadView({ lead, tab, setTab }: { lead: LeadDetail; tab: Tab; setTab: (t: Tab) => void }) {
  const { canWrite } = useAuth();
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'briefing', label: 'Client briefing' },
    { id: 'drafts', label: 'Outreach drafts' },
    { id: 'score', label: 'Qualification' },
  ];

  return (
    <div className="space-y-6">
      <header>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-ink-3">
          <span className="rounded-md bg-sunken px-2 py-0.5 font-medium text-ink-2">{STAGE_LABEL[lead.stage]}</span>
          {lead.latestScore != null && <span className="num">Score {lead.latestScore}</span>}
          {lead.sources[0]?.accessMethod === 'MANUAL_IMPORT' && <span>Manual import</span>}
        </div>
        <h1 className="text-[26px] font-semibold tracking-[-0.01em]">{lead.name}</h1>
        <p className="mt-1 text-sm text-ink-2">
          {lead.contactName ?? 'No contact name'}
          {lead.contactEmail ? ` · ${lead.contactEmail}` : ''}
          {lead.assignedAgent ? ` · Assigned to ${lead.assignedAgent.name}` : ''}
        </p>
      </header>

      {canWrite && <StageActions lead={lead} />}

      <div className="flex flex-wrap gap-1 border-b border-rule">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === t.id ? 'border-brand text-brand-ink' : 'border-transparent text-ink-2 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview lead={lead} />}
      {tab === 'briefing' && <Briefing leadId={lead.id} />}
      {tab === 'drafts' && <Drafts lead={lead} />}
      {tab === 'score' && <ScorePanel lead={lead} />}
    </div>
  );
}

function StageActions({ lead }: { lead: LeadDetail }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const move = useMutation({
    mutationFn: (to: LeadStage) => api.post<LeadDetail>(`/leads/${lead.id}/transition`, { to }),
    onSuccess: (updated) => {
      qc.setQueryData(['lead', lead.id], updated);
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
  // Offer a practical subset; server enforces the full graph. WON requires confirm-deal.
  const suggestions: LeadStage[] = [
    'QUALIFIED',
    'DRAFT_READY',
    'CONTACTED',
    'REPLIED',
    'INTERESTED',
    'DEMO_REQUESTED',
    'DEMO_COMPLETED',
    'NEGOTIATION',
    'LOST',
    'DO_NOT_CONTACT',
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {suggestions
          .filter((s) => s !== lead.stage)
          .map((to) => (
            <Button key={to} variant="secondary" busy={move.isPending && move.variables === to} onClick={() => move.mutate(to)}>
              Move to {STAGE_LABEL[to]}
            </Button>
          ))}
        <ErrorNote error={move.error} />
      </div>
      {canWrite && ['DEMO_COMPLETED', 'NEGOTIATION', 'INTERESTED', 'DEMO_REQUESTED'].includes(lead.stage) && (
        <ConfirmDealForm leadId={lead.id} />
      )}
      {canWrite && <OutreachControls leadId={lead.id} paused={Boolean(lead.outreachPausedAt)} />}
    </div>
  );
}

function ConfirmDealForm({ leadId }: { leadId: string }) {
  const qc = useQueryClient();
  const [scope, setScope] = useState('');
  const [dealValue, setDealValue] = useState('');
  const confirm = useMutation({
    mutationFn: () =>
      api.post(`/leads/${leadId}/confirm-deal`, { scope, dealValue: Number(dealValue), currency: 'USD' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lead', leadId] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
  return (
    <Section title="Confirm deal (Won)">
      <form
        className="space-y-3 px-4 py-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          confirm.mutate();
        }}
      >
        <p className="text-sm text-ink-2">Requires explicit project scope. Creates a project record for your development workflow.</p>
        <Field label="Confirmed scope">
          {(id) => <Textarea id={id} required minLength={10} rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />}
        </Field>
        <Field label="Deal value (USD)">
          {(id) => <Input id={id} required type="number" min={0} step="0.01" value={dealValue} onChange={(e) => setDealValue(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" busy={confirm.isPending}>
          Confirm Won + create project
        </Button>
        <ErrorNote error={confirm.error} />
      </form>
    </Section>
  );
}

function OutreachControls({ leadId, paused }: { leadId: string; paused: boolean }) {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (path: 'pause' | 'resume' | 'stop-scheduled') => api.post(`/leads/${leadId}/outreach/${path}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lead', leadId] }),
  });
  return (
    <div className="flex flex-wrap gap-2">
      {paused ? (
        <Button variant="secondary" busy={act.isPending} onClick={() => act.mutate('resume')}>
          Resume outreach
        </Button>
      ) : (
        <Button variant="secondary" busy={act.isPending} onClick={() => act.mutate('pause')}>
          Pause outreach
        </Button>
      )}
      <Button variant="quiet" busy={act.isPending} onClick={() => act.mutate('stop-scheduled')}>
        Stop scheduled follow-ups
      </Button>
      <ErrorNote error={act.error} />
    </div>
  );
}

function Overview({ lead }: { lead: LeadDetail }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const [notes, setNotes] = useState(lead.notes);
  const save = useMutation({
    mutationFn: () => api.patch<LeadDetail>(`/leads/${lead.id}`, { notes }),
    onSuccess: (updated) => qc.setQueryData(['lead', lead.id], updated),
  });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-6">
        <Section title="Requirements">
          <div className="px-4 py-4 text-sm leading-relaxed whitespace-pre-wrap">
            {lead.requirements || <span className="text-ink-3">None recorded.</span>}
          </div>
        </Section>
        <Section title="Notes">
          <div className="space-y-3 px-4 py-4">
            <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canWrite} />
            {canWrite && (
              <Button variant="secondary" busy={save.isPending} onClick={() => save.mutate()}>
                Save notes
              </Button>
            )}
            <ErrorNote error={save.error} />
          </div>
        </Section>
        <Section title="Source evidence">
          {lead.sources.length === 0 ? (
            <Empty title="No sources">Every lead should have a source URL.</Empty>
          ) : (
            <ul className="divide-y divide-rule">
              {lead.sources.map((s) => (
                <li key={s.id} className="px-4 py-3 text-sm">
                  <a href={s.url} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">
                    {s.url}
                  </a>
                  <p className="text-[13px] text-ink-3">
                    {s.source.name}
                    {s.accessMethod === 'MANUAL_IMPORT' && s.source.key !== 'manual_import' ? ' · Manual import' : ''}
                    {s.postDate ? ` · Posted ${formatDate(s.postDate)}` : ''}
                    {` · Discovered ${formatDate(s.discoveredAt)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <aside className="space-y-6">
        <Section title="Details">
          <dl className="divide-y divide-rule text-sm">
            <Row label="Website">{lead.websiteUrl ? <a href={lead.websiteUrl} className="text-brand hover:underline">{lead.websiteUrl}</a> : '—'}</Row>
            <Row label="Skills">{lead.requestedSkills.join(', ') || '—'}</Row>
            <Row label="Budget">{lead.budgetText ?? 'Not stated'}</Row>
            <Row label="Country">{lead.country ?? '—'}</Row>
            <Row label="Industry">{lead.industry ?? '—'}</Row>
            <Row label="Created">{formatDate(lead.createdAt, true)}</Row>
          </dl>
        </Section>
      </aside>
    </div>
  );
}

function Briefing({ leadId }: { leadId: string }) {
  const briefing = useQuery({
    queryKey: ['lead-briefing', leadId],
    queryFn: () =>
      api.get<{
        lead: LeadDetail;
        company: { name: string; websiteUrl: string | null; industry: string | null; country: string | null };
        sources: { url: string; isManualImport: boolean; source: { name: string } }[];
        originalRequest: string;
        questionsToAsk: string[];
        demoPrep: { points: string[] };
        qualification: { score: number; label: string; reasons: { key: string; score: number; reason: string }[] } | null;
        conversationNotes: { type: string; occurredAt: string; data: unknown }[];
        conversationHistory: { subject: string | null; status: string; body: string; sentAt: string | null; createdAt: string }[];
      }>(`/leads/${leadId}/briefing`),
  });

  if (briefing.isPending) return <Loading />;
  if (briefing.isError) return <ErrorNote error={briefing.error} />;
  const b = briefing.data!;

  return (
    <div className="space-y-6">
      <Section title="Company">
        <dl className="divide-y divide-rule px-4 text-sm">
          <div className="flex justify-between py-2"><dt className="text-ink-3">Name</dt><dd>{b.company.name}</dd></div>
          <div className="flex justify-between py-2"><dt className="text-ink-3">Website</dt><dd>{b.company.websiteUrl ?? '—'}</dd></div>
          <div className="flex justify-between py-2"><dt className="text-ink-3">Industry</dt><dd>{b.company.industry ?? '—'}</dd></div>
          <div className="flex justify-between py-2"><dt className="text-ink-3">Country</dt><dd>{b.company.country ?? '—'}</dd></div>
        </dl>
      </Section>
      <Section title="Source links">
        <ul className="divide-y divide-rule">
          {b.sources.map((s, i) => (
            <li key={i} className="px-4 py-3 text-sm">
              <a href={s.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                {s.url}
              </a>
              <span className="ml-2 text-ink-3">
                {s.source.name}
                {s.isManualImport ? ' · Manual import' : ''}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Original request">
        <p className="px-4 py-4 text-sm whitespace-pre-wrap">{b.originalRequest || 'None recorded.'}</p>
      </Section>
      <Section title="Questions to ask">
        <ul className="list-disc space-y-1 px-8 py-4 text-sm">
          {b.questionsToAsk.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      </Section>
      <Section title="Demo preparation">
        <ul className="list-disc space-y-1 px-8 py-4 text-sm">
          {b.demoPrep.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </Section>
      {b.qualification && (
        <Section title="Qualification">
          <div className="px-4 py-4 text-sm">
            <p className="font-medium">
              Score {b.qualification.score} · {b.qualification.label}
            </p>
            <ul className="mt-2 space-y-1 text-ink-2">
              {b.qualification.reasons.map((r) => (
                <li key={r.key}>
                  {r.key}: {r.score} — {r.reason}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}
      <Section title="Conversation history">
        {b.conversationHistory.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-3">No messages yet.</p>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {b.conversationHistory.map((m, i) => (
              <li key={i} className="px-4 py-3">
                <p className="font-medium">
                  {m.subject || '(no subject)'} <span className="font-normal text-ink-3">· {m.status}</span>
                </p>
                <p className="mt-1 whitespace-pre-wrap text-ink-2">{m.body.slice(0, 400)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Conversation notes">
        {b.conversationNotes.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-3">No conversation events yet.</p>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {b.conversationNotes.map((n, i) => (
              <li key={i} className="px-4 py-2.5">
                <span className="font-medium">{n.type}</span>
                <span className="text-ink-3"> · {formatDate(n.occurredAt, true)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Drafts({ lead }: { lead: LeadDetail }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [rationale, setRationale] = useState('');

  const create = useMutation({
    mutationFn: () => api.post<OutreachMessage>(`/leads/${lead.id}/outreach`, { subject, body, rationale }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lead', lead.id] });
      setSubject('');
      setBody('');
      setRationale('');
    },
  });
  const generate = useMutation({
    mutationFn: () => api.post<OutreachMessage>(`/leads/${lead.id}/outreach/generate`, { channel: 'EMAIL' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lead', lead.id] }),
  });
  const requestSend = useMutation({
    mutationFn: (messageId: string) =>
      api.post<{ approvalId: string }>(`/leads/${lead.id}/outreach/${messageId}/request-send`, {}),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['lead', lead.id] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      window.location.href = `/approvals/${res.approvalId}`;
    },
  });
  const [followAt, setFollowAt] = useState('');
  const [followBody, setFollowBody] = useState('');
  const schedule = useMutation({
    mutationFn: () =>
      api.post(`/leads/${lead.id}/follow-ups`, {
        scheduledFor: new Date(followAt).toISOString(),
        body: followBody,
        subject: 'Follow-up',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lead', lead.id] });
      setFollowBody('');
      setFollowAt('');
    },
  });

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-2">
        Drafts stay local until you request CEO send approval. Live delivery requires a configured Resend mailbox — we do not claim sending until that is set up and tested.
      </p>
      {canWrite && (
        <Section
          title="New draft"
          aside={
            <Button variant="quiet" busy={generate.isPending} onClick={() => generate.mutate()}>
              Generate with AI
            </Button>
          }
        >
          <form
            className="space-y-3 px-4 py-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Subject">
              {(id) => <Input id={id} value={subject} onChange={(e) => setSubject(e.target.value)} />}
            </Field>
            <Field label="Body">
              {(id) => <Textarea id={id} required minLength={10} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />}
            </Field>
            <Field label="Rationale">
              {(id) => <Textarea id={id} rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} />}
            </Field>
            <Button type="submit" variant="primary" busy={create.isPending}>
              Save draft
            </Button>
            <ErrorNote error={create.error ?? generate.error} />
          </form>
        </Section>
      )}
      <Section title="Versions">
        {lead.messages.length === 0 ? (
          <Empty title="No drafts yet">Write one manually or generate with AI when credentials are configured.</Empty>
        ) : (
          <ul className="divide-y divide-rule">
            {lead.messages.map((m) => (
              <li key={m.id} className="px-4 py-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{m.subject || '(no subject)'}</span>
                  <span className="text-ink-3">
                    {m.status} · {formatDate(m.createdAt, true)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-ink-2">{m.body}</p>
                {m.rationale && <p className="mt-2 text-[13px] text-ink-3">Rationale: {m.rationale}</p>}
                {canWrite && (m.status === 'DRAFT' || m.status === 'FAILED') && (
                  <Button className="mt-2" variant="secondary" busy={requestSend.isPending} onClick={() => requestSend.mutate(m.id)}>
                    Request send approval
                  </Button>
                )}
                {m.status === 'AWAITING_APPROVAL' && (
                  <Link to="/approvals" className="mt-2 inline-block text-sm font-medium text-brand hover:underline">
                    Review in Approvals
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {canWrite && (
        <Section title="Schedule follow-up">
          <form
            className="space-y-3 px-4 py-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              schedule.mutate();
            }}
          >
            <Field label="Send after">
              {(id) => <Input id={id} type="datetime-local" required value={followAt} onChange={(e) => setFollowAt(e.target.value)} />}
            </Field>
            <Field label="Body">
              {(id) => <Textarea id={id} required minLength={10} rows={4} value={followBody} onChange={(e) => setFollowBody(e.target.value)} />}
            </Field>
            <Button type="submit" variant="secondary" busy={schedule.isPending}>
              Schedule (requires approval when due)
            </Button>
            <ErrorNote error={schedule.error ?? requestSend.error} />
          </form>
        </Section>
      )}
    </div>
  );
}

function ScorePanel({ lead }: { lead: LeadDetail }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const rubric = useQuery({ queryKey: ['lead-rubric'], queryFn: () => api.get<ScoringRubric>('/leads/meta/rubric') });
  const [scores, setScores] = useState<Record<string, { score: string; reason: string }>>({});

  const submit = useMutation({
    mutationFn: () => {
      const criteria = (rubric.data?.criteria ?? []).map((c) => ({
        key: c.key,
        score: Number(scores[c.key]?.score ?? 0),
        reason: scores[c.key]?.reason ?? '',
      }));
      return api.post<LeadDetail>(`/leads/${lead.id}/score`, { criteria });
    },
    onSuccess: (updated) => {
      qc.setQueryData(['lead', lead.id], updated);
      void qc.invalidateQueries({ queryKey: ['lead-briefing', lead.id] });
    },
  });

  if (rubric.isPending) return <Loading />;
  if (rubric.isError) return <ErrorNote error={rubric.error} />;

  return (
    <div className="space-y-6">
      <Section title={`Rubric ${rubric.data!.version}`}>
        <p className="px-4 py-3 text-sm text-ink-2">
          Score 0–{rubric.data!.maxScore}. A high score prioritizes outreach — it is not a purchase prediction.
        </p>
        <ul className="divide-y divide-rule text-sm">
          {rubric.data!.criteria.map((c) => (
            <li key={c.key} className="px-4 py-3">
              <p className="font-medium">
                {c.label} <span className="text-ink-3">(max {c.max})</span>
              </p>
              <p className="text-[13px] text-ink-3">{c.description}</p>
              {canWrite && (
                <div className="mt-2 grid grid-cols-[80px_minmax(0,1fr)] gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={c.max}
                    aria-label={`${c.label} score`}
                    value={scores[c.key]?.score ?? ''}
                    onChange={(e) => setScores({ ...scores, [c.key]: { score: e.target.value, reason: scores[c.key]?.reason ?? '' } })}
                  />
                  <Input
                    aria-label={`${c.label} reason`}
                    placeholder="Reason"
                    value={scores[c.key]?.reason ?? ''}
                    onChange={(e) => setScores({ ...scores, [c.key]: { score: scores[c.key]?.score ?? '0', reason: e.target.value } })}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
        {canWrite && (
          <div className="border-t border-rule px-4 py-3">
            <Button variant="primary" busy={submit.isPending} onClick={() => submit.mutate()}>
              Save score
            </Button>
            <ErrorNote error={submit.error} className="mt-2" />
          </div>
        )}
      </Section>
      <Section title="History">
        {lead.scores.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-3">Not scored yet.</p>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {lead.scores.map((s) => (
              <li key={s.id} className="px-4 py-3">
                <span className="font-medium num">{s.score}</span> · {s.label} · {formatDate(s.createdAt, true)}
                {s.scoredBy && <span className="text-ink-3"> by {s.scoredBy.name}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 px-4 py-2.5">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
