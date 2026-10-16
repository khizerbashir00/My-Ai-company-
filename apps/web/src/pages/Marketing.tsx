import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Button, Empty, ErrorNote, Field, Input, Loading, PageHeader, Section, Select, Textarea, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate } from '../lib/format';

type Tab = 'research' | 'content' | 'campaigns' | 'reports' | 'brand';

export function MarketingPage() {
  const [params, setParams] = useSearchParams();
  const tab = ((params.get('tab') as Tab) || 'research') as Tab;
  const { id } = useParams();

  if (tab === 'reports' && id) return <ReportDetail id={id} />;
  if (tab === 'research' && id) return <ResearchDetail id={id} />;
  if (tab === 'campaigns' && id) return <CampaignDetail id={id} />;
  if (tab === 'content' && id) return <ContentDetail id={id} />;

  return (
    <>
      <PageHeader
        title="Marketing"
        description="Research, content calendar, campaigns, and reports. AI plans and drafts; you approve publish/paid launch. Demos, closing, and development stay with you."
        actions={
          <div className="flex flex-wrap gap-2">
            {(['research', 'content', 'campaigns', 'reports', 'brand'] as Tab[]).map((t) => (
              <Button key={t} variant={tab === t ? 'secondary' : 'quiet'} onClick={() => setParams({ tab: t })}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </Button>
            ))}
          </div>
        }
      />
      {tab === 'research' && <ResearchList />}
      {tab === 'content' && <ContentList />}
      {tab === 'campaigns' && <CampaignList />}
      {tab === 'reports' && <ReportsList />}
      {tab === 'brand' && <BrandEditor />}
    </>
  );
}

function ResearchList() {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['marketing-research'], queryFn: () => api.get<Array<Record<string, unknown>>>('/marketing/research') });
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [industry, setIndustry] = useState('');
  const [service, setService] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.post('/marketing/research', {
        name,
        country,
        industry,
        serviceOffering: service,
        targetCustomerProfile: 'SMB / mid-market buyers requesting custom software',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketing-research'] });
      setName('');
    },
  });

  if (list.isPending) return <Loading />;
  if (list.isError) return <ErrorNote error={list.error} />;

  return (
    <div className="space-y-6">
      {canWrite && (
        <Section title="New research project">
          <form
            className="grid gap-3 px-4 py-4 sm:grid-cols-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Name">{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Country">{(id) => <Input id={id} required value={country} onChange={(e) => setCountry(e.target.value)} />}</Field>
            <Field label="Industry">{(id) => <Input id={id} required value={industry} onChange={(e) => setIndustry(e.target.value)} />}</Field>
            <Field label="Service offering">{(id) => <Input id={id} required value={service} onChange={(e) => setService(e.target.value)} />}</Field>
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary" busy={create.isPending}>
                Create project
              </Button>
              <ErrorNote error={create.error} />
            </div>
          </form>
        </Section>
      )}
      <Section title="Projects">
        {list.data.length === 0 ? (
          <Empty title="No research projects">Create one with country, industry, service, and target profile.</Empty>
        ) : (
          <ul className="divide-y divide-rule">
            {list.data.map((p) => (
              <li key={String(p.id)}>
                <Link className="flex justify-between px-4 py-3 text-sm hover:bg-sunken" to={`/marketing/research/${p.id}?tab=research`}>
                  <span className="font-medium">{String(p.name)}</span>
                  <span className="text-ink-3">
                    {String(p.country)} · {String(p.industry)} · {String(p.status)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ResearchDetail({ id }: { id: string }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['marketing-research', id],
    queryFn: () => api.get<Record<string, unknown>>(`/marketing/research/${id}`),
  });
  const [competitor, setCompetitor] = useState('');
  const [claim, setClaim] = useState('');
  const [url, setUrl] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api.post(`/marketing/research/${id}/competitors`, {
        competitorName: competitor,
        summary: 'Evidence-backed notes only.',
        sourceUrls: [url],
        findings: [{ claim, kind: 'VERIFIED', evidenceUrl: url }],
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketing-research', id] });
      setCompetitor('');
      setClaim('');
      setUrl('');
    },
  });

  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorNote error={detail.error} />;
  const p = detail.data;
  const reports = (p.competitorReports as Array<Record<string, unknown>>) ?? [];
  const findings = (p.findings as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="space-y-6">
      <Link to="/marketing?tab=research" className="text-sm font-medium text-ink-2 hover:text-ink">
        ← Research
      </Link>
      <PageHeader title={String(p.name)} description={`${p.country} · ${p.industry} · ${p.serviceOffering}`} />
      <Section title="Target customer">
        <p className="px-4 py-4 text-sm whitespace-pre-wrap">{String(p.targetCustomerProfile || '—')}</p>
      </Section>
      <Section title="Findings">
        {findings.length === 0 && reports.every((r) => !((r.findings as unknown[]) ?? []).length) ? (
          <p className="px-4 py-4 text-sm text-ink-3">No findings yet. VERIFIED claims require source URLs.</p>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {reports.flatMap((r) =>
              ((r.findings as Array<Record<string, unknown>>) ?? []).map((f) => (
                <li key={String(f.id)} className="px-4 py-3">
                  <span className={cx('mr-2 text-[12px] font-semibold', f.kind === 'VERIFIED' ? 'text-st-done' : 'text-st-waiting')}>
                    {String(f.kind)}
                  </span>
                  {String(f.claim)}
                  {f.evidenceUrl ? (
                    <a className="mt-1 block text-brand hover:underline" href={String(f.evidenceUrl)} target="_blank" rel="noreferrer">
                      {String(f.evidenceUrl)}
                    </a>
                  ) : null}
                </li>
              )),
            )}
          </ul>
        )}
      </Section>
      {canWrite && (
        <Section title="Add competitor report">
          <form
            className="space-y-3 px-4 py-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <Field label="Competitor">{(fid) => <Input id={fid} required value={competitor} onChange={(e) => setCompetitor(e.target.value)} />}</Field>
            <Field label="Verified claim">{(fid) => <Textarea id={fid} required minLength={3} value={claim} onChange={(e) => setClaim(e.target.value)} />}</Field>
            <Field label="Evidence URL" hint="Required for VERIFIED findings. Do not invent prices.">
              {(fid) => <Input id={fid} required type="url" value={url} onChange={(e) => setUrl(e.target.value)} />}
            </Field>
            <Button type="submit" variant="primary" busy={add.isPending}>
              Save with sources
            </Button>
            <ErrorNote error={add.error} />
          </form>
        </Section>
      )}
    </div>
  );
}

function ContentList() {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['marketing-content'], queryFn: () => api.get<Array<Record<string, unknown>>>('/marketing/content') });
  const [title, setTitle] = useState('');
  const [channel, setChannel] = useState('LINKEDIN');
  const create = useMutation({
    mutationFn: () => api.post('/marketing/content', { title, channel, scheduledFor: new Date(Date.now() + 86400000).toISOString() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketing-content'] });
      setTitle('');
    },
  });

  if (list.isPending) return <Loading />;
  if (list.isError) return <ErrorNote error={list.error} />;

  return (
    <div className="space-y-6">
      {canWrite && (
        <Section title="Calendar entry">
          <form
            className="flex flex-wrap items-end gap-3 px-4 py-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Title">{(id) => <Input id={id} required value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <Field label="Channel">
              {(id) => (
                <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {['LINKEDIN', 'WEBSITE_ARTICLE', 'CASE_STUDY', 'LANDING_PAGE', 'EMAIL_CAMPAIGN'].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button type="submit" variant="primary" busy={create.isPending}>
              Add
            </Button>
            <ErrorNote error={create.error} />
          </form>
        </Section>
      )}
      <Section title="Content calendar">
        {list.data.length === 0 ? (
          <Empty title="Empty calendar">Schedule LinkedIn, articles, case studies, landing pages, or email concepts.</Empty>
        ) : (
          <ul className="divide-y divide-rule">
            {list.data.map((c) => (
              <li key={String(c.id)}>
                <Link to={`/marketing/content/${c.id}?tab=content`} className="flex justify-between px-4 py-3 text-sm hover:bg-sunken">
                  <span className="font-medium">{String(c.title)}</span>
                  <span className="text-ink-3">
                    {String(c.channel)} · {String(c.status)}
                    {c.scheduledFor ? ` · ${formatDate(String(c.scheduledFor))}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ContentDetail({ id }: { id: string }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['marketing-content', id], queryFn: () => api.get<Record<string, unknown>>(`/marketing/content/${id}`) });
  const [body, setBody] = useState('');
  const draft = useMutation({
    mutationFn: () => api.post(`/marketing/content/${id}/drafts`, { title: String(detail.data?.title ?? 'Draft'), body, useBrandProfile: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketing-content', id] });
      setBody('');
    },
  });
  const publish = useMutation({
    mutationFn: () => api.post<{ approvalId: string }>(`/marketing/content/${id}/request-publish`),
    onSuccess: (res) => {
      window.location.href = `/approvals/${res.approvalId}`;
    },
  });

  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorNote error={detail.error} />;
  const versions = (detail.data.versions as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="space-y-6">
      <Link to="/marketing?tab=content" className="text-sm font-medium text-ink-2 hover:text-ink">
        ← Content
      </Link>
      <PageHeader title={String(detail.data.title)} description={`${detail.data.channel} · ${detail.data.status}`} />
      <Section title="Versions">
        {versions.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-3">No drafts yet.</p>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {versions.map((v) => (
              <li key={String(v.id)} className="px-4 py-3">
                <p className="font-medium">
                  v{String(v.version)} · {String(v.status)}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-ink-2">{String(v.body).slice(0, 500)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {canWrite && (
        <Section title="New draft version">
          <form
            className="space-y-3 px-4 py-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              draft.mutate();
            }}
          >
            <Field label="Body" hint="Uses brand voice / approved claims only — never invent portfolio facts.">
              {(fid) => <Textarea id={fid} required minLength={10} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" busy={draft.isPending}>
                Save version
              </Button>
              <Button type="button" variant="secondary" busy={publish.isPending} onClick={() => publish.mutate()}>
                Request publish approval
              </Button>
            </div>
            <ErrorNote error={draft.error ?? publish.error} />
          </form>
        </Section>
      )}
    </div>
  );
}

function CampaignList() {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['marketing-campaigns'], queryFn: () => api.get<Array<Record<string, unknown>>>('/marketing/campaigns') });
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.post('/marketing/campaigns', {
        name,
        objective,
        channel: 'linkedin',
        audience: 'SMB decision-makers',
        messaging: 'Practical custom software delivery',
        isPaid: false,
        successMetrics: { primary: 'attributed_leads', note: 'Counted only when attribution is recorded' },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketing-campaigns'] });
      setName('');
    },
  });

  if (list.isPending) return <Loading />;
  if (list.isError) return <ErrorNote error={list.error} />;

  return (
    <div className="space-y-6">
      {canWrite && (
        <Section title="New campaign plan">
          <form
            className="space-y-3 px-4 py-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Name">{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Objective">{(id) => <Textarea id={id} value={objective} onChange={(e) => setObjective(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" busy={create.isPending}>
              Create plan
            </Button>
            <ErrorNote error={create.error} />
          </form>
        </Section>
      )}
      <Section title="Campaigns">
        {list.data.length === 0 ? (
          <Empty title="No campaigns">Plan objective, audience, messaging, channel, schedule, and success metrics.</Empty>
        ) : (
          <ul className="divide-y divide-rule">
            {list.data.map((c) => (
              <li key={String(c.id)}>
                <Link to={`/marketing/campaigns/${c.id}?tab=campaigns`} className="flex justify-between px-4 py-3 text-sm hover:bg-sunken">
                  <span className="font-medium">{String(c.name)}</span>
                  <span className="text-ink-3">
                    {String(c.status)}
                    {c.isPaid ? ' · paid' : ' · organic'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function CampaignDetail({ id }: { id: string }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['marketing-campaign', id], queryFn: () => api.get<Record<string, unknown>>(`/marketing/campaigns/${id}`) });
  const outcomes = useQuery({ queryKey: ['marketing-outcomes', id], queryFn: () => api.get<Record<string, unknown>>(`/marketing/campaigns/${id}/outcomes`) });
  const [assetTitle, setAssetTitle] = useState('');
  const [assetBody, setAssetBody] = useState('');
  const addAsset = useMutation({
    mutationFn: () => api.post(`/marketing/campaigns/${id}/assets`, { type: 'LINKEDIN_POST', title: assetTitle, content: assetBody }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketing-campaign', id] });
      setAssetTitle('');
      setAssetBody('');
    },
  });
  const launch = useMutation({
    mutationFn: () => api.post<{ approvalId: string }>(`/marketing/campaigns/${id}/request-launch`),
    onSuccess: (res) => {
      window.location.href = `/approvals/${res.approvalId}`;
    },
  });
  const [metricKey, setMetricKey] = useState('clicks');
  const [metricValue, setMetricValue] = useState('10');
  const [denom, setDenom] = useState('100');
  const importMetrics = useMutation({
    mutationFn: () =>
      api.post('/marketing/metrics/import', {
        campaignId: id,
        sourceName: 'Manual CSV import',
        rows: [
          {
            metricKey,
            value: Number(metricValue),
            denominator: Number(denom),
            denominatorLabel: 'impressions',
          },
        ],
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['marketing-campaign', id] }),
  });

  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorNote error={detail.error} />;
  const c = detail.data;
  const assets = (c.assets as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="space-y-6">
      <Link to="/marketing?tab=campaigns" className="text-sm font-medium text-ink-2 hover:text-ink">
        ← Campaigns
      </Link>
      <PageHeader
        title={String(c.name)}
        description={`${c.status} · ${c.channel || 'channel TBD'} · ${c.isPaid ? 'Paid (CEO launch approval required)' : 'Organic'}`}
        actions={
          canWrite && c.isPaid ? (
            <Button variant="primary" busy={launch.isPending} onClick={() => launch.mutate()}>
              Request paid launch approval
            </Button>
          ) : undefined
        }
      />
      <Section title="Plan">
        <dl className="divide-y divide-rule px-4 text-sm">
          <Row label="Objective" value={String(c.objective || '—')} />
          <Row label="Audience" value={String(c.audience || '—')} />
          <Row label="Messaging" value={String(c.messaging || '—')} />
          <Row label="Budget recommendation" value={c.budgetRecommendation != null ? `${c.budgetRecommendation} ${c.budgetCurrency}` : 'None (not a spend authorization)'} />
        </dl>
      </Section>
      <Section title="Asset library">
        {assets.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-3">No assets yet.</p>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {assets.map((a) => (
              <li key={String(a.id)} className="px-4 py-3">
                <p className="font-medium">
                  {String(a.title)} · v{String(a.currentVersion)} · {String(a.status)}
                </p>
                <p className="mt-1 text-ink-2 whitespace-pre-wrap">{String(a.content).slice(0, 280)}</p>
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <form
            className="space-y-3 border-t border-rule px-4 py-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              addAsset.mutate();
            }}
          >
            <Field label="Asset title">{(fid) => <Input id={fid} required value={assetTitle} onChange={(e) => setAssetTitle(e.target.value)} />}</Field>
            <Field label="Content">{(fid) => <Textarea id={fid} required minLength={10} value={assetBody} onChange={(e) => setAssetBody(e.target.value)} />}</Field>
            <Button type="submit" variant="secondary" busy={addAsset.isPending}>
              Add asset (v1)
            </Button>
            <ErrorNote error={addAsset.error ?? launch.error} />
          </form>
        )}
      </Section>
      <Section title="Imported metrics">
        <p className="px-4 pt-3 text-sm text-ink-2">Rates require an explicit denominator. Nothing is invented.</p>
        {canWrite && (
          <form
            className="flex flex-wrap items-end gap-3 px-4 py-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              importMetrics.mutate();
            }}
          >
            <Field label="Metric">{(fid) => <Input id={fid} value={metricKey} onChange={(e) => setMetricKey(e.target.value)} />}</Field>
            <Field label="Value">{(fid) => <Input id={fid} type="number" value={metricValue} onChange={(e) => setMetricValue(e.target.value)} />}</Field>
            <Field label="Denominator (impressions)">{(fid) => <Input id={fid} type="number" value={denom} onChange={(e) => setDenom(e.target.value)} />}</Field>
            <Button type="submit" variant="secondary" busy={importMetrics.isPending}>
              Import row
            </Button>
            <ErrorNote error={importMetrics.error} />
          </form>
        )}
      </Section>
      <Section title="Outcomes">
        {outcomes.isPending ? (
          <Loading />
        ) : outcomes.isError ? (
          <ErrorNote error={outcomes.error} />
        ) : (
          <dl className="divide-y divide-rule px-4 text-sm">
            <Row label="Attributed leads" value={String(outcomes.data.attributedLeads)} />
            <Row label="Qualified attributed" value={String(outcomes.data.qualifiedAttributedLeads)} />
            <Row label="Won attributed" value={String(outcomes.data.wonAttributedLeads)} />
            <Row label="Note" value={String(outcomes.data.note)} />
          </dl>
        )}
      </Section>
    </div>
  );
}

function ReportsList() {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['marketing-reports'], queryFn: () => api.get<Array<Record<string, unknown>>>('/marketing/reports') });
  const gen = useMutation({
    mutationFn: (period: 'DAILY' | 'WEEKLY') => api.post('/marketing/reports/generate', { period }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['marketing-reports'] }),
  });

  if (list.isPending) return <Loading />;
  if (list.isError) return <ErrorNote error={list.error} />;

  return (
    <div className="space-y-6">
      {canWrite && (
        <div className="flex gap-2">
          <Button variant="primary" busy={gen.isPending} onClick={() => gen.mutate('DAILY')}>
            Generate daily report
          </Button>
          <Button variant="secondary" busy={gen.isPending} onClick={() => gen.mutate('WEEKLY')}>
            Generate weekly report
          </Button>
          <ErrorNote error={gen.error} />
        </div>
      )}
      <Section title="Marketing Manager reports">
        {list.data.length === 0 ? (
          <Empty title="No reports yet">Daily/weekly reports use counted metrics with documented denominators.</Empty>
        ) : (
          <ul className="divide-y divide-rule">
            {list.data.map((r) => (
              <li key={String(r.id)}>
                <Link to={`/marketing/reports/${r.id}?tab=reports`} className="block px-4 py-3 text-sm hover:bg-sunken">
                  <span className="font-medium">{String(r.title)}</span>
                  <span className="mt-0.5 block text-ink-3">{formatDate(String(r.generatedAt), true)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ReportDetail({ id }: { id: string }) {
  const detail = useQuery({ queryKey: ['marketing-report', id], queryFn: () => api.get<Record<string, unknown>>(`/marketing/reports/${id}`) });
  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorNote error={detail.error} />;
  return (
    <div className="space-y-6">
      <Link to="/marketing?tab=reports" className="text-sm font-medium text-ink-2 hover:text-ink">
        ← Reports
      </Link>
      <PageHeader title={String(detail.data.title)} />
      <Section title="Report">
        <pre className="whitespace-pre-wrap px-4 py-4 text-sm font-sans">{String(detail.data.body)}</pre>
      </Section>
      <Section title="Metrics snapshot">
        <pre className="overflow-auto px-4 py-4 text-xs">{JSON.stringify(detail.data.metricsSnapshot, null, 2)}</pre>
      </Section>
    </div>
  );
}

function BrandEditor() {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const brand = useQuery({ queryKey: ['marketing-brand'], queryFn: () => api.get<Record<string, unknown>>('/marketing/brand') });
  const [voice, setVoice] = useState('');
  const [portfolio, setPortfolio] = useState('');
  const [services, setServices] = useState('');
  const [claims, setClaims] = useState('');
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!brand.data || hydrated) return;
    setVoice(String(brand.data.voiceGuidelines ?? ''));
    setPortfolio(String(brand.data.portfolioNotes ?? ''));
    setServices(((brand.data.servicesOffered as string[]) ?? []).join(', '));
    setClaims(((brand.data.approvedClaims as string[]) ?? []).join('\n'));
    setHydrated(true);
  }, [brand.data, hydrated]);
  const save = useMutation({
    mutationFn: () =>
      api.patch('/marketing/brand', {
        voiceGuidelines: voice,
        portfolioNotes: portfolio,
        servicesOffered: services
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        approvedClaims: claims
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['marketing-brand'] }),
  });

  if (brand.isPending) return <Loading />;
  if (brand.isError) return <ErrorNote error={brand.error} />;

  return (
    <Section title="Brand profile">
      <form
        className="space-y-3 px-4 py-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Voice guidelines">{(id) => <Textarea id={id} rows={4} value={voice} onChange={(e) => setVoice(e.target.value)} disabled={!canWrite} />}</Field>
        <Field label="Services (comma-separated)">{(id) => <Input id={id} value={services} onChange={(e) => setServices(e.target.value)} disabled={!canWrite} />}</Field>
        <Field label="Portfolio notes">{(id) => <Textarea id={id} rows={3} value={portfolio} onChange={(e) => setPortfolio(e.target.value)} disabled={!canWrite} />}</Field>
        <Field label="Approved claims (one per line)" hint="Only these may be used in drafts. Never invent results.">
          {(id) => <Textarea id={id} rows={4} value={claims} onChange={(e) => setClaims(e.target.value)} disabled={!canWrite} />}
        </Field>
        {canWrite && (
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save brand profile
          </Button>
        )}
        <ErrorNote error={save.error} />
      </form>
    </Section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:justify-between">
      <dt className="text-ink-3">{label}</dt>
      <dd className="max-w-[60ch] text-ink">{value}</dd>
    </div>
  );
}
