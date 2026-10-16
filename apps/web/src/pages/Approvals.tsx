import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button, Empty, ErrorNote, Loading, PageHeader, Section, Textarea, cx } from '../components/ui';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate } from '../lib/format';
import type { Page } from '../lib/types';

interface ApprovalItem {
  id: string;
  actionType: string;
  status: string;
  summary: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  requestedByAgent: { name: string } | null;
  decidedBy: { name: string } | null;
}

interface ReviewBundle {
  message: {
    id: string;
    subject: string | null;
    body: string;
    rationale: string;
    status: string;
    recipientEmail: string | null;
    deliveryStatus: string | null;
    lastProviderError: string | null;
    providerMessageId: string | null;
  };
  lead: {
    id: string;
    name: string;
    contactName: string | null;
    contactEmail: string | null;
    stage: string;
    requirements: string;
    sources: { url: string; sourceName: string; accessMethod: string }[];
  };
  approval: { id: string; status: string; summary: string } | null;
  emailProvider: { configured: boolean; provider: string | null; fromAddress: string | null };
}

interface ApprovalDetail extends ApprovalItem {
  review: ReviewBundle | null;
  payload?: unknown;
  emailProvider?: { configured: boolean; provider: string | null; fromAddress: string | null };
}

export function ApprovalsPage() {
  const { id } = useParams();
  if (id) return <ApprovalDetailView id={id} />;
  return <ApprovalsList />;
}

function ApprovalsList() {
  const [status, setStatus] = useState('PENDING');
  const list = useQuery({
    queryKey: ['approvals', status],
    queryFn: () =>
      api.get<Page<ApprovalItem> & { emailProvider: { configured: boolean; fromAddress: string | null } }>(
        `/approvals${qs({ status, pageSize: 50 })}`,
      ),
  });

  return (
    <>
      <PageHeader
        title="Approvals"
        description="CEO review for external outreach. Email is only sent after you approve, and only when the Resend provider is configured."
        actions={
          <div className="flex gap-2">
            {(['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const).map((s) => (
              <Button key={s} variant={status === s ? 'secondary' : 'quiet'} onClick={() => setStatus(s)}>
                {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
              </Button>
            ))}
          </div>
        }
      />

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorNote error={list.error} />
      ) : (
        <>
          <p className="mb-4 text-sm text-ink-2">
            Email provider:{' '}
            {list.data.emailProvider.configured ? (
              <span className="text-st-done">Configured ({list.data.emailProvider.fromAddress})</span>
            ) : (
              <span className="text-st-waiting">Not configured — approve will not deliver until Resend is set up</span>
            )}
          </p>
          {list.data.items.length === 0 ? (
            <Empty title="No approvals">When someone requests a send, it appears here.</Empty>
          ) : (
            <ul className="divide-y divide-rule rounded-lg border border-rule bg-panel">
              {list.data.items.map((a) => (
                <li key={a.id}>
                  <Link to={`/approvals/${a.id}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 hover:bg-sunken">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{a.summary}</p>
                      <p className="text-[13px] text-ink-3">
                        {a.actionType.replace(/_/g, ' ')}
                        {a.requestedByAgent ? ` · ${a.requestedByAgent.name}` : ''}
                        {' · '}
                        {formatDate(a.createdAt, true)}
                      </p>
                    </div>
                    <span
                      className={cx(
                        'text-[13px] font-semibold',
                        a.status === 'PENDING' && 'text-st-waiting',
                        a.status === 'APPROVED' && 'text-st-done',
                        a.status === 'REJECTED' && 'text-st-failed',
                      )}
                    >
                      {a.status}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function ApprovalDetailView({ id }: { id: string }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const detail = useQuery({ queryKey: ['approval', id], queryFn: () => api.get<ApprovalDetail>(`/approvals/${id}`) });

  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') => api.post(`/approvals/${id}/decide`, { decision, note: note || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approval', id] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
    },
  });

  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorNote error={detail.error} />;
  const a = detail.data;
  const r = a.review;

  return (
    <>
      <Link to="/approvals" className="mb-4 inline-block text-sm font-medium text-ink-2 hover:text-ink">
        ← Approvals
      </Link>
      <PageHeader title={a.summary} description={`${a.actionType.replace(/_/g, ' ')} · ${a.status}`} />

      {r ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-6">
            <Section title="Message">
              <div className="space-y-3 px-4 py-4 text-sm">
                <p>
                  <span className="text-ink-3">To </span>
                  <span className="font-medium">{r.message.recipientEmail ?? r.lead.contactEmail ?? '—'}</span>
                </p>
                <p>
                  <span className="text-ink-3">Subject </span>
                  <span className="font-medium">{r.message.subject || '(no subject)'}</span>
                </p>
                <pre className="whitespace-pre-wrap rounded-md bg-sunken px-3 py-3 font-sans text-ink-2">{r.message.body}</pre>
                {r.message.rationale && <p className="text-[13px] text-ink-3">Rationale: {r.message.rationale}</p>}
                <p className="text-[13px] text-ink-3">
                  Approval status: {r.message.status}
                  {r.message.providerMessageId ? ` · Provider id ${r.message.providerMessageId}` : ''}
                  {r.message.lastProviderError ? ` · Error: ${r.message.lastProviderError}` : ''}
                </p>
              </div>
            </Section>
          </div>
          <aside className="space-y-6">
            <Section title="Lead context">
              <dl className="divide-y divide-rule text-sm">
                <div className="flex justify-between gap-3 px-4 py-2">
                  <dt className="text-ink-3">Company</dt>
                  <dd>
                    <Link className="text-brand hover:underline" to={`/leads/${r.lead.id}`}>
                      {r.lead.name}
                    </Link>
                  </dd>
                </div>
                <div className="flex justify-between gap-3 px-4 py-2">
                  <dt className="text-ink-3">Contact</dt>
                  <dd>{r.lead.contactName ?? '—'}{r.lead.contactEmail ? ` · ${r.lead.contactEmail}` : ''}</dd>
                </div>
                <div className="flex justify-between gap-3 px-4 py-2">
                  <dt className="text-ink-3">Stage</dt>
                  <dd>{r.lead.stage}</dd>
                </div>
              </dl>
              <div className="border-t border-rule px-4 py-3 text-sm">
                <p className="mb-1 text-[13px] text-ink-3">Requirements</p>
                <p className="whitespace-pre-wrap text-ink-2">{r.lead.requirements || '—'}</p>
              </div>
              <ul className="border-t border-rule divide-y divide-rule text-sm">
                {r.lead.sources.map((s) => (
                  <li key={s.url} className="px-4 py-2">
                    <a href={s.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                      {s.sourceName}
                    </a>
                    <span className="text-ink-3"> · {s.accessMethod}</span>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="Provider">
              <p className="px-4 py-3 text-sm text-ink-2">
                {r.emailProvider.configured
                  ? `Ready to send from ${r.emailProvider.fromAddress} via ${r.emailProvider.provider}.`
                  : 'Provider not configured. Approving will attempt send and fail until EMAIL_PROVIDER=resend is set.'}
              </p>
            </Section>
          </aside>
        </div>
      ) : (
        <Section title="Details">
          <pre className="overflow-auto px-4 py-4 text-sm">{JSON.stringify(a.payload, null, 2)}</pre>
        </Section>
      )}

      {canWrite && a.status === 'PENDING' && (
        <Section title="Decision" className="mt-6">
          <div className="space-y-3 px-4 py-4">
            <Textarea rows={2} placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" busy={decide.isPending} onClick={() => decide.mutate('APPROVE')}>
                Approve and send
              </Button>
              <Button variant="danger" busy={decide.isPending} onClick={() => decide.mutate('REJECT')}>
                Reject
              </Button>
            </div>
            <ErrorNote error={decide.error} />
          </div>
        </Section>
      )}
    </>
  );
}
