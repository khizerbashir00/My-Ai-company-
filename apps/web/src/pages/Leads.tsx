import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Search, Upload } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Empty, ErrorNote, Field, Input, Loading, PageHeader, Pagination, Section, Select, Textarea, cx } from '../components/ui';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { STAGE_LABEL, STAGE_ORDER, formatDate, timeAgo } from '../lib/format';
import type { Agent, LeadListItem, LeadStage, Page, SystemStatus } from '../lib/types';

export function LeadsPage() {
  const { canWrite } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'pipeline' ? 'pipeline' : 'list';
  const stage = (params.get('stage')?.split(',').filter(Boolean) ?? []) as LeadStage[];
  const search = params.get('search') ?? '';
  const sourceId = params.get('sourceId') ?? '';
  const minScore = params.get('minScore') ?? '';
  const maxScore = params.get('maxScore') ?? '';
  const sortBy = params.get('sortBy') ?? 'createdAt';
  const sortDir = (params.get('sortDir') ?? 'desc') as 'asc' | 'desc';
  const page = Number(params.get('page') ?? 1);
  const showNew = params.get('new') === '1';
  const showImport = params.get('import') === '1';
  const importSourceKey = params.get('sourceKey') ?? 'manual_import';

  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchDraft !== search) update({ search: searchDraft || null, page: null });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api.get<SystemStatus>('/system/status') });
  const leads = useQuery({
    queryKey: ['leads', { stage, search, sourceId, minScore, maxScore, sortBy, sortDir, page }],
    queryFn: () =>
      api.get<Page<LeadListItem>>(
        `/leads${qs({ stage, search, sourceId, minScore, maxScore, sortBy, sortDir, page, pageSize: 20 })}`,
      ),
    placeholderData: keepPreviousData,
    enabled: view === 'list',
  });
  const pipeline = useQuery({
    queryKey: ['lead-pipeline', { search, sourceId, minScore, maxScore }],
    queryFn: () =>
      api.get<{ columns: { stage: LeadStage; count: number; items: LeadListItem[] }[] }>(
        `/leads/pipeline${qs({ search, sourceId, minScore, maxScore })}`,
      ),
    enabled: view === 'pipeline',
  });

  return (
    <>
      <PageHeader
        title="Leads"
        description="CRM for prospects from configured connectors or manual import. Manual CSV remains the fallback when a connector is unavailable."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant={view === 'list' ? 'secondary' : 'quiet'} onClick={() => update({ view: null })}>
              List
            </Button>
            <Button variant={view === 'pipeline' ? 'secondary' : 'quiet'} onClick={() => update({ view: 'pipeline' })}>
              Pipeline
            </Button>
            {canWrite && (
              <>
                <Button variant="quiet" onClick={() => update({ import: '1' })}>
                  <Upload className="size-4" aria-hidden />
                  Import CSV
                </Button>
                <a
                  className="inline-flex items-center gap-2 rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm font-medium text-ink-2 hover:text-ink"
                  href={`/api/leads/export${qs({ stage, search, sourceId, minScore, maxScore, sortBy, sortDir })}`}
                >
                  <Download className="size-4" aria-hidden />
                  Export
                </a>
                <Button variant="primary" onClick={() => update({ new: '1' })}>
                  <Plus className="size-4" aria-hidden />
                  New lead
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input
            type="search"
            aria-label="Search leads"
            placeholder="Search name, contact, requirements"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select aria-label="Source" value={sourceId} onChange={(e) => update({ sourceId: e.target.value, page: null })} className="w-auto">
          <option value="">All sources</option>
          {status.data?.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.accessMethod === 'MANUAL_IMPORT' ? ' (import)' : ''}
            </option>
          ))}
        </Select>
        <Input
          type="number"
          min={0}
          max={100}
          aria-label="Min score"
          placeholder="Min score"
          value={minScore}
          onChange={(e) => update({ minScore: e.target.value || null, page: null })}
          className="w-28"
        />
        <Input
          type="number"
          min={0}
          max={100}
          aria-label="Max score"
          placeholder="Max score"
          value={maxScore}
          onChange={(e) => update({ maxScore: e.target.value || null, page: null })}
          className="w-28"
        />
        {view === 'list' && (
          <Select aria-label="Sort" value={sortBy} onChange={(e) => update({ sortBy: e.target.value })} className="w-auto">
            <option value="createdAt">Created</option>
            <option value="updatedAt">Updated</option>
            <option value="name">Name</option>
            <option value="latestScore">Score</option>
            <option value="stage">Stage</option>
          </Select>
        )}
      </div>

      {view === 'list' && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {STAGE_ORDER.map((s) => {
            const active = stage.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  const set = new Set(stage);
                  if (set.has(s)) set.delete(s);
                  else set.add(s);
                  update({ stage: [...set].join(',') || null, page: null });
                }}
                className={cx(
                  'rounded-md px-2.5 py-1 text-[13px] font-medium',
                  active ? 'bg-brand-wash text-brand-ink' : 'bg-sunken text-ink-2 hover:text-ink',
                )}
              >
                {STAGE_LABEL[s]}
              </button>
            );
          })}
        </div>
      )}

      {view === 'list' ? (
        leads.isPending ? (
          <Loading />
        ) : leads.isError ? (
          <ErrorNote error={leads.error} />
        ) : leads.data!.total === 0 ? (
          <Empty title="No leads yet">Add a lead manually or import a CSV. Nothing here is fabricated.</Empty>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-rule">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-rule bg-sunken text-[13px] text-ink-3">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Lead</th>
                    <th className="px-4 py-2.5 font-medium">Stage</th>
                    <th className="px-4 py-2.5 font-medium">Score</th>
                    <th className="px-4 py-2.5 font-medium">Source</th>
                    <th className="px-4 py-2.5 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {leads.data!.items.map((l) => (
                    <tr key={l.id} className="hover:bg-sunken/60">
                      <td className="px-4 py-3">
                        <Link to={`/leads/${l.id}`} className="font-medium text-brand hover:underline">
                          {l.name}
                        </Link>
                        <span className="block text-[13px] text-ink-3">{l.contactName ?? l.contactEmail ?? 'No contact on file'}</span>
                      </td>
                      <td className="px-4 py-3">{STAGE_LABEL[l.stage]}</td>
                      <td className="px-4 py-3 num">{l.latestScore ?? '—'}</td>
                      <td className="px-4 py-3 text-ink-2">
                        {l.sources[0]?.source.name ?? '—'}
                        {l.sources[0]?.accessMethod === 'MANUAL_IMPORT' && (
                          <span className="ml-1 text-[12px] text-ink-3">manual</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-3" title={formatDate(l.updatedAt, true)}>
                        {timeAgo(l.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4">
              <Pagination
                page={leads.data!.page}
                totalPages={leads.data!.totalPages}
                total={leads.data!.total}
                onPage={(p) => update({ page: String(p) })}
              />
            </div>
          </>
        )
      ) : pipeline.isPending ? (
        <Loading />
      ) : pipeline.isError ? (
        <ErrorNote error={pipeline.error} />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {pipeline.data!.columns.map((col) => (
            <section key={col.stage} className="w-64 shrink-0 rounded-lg border border-rule bg-panel">
              <header className="flex items-center justify-between border-b border-rule px-3 py-2 text-sm">
                <span className="font-medium">{STAGE_LABEL[col.stage]}</span>
                <span className="num text-ink-3">{col.count}</span>
              </header>
              <ul className="max-h-[70vh] space-y-2 overflow-y-auto p-2">
                {col.items.length === 0 ? (
                  <li className="px-2 py-6 text-center text-[13px] text-ink-3">Empty</li>
                ) : (
                  col.items.map((l) => (
                    <li key={l.id}>
                      <Link to={`/leads/${l.id}`} className="block rounded-md border border-rule px-3 py-2 hover:bg-sunken">
                        <span className="block truncate text-sm font-medium">{l.name}</span>
                        <span className="block text-[12px] text-ink-3">
                          {l.latestScore != null ? `Score ${l.latestScore}` : 'Unscored'}
                          {l.sources[0]?.accessMethod === 'MANUAL_IMPORT' ? ' · manual' : ''}
                        </span>
                      </Link>
                    </li>
                  ))
                )}
              </ul>
            </section>
          ))}
        </div>
      )}

      {showNew && <NewLeadDialog onClose={() => update({ new: null })} />}
      {showImport && (
        <ImportDialog
          sourceKey={importSourceKey}
          onClose={() => update({ import: null, sourceKey: null })}
        />
      )}
    </>
  );
}

function NewLeadDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<Agent[]>('/agents'),
  });
  const [form, setForm] = useState({
    name: '',
    contactName: '',
    contactEmail: '',
    websiteUrl: '',
    requirements: '',
    requestedSkills: '',
    budgetText: '',
    sourceUrl: '',
    externalId: '',
    notes: '',
    assignedAgentId: '',
  });
  const create = useMutation({
    mutationFn: () =>
      api.post<LeadListItem>('/leads', {
        name: form.name,
        contactName: form.contactName || undefined,
        contactEmail: form.contactEmail || undefined,
        websiteUrl: form.websiteUrl || undefined,
        requirements: form.requirements || undefined,
        requestedSkills: form.requestedSkills
          ? form.requestedSkills.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
          : undefined,
        budgetText: form.budgetText || undefined,
        sourceUrl: form.sourceUrl,
        externalId: form.externalId || undefined,
        notes: form.notes || undefined,
        assignedAgentId: form.assignedAgentId || undefined,
      }),
    onSuccess: (lead) => {
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
      onClose();
      window.location.href = `/leads/${lead.id}`;
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center" role="dialog" aria-modal>
      <form
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-panel p-5 shadow-lg"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h2 className="text-lg font-semibold">New lead</h2>
        <p className="mt-1 text-sm text-ink-2">Manual entry — stored under the Manual import source. Do not invent contacts.</p>
        <div className="mt-4 space-y-3">
          <Field label="Company / profile name">
            {(id) => <Input id={id} required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
          </Field>
          <Field label="Original post / listing URL">
            {(id) => (
              <Input id={id} required type="url" value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact name">
              {(id) => <Input id={id} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />}
            </Field>
            <Field label="Contact email">
              {(id) => (
                <Input id={id} type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
              )}
            </Field>
          </div>
          <Field label="Website">
            {(id) => <Input id={id} type="url" value={form.websiteUrl} onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })} />}
          </Field>
          <Field label="Requirements">
            {(id) => <Textarea id={id} rows={3} value={form.requirements} onChange={(e) => setForm({ ...form, requirements: e.target.value })} />}
          </Field>
          <Field label="Requested skills (comma-separated)">
            {(id) => <Input id={id} value={form.requestedSkills} onChange={(e) => setForm({ ...form, requestedSkills: e.target.value })} />}
          </Field>
          <Field label="Stated budget (only if explicit)">
            {(id) => <Input id={id} value={form.budgetText} onChange={(e) => setForm({ ...form, budgetText: e.target.value })} />}
          </Field>
          <Field label="External id (optional)">
            {(id) => <Input id={id} value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} />}
          </Field>
          <Field label="Assigned agent">
            {(id) => (
              <Select id={id} value={form.assignedAgentId} onChange={(e) => setForm({ ...form, assignedAgentId: e.target.value })}>
                <option value="">Unassigned</option>
                {(agents.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Notes">
            {(id) => <Textarea id={id} rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}
          </Field>
        </div>
        <ErrorNote error={create.error} className="mt-3" />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            Save lead
          </Button>
        </div>
      </form>
    </div>
  );
}

const IMPORT_CSV_STARTERS: Record<string, string> = {
  linkedin:
    'name,source_url,contact_name,contact_email,requirements,external_id\nAcme Clinic,https://www.linkedin.com/in/example-founder,Jane Doe,,Need a clinic website,\n',
  facebook:
    'name,source_url,contact_name,contact_email,requirements,external_id\nMeta lead — Acme,https://facebook.com/example-post,Jane Doe,jane@example.com,Requested a quote via lead form,\n',
  indeed:
    'name,source_url,contact_name,contact_email,requirements,external_id\nHiring — web developer,https://www.indeed.com/viewjob?jk=example,,,Looking for freelance web developer,\n',
  manual_import:
    'name,source_url,contact_name,contact_email,requirements,external_id\n',
};

function ImportDialog({ onClose, sourceKey = 'manual_import' }: { onClose: () => void; sourceKey?: string }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState(IMPORT_CSV_STARTERS[sourceKey] ?? IMPORT_CSV_STARTERS.manual_import);
  const [preview, setPreview] = useState<{
    validCount: number;
    errorCount: number;
    isManualImport: boolean;
    source?: { id: string; key: string; name: string; accessMethod: string };
    rows: { row: number; errors: string[]; data: unknown; raw: Record<string, string> }[];
  } | null>(null);

  const runPreview = useMutation({
    mutationFn: () =>
      api.post<NonNullable<typeof preview>>('/leads/import/preview', { csv, sourceKey }),
    onSuccess: setPreview,
  });
  const confirm = useMutation({
    mutationFn: () => {
      const rows = (preview?.rows ?? []).filter((r) => r.errors.length === 0 && r.data).map((r) => r.data);
      return api.post<{ createdCount: number }>('/leads/import/confirm', { rows });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
      onClose();
    },
  });

  const tagName = preview?.source?.name ?? (sourceKey === 'manual_import' ? 'Manual import' : sourceKey);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center" role="dialog" aria-modal>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-panel p-5 shadow-lg">
        <h2 className="text-lg font-semibold">Import CSV</h2>
        <p className="mt-1 text-sm text-ink-2">
          Rows are validated before save. Imports are tagged as <strong>{tagName}</strong> (CSV / export path — not a live connector
          scan).
        </p>
        <div className="mt-4">
          <Field label="CSV">
            {(id) => <Textarea id={id} rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} className="font-mono text-[13px]" />}
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" busy={runPreview.isPending} onClick={() => runPreview.mutate()}>
            Preview
          </Button>
          <Button
            variant="primary"
            disabled={!preview || preview.validCount === 0}
            busy={confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            Import {preview ? preview.validCount : 0} valid row{preview?.validCount === 1 ? '' : 's'}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
        </div>
        <ErrorNote error={runPreview.error ?? confirm.error} className="mt-3" />
        {preview && (
          <Section title={`Preview — ${preview.validCount} valid, ${preview.errorCount} with errors`} className="mt-4">
            <ul className="divide-y divide-rule text-sm">
              {preview.rows.map((r) => (
                <li key={r.row} className="px-4 py-2.5">
                  <span className="font-medium">Row {r.row}</span>
                  <span className="text-ink-3"> — {r.raw.name || '(no name)'}</span>
                  {r.errors.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5 text-st-failed">
                      {r.errors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[13px] text-st-done">Ready to import</p>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {confirm.error instanceof ApiError && <p className="mt-2 text-sm text-st-failed">{confirm.error.message}</p>}
      </div>
    </div>
  );
}
