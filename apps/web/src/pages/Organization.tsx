import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ErrorNote, Loading, PageHeader, cx } from '../components/ui';
import { api } from '../lib/api';
import type { Department, OrgNode } from '../lib/types';

export function OrganizationPage() {
  const org = useQuery({ queryKey: ['org'], queryFn: () => api.get<{ root: OrgNode[] }>('/departments/org-chart') });
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.get<Department[]>('/departments') });

  return (
    <>
      <PageHeader
        title="Organization"
        description="Who reports to whom. Each role is a set of instructions, tools and permissions you control; they share one AI provider."
      />
      {org.isPending || departments.isPending ? (
        <Loading />
      ) : org.isError ? (
        <ErrorNote error={org.error} />
      ) : (
        <Chart root={org.data.root} departments={departments.data ?? []} />
      )}
    </>
  );
}

function Chart({ root, departments }: { root: OrgNode[]; departments: Department[] }) {
  const gm = root.find((n) => n.kind === 'GENERAL_MANAGER');
  if (!gm) return <p className="text-ink-3">No General Manager is defined.</p>;

  return (
    <div className="flex flex-col items-center">
      <div className="rounded-lg bg-ink px-5 py-2.5 text-center text-panel">
        <p className="font-semibold">You</p>
        <p className="text-[13px] opacity-75">CEO: demos, deals, development</p>
      </div>
      <Stem />
      <AgentBox node={gm} emphasis />
      <Stem />

      {/* The horizontal bar spans exactly between the two department column centres on wide screens */}
      <div className="grid w-full grid-cols-1 gap-8 md:grid-cols-2 md:gap-6">
        {gm.children.map((manager, i) => {
          const dept = departments.find((d) => d.id === manager.departmentId);
          return (
            <div key={manager.id} className="relative flex flex-col items-center">
              <span
                aria-hidden
                className={cx('absolute top-0 hidden h-px bg-rule-strong md:block', i === 0 ? 'left-1/2 right-[-12px]' : 'left-[-12px] right-1/2')}
              />
              <span aria-hidden className="hidden h-5 w-px bg-rule-strong md:block" />
              <div className="w-full rounded-lg border border-rule bg-panel">
                <div className="border-b border-rule px-4 py-3">
                  <h2 className="text-lg font-semibold">{dept?.name ?? 'Department'}</h2>
                  {dept && <p className="mt-0.5 text-sm text-ink-2">{dept.description}</p>}
                  {dept && (
                    <p className="num mt-2 text-[13px] text-ink-3">
                      {dept.taskStats.open} open, {dept.taskStats.completed} completed, {dept.taskStats.failed} failed
                    </p>
                  )}
                </div>
                <div className="p-3">
                  <AgentBox node={manager} />
                  <ul className="ml-5 mt-2 border-l border-rule-strong">
                    {manager.children.map((w) => (
                      <li key={w.id} className="relative pl-4 pt-2">
                        <span aria-hidden className="absolute left-0 top-[26px] h-px w-3 bg-rule-strong" />
                        <AgentBox node={w} compact />
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stem() {
  return <span aria-hidden className="h-5 w-px bg-rule-strong" />;
}

function AgentBox({ node, emphasis, compact }: { node: OrgNode; emphasis?: boolean; compact?: boolean }) {
  return (
    <Link
      to={`/organization/${node.id}`}
      className={cx(
        'group flex items-start gap-3 rounded-md border px-3 text-left hover:border-brand',
        compact ? 'border-transparent py-1.5 hover:bg-sunken' : 'border-rule bg-panel py-2.5',
        emphasis && 'min-w-[260px] border-brand bg-brand-wash',
        !node.isEnabled && 'opacity-55',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cx('block font-medium text-ink group-hover:text-brand-ink', compact ? 'text-sm' : 'text-[15px]')}>
          {node.name}
          {!node.isEnabled && <span className="ml-2 text-[12px] font-normal text-ink-3">disabled</span>}
        </span>
        <span className={cx('block text-[13px] leading-snug text-ink-3', compact && 'line-clamp-1')}>{node.role}</span>
      </span>
      <span className="num shrink-0 pt-0.5 text-right text-[13px]" title="Open tasks">
        <span className={cx('font-semibold', node.openTasks > 0 ? 'text-st-running' : 'text-ink-3')}>{node.openTasks}</span>
        <span className="text-ink-3"> open</span>
      </span>
    </Link>
  );
}
