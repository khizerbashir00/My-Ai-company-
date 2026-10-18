import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, ErrorNote, Field, Input, Loading, PageHeader, Section, cx } from '../components/ui';
import { api } from '../lib/api';
import type { SystemStatus } from '../lib/types';

export function SettingsPage() {
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api.get<SystemStatus>('/system/status') });

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="AI provider">
          {status.isPending ? (
            <Loading />
          ) : status.isError ? (
            <ErrorNote error={status.error} className="m-4" />
          ) : (
            <div className="px-4 py-4 text-sm">
              <dl className="divide-y divide-rule rounded-md border border-rule">
                <Row label="Provider">OpenAI</Row>
                <Row label="API key">
                  <span className={status.data.ai.apiKeyConfigured ? 'text-st-done' : 'text-st-waiting'}>
                    {status.data.ai.apiKeyConfigured ? 'Configured on the server' : 'Not set'}
                  </span>
                </Row>
                <Row label="Routine model">{status.data.ai.routineModel ?? <span className="text-st-waiting">Not set</span>}</Row>
                <Row label="Advanced model">{status.data.ai.advancedModel ?? <span className="text-st-waiting">Not set</span>}</Row>
              </dl>
              <p className="mt-3 max-w-[64ch] text-ink-2">
                The key stays on the server and is never sent to the browser. Set <code className="rounded bg-sunken px-1">OPENAI_API_KEY</code>,{' '}
                <code className="rounded bg-sunken px-1">OPENAI_MODEL</code> and optionally <code className="rounded bg-sunken px-1">OPENAI_MODEL_ADVANCED</code>{' '}
                in <code className="rounded bg-sunken px-1">apps/api/.env</code>, then restart the API. Use model IDs your OpenAI project has access to. When
                the key and model are set, use <span className="font-medium">Run with AI</span> on a queued task to execute the assigned agent.
              </p>
            </div>
          )}
        </Section>

        <Section title="Email (Resend)">
          {status.data && (
            <div className="px-4 py-4 text-sm">
              <dl className="divide-y divide-rule rounded-md border border-rule">
                <Row label="Provider">{status.data.email.provider ?? 'Not set'}</Row>
                <Row label="Configured">
                  <span className={status.data.email.configured ? 'text-st-done' : 'text-st-waiting'}>
                    {status.data.email.configured ? 'Ready' : 'Not ready — live send disabled'}
                  </span>
                </Row>
                <Row label="From">{status.data.email.fromAddress ?? '—'}</Row>
                <Row label="Inbound webhook">{status.data.email.inboundWebhookConfigured ? 'Secret set' : 'Optional secret not set'}</Row>
              </dl>
              <p className="mt-3 max-w-[64ch] text-ink-2">
                Set <code className="rounded bg-sunken px-1">EMAIL_PROVIDER=resend</code>,{' '}
                <code className="rounded bg-sunken px-1">RESEND_API_KEY</code>, and a verified{' '}
                <code className="rounded bg-sunken px-1">EMAIL_FROM</code> on the CEO mailbox domain. See{' '}
                <code className="rounded bg-sunken px-1">docs/milestones/phase-5-outreach.md</code>. Do not claim live delivery until configured and tested.
              </p>
            </div>
          )}
        </Section>

        <Section title="Lead sources">
          {status.data && (
            <ul className="divide-y divide-rule">
              {status.data.sources.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span>
                    <span className="font-medium">{s.name}</span>
                    <span className="block text-[13px] text-ink-3">{s.accessMethod === 'MANUAL_IMPORT' ? 'You add leads yourself' : s.accessMethod.toLowerCase().replace(/_/g, ' ')}</span>
                  </span>
                  <span className={cx('text-[13px] font-medium', s.isEnabled ? 'text-st-done' : 'text-ink-3')}>{s.isEnabled ? 'Enabled' : 'Off'}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-rule px-4 py-3 text-sm text-ink-3">
            Manage connector configuration, scans, and history under{' '}
            <a className="font-medium text-brand hover:underline" href="/sources">
              Sources
            </a>
            . Hacker News and Reddit have live connectors; LinkedIn, Facebook and other platforms are import-only as lead sources. Connect company
            LinkedIn, Facebook, Reddit and X accounts (OAuth) in the{' '}
            <a className="font-medium text-brand hover:underline" href="/control">
              Control Center
            </a>
            .
          </p>
        </Section>

        <ChangePassword />
      </div>
    </>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setDone(true);
    },
  });

  return (
    <Section title="Password">
      <form
        className="space-y-4 px-4 py-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setDone(false);
          change.mutate();
        }}
      >
        <Field label="Current password">
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />}
        </Field>
        <Field label="New password" hint="At least 12 characters.">
          {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required />}
        </Field>
        <ErrorNote error={change.error} />
        {done && (
          <p role="status" className="text-sm text-st-done">
            Password changed.
          </p>
        )}
        <Button type="submit" variant="primary" busy={change.isPending} disabled={!current || next.length < 12}>
          Change password
        </Button>
      </form>
    </Section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}
