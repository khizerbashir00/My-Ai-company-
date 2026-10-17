import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Empty, ErrorNote, Loading, PageHeader, Section } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';

interface ReportListItem {
  id: string;
  period: 'DAILY' | 'WEEKLY';
  periodStart: string;
  periodEnd: string;
  title: string;
  generatedAt: string;
}

interface ReportDetail extends ReportListItem {
  body: string;
  metricsSnapshot: Record<string, unknown>;
}

export function ReportsPage() {
  const { id } = useParams();
  if (id) return <ReportDetailView id={id} />;
  return <ReportList />;
}

function ReportList() {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['ceo-reports'],
    queryFn: () => api.get<{ items: ReportListItem[]; total: number }>('/dashboard/reports?page=1&pageSize=50'),
  });
  const generate = useMutation({
    mutationFn: (period: 'DAILY' | 'WEEKLY') => api.post('/dashboard/reports/generate', { period }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ceo-reports'] }),
  });

  return (
    <>
      <PageHeader
        title="CEO reports"
        description="Daily and weekly summaries counted from saved HQ data — not invented figures."
        actions={
          canWrite ? (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={generate.isPending}
                onClick={() => generate.mutate('DAILY')}
                className="rounded-md border border-rule-strong bg-panel px-3 py-1.5 text-sm font-medium hover:bg-sunken"
              >
                Generate daily
              </button>
              <button
                type="button"
                disabled={generate.isPending}
                onClick={() => generate.mutate('WEEKLY')}
                className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:opacity-90"
              >
                Generate weekly
              </button>
            </div>
          ) : null
        }
      />
      {list.isPending ? (
        <Loading label="Loading reports" />
      ) : list.isError ? (
        <ErrorNote error={list.error} />
      ) : list.data.items.length === 0 ? (
        <Empty title="No CEO reports yet">{canWrite ? 'Generate a daily or weekly report from current metrics.' : 'Ask the CEO to generate a report.'}</Empty>
      ) : (
        <Section title="Saved reports">
          <ul className="divide-y divide-rule">
            {list.data.items.map((r) => (
              <li key={r.id}>
                <Link to={`/reports/${r.id}`} className="block px-4 py-3 text-sm hover:bg-sunken">
                  <span className="font-medium text-ink">{r.title}</span>
                  <span className="mt-0.5 block text-[13px] text-ink-3">
                    {r.period} · {timeAgo(r.generatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function ReportDetailView({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ['ceo-report', id],
    queryFn: () => api.get<ReportDetail>(`/dashboard/reports/${id}`),
  });
  if (detail.isPending) return <Loading label="Loading report" />;
  if (detail.isError) return <ErrorNote error={detail.error} />;
  const r = detail.data;
  return (
    <>
      <PageHeader title={r.title} description={`${r.period} · generated ${timeAgo(r.generatedAt)}`} />
      <p className="mb-4">
        <Link to="/reports" className="text-sm font-medium text-ink-2 hover:text-ink">
          ← All reports
        </Link>
      </p>
      <Section title="Summary">
        <pre className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-ink-2">{r.body}</pre>
      </Section>
    </>
  );
}
