import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { NewTaskDialog } from '../components/NewTaskDialog';
import { Button, Empty, ErrorNote, Input, Loading, PageHeader, Pagination, Select, StatusBadge, cx } from '../components/ui';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { KIND_LABEL, PRIORITY_LABEL, STATUS_LABEL, STATUS_ORDER, formatDate, timeAgo } from '../lib/format';
import type { Department, Page, TaskKind, TaskListItem, TaskStatus } from '../lib/types';

const SORTS = [
  { value: 'createdAt', label: 'Created' },
  { value: 'updatedAt', label: 'Last activity' },
  { value: 'dueAt', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'title', label: 'Title' },
];

export function TasksPage() {
  const { canWrite } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status')?.split(',').filter(Boolean) ?? []) as TaskStatus[];
  const search = params.get('search') ?? '';
  const departmentId = params.get('departmentId') ?? '';
  const kind = params.get('kind') ?? '';
  const sortBy = params.get('sortBy') ?? 'createdAt';
  const sortDir = (params.get('sortDir') ?? 'desc') as 'asc' | 'desc';
  const page = Number(params.get('page') ?? 1);
  const showNew = params.get('new') === '1';

  const [searchDraft, setSearchDraft] = useState(search);
  // Debounce typing into the URL
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

  const toggleStatus = (s: TaskStatus) => {
    const set = new Set(status);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    update({ status: [...set].join(',') || null, page: null });
  };

  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.get<Department[]>('/departments') });
  const tasks = useQuery({
    queryKey: ['tasks', { status, search, departmentId, kind, sortBy, sortDir, page }],
    queryFn: () => api.get<Page<TaskListItem>>(`/tasks${qs({ status, search, departmentId, kind, sortBy, sortDir, page, pageSize: 20 })}`),
    placeholderData: keepPreviousData,
  });
  const filtered = status.length > 0 || search || departmentId || kind;

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Everything you and your AI managers are working on, and where each piece stands."
        actions={
          canWrite && (
            <Button variant="primary" onClick={() => update({ new: '1' })}>
              <Plus className="size-4" aria-hidden />
              New task
            </Button>
          )
        }
      />

      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input
              type="search"
              aria-label="Search tasks"
              placeholder="Search titles and details"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select aria-label="Department" value={departmentId} onChange={(e) => update({ departmentId: e.target.value, page: null })} className="w-auto">
            <option value="">All departments</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Type" value={kind} onChange={(e) => update({ kind: e.target.value, page: null })} className="w-auto">
            <option value="">All types</option>
            {(Object.keys(KIND_LABEL) as TaskKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}s
              </option>
            ))}
          </Select>
          <div className="flex">
            <Select aria-label="Sort by" value={sortBy} onChange={(e) => update({ sortBy: e.target.value })} className="w-auto rounded-r-none">
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  Sort: {s.label}
                </option>
              ))}
            </Select>
            <button
              onClick={() => update({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' })}
              className="rounded-r-md border border-l-0 border-rule-strong bg-panel px-2.5 text-ink-2 hover:text-ink"
              aria-label={sortDir === 'asc' ? 'Ascending, switch to descending' : 'Descending, switch to ascending'}
            >
              {sortDir === 'asc' ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status">
          {STATUS_ORDER.map((s) => {
            const on = status.includes(s);
            return (
              <button
                key={s}
                aria-pressed={on}
                onClick={() => toggleStatus(s)}
                className={cx(
                  'rounded-full border px-3 py-1 text-[13px] font-medium',
                  on ? 'border-ink bg-ink text-panel' : 'border-rule-strong bg-panel text-ink-2 hover:border-ink-3 hover:text-ink',
                )}
              >
                {STATUS_LABEL[s]}
              </button>
            );
          })}
          {filtered && (
            <button onClick={() => { setSearchDraft(''); setParams(new URLSearchParams(), { replace: true }); }} className="ml-1 text-[13px] font-medium text-brand hover:underline">
              Clear filters
            </button>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-rule bg-panel">
        {tasks.isPending ? (
          <Loading />
        ) : tasks.isError ? (
          <ErrorNote error={tasks.error} className="m-4" />
        ) : tasks.data.items.length === 0 ? (
          filtered ? (
            <Empty title="No tasks match these filters">Try another status or clear the search.</Empty>
          ) : (
            <Empty title="No tasks yet">
              {canWrite ? 'Create a task and assign it to the General Manager, a department, or a specific worker.' : 'Tasks will appear here once the CEO creates them.'}
            </Empty>
          )
        ) : (
          <>
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Tasks</caption>
              <thead className="hidden text-left text-[13px] text-ink-3 md:table-header-group">
                <tr className="border-b border-rule">
                  <th className="px-4 py-2.5 font-medium">Task</th>
                  <th className="px-3 py-2.5 font-medium">Assigned to</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Priority</th>
                  <th className="px-4 py-2.5 text-right font-medium">{sortBy === 'dueAt' ? 'Due' : 'Activity'}</th>
                </tr>
              </thead>
              <tbody className={cx('divide-y divide-rule', tasks.isPlaceholderData && 'opacity-60')}>
                {tasks.data.items.map((t) => (
                  <tr key={t.id} className="relative flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-sunken md:table-row md:p-0">
                    <td className="w-full md:w-auto md:px-4 md:py-3">
                      <Link to={`/tasks/${t.id}`} className="font-medium text-ink after:absolute after:inset-0 hover:underline">
                        {t.title}
                      </Link>
                      <span className="block text-[13px] text-ink-3">
                        {KIND_LABEL[t.kind]}
                        {t._count.subtasks > 0 && `, ${t._count.subtasks} subtask${t._count.subtasks === 1 ? '' : 's'}`}
                        {t.attempts > 0 && `, attempt ${t.attempts} of ${t.maxAttempts}`}
                      </span>
                    </td>
                    <td className="text-ink-2 md:px-3 md:py-3">{t.assignedAgent?.name ?? (t.department ? `${t.department.name} department` : 'General Manager')}</td>
                    <td className="md:px-3 md:py-3">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className={cx('md:px-3 md:py-3', t.priority === 'URGENT' ? 'font-semibold text-st-failed' : t.priority === 'HIGH' ? 'font-medium text-ink' : 'text-ink-3')}>
                      {PRIORITY_LABEL[t.priority]}
                    </td>
                    <td className="num text-[13px] text-ink-3 md:px-4 md:py-3 md:text-right">
                      {sortBy === 'dueAt' ? (t.dueAt ? formatDate(t.dueAt, true) : 'No due date') : timeAgo(t.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={tasks.data.page} totalPages={tasks.data.totalPages} total={tasks.data.total} onPage={(p) => update({ page: String(p) })} />
          </>
        )}
      </div>

      <NewTaskDialog open={showNew && canWrite} onClose={() => update({ new: null })} />
    </>
  );
}
