import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Plus } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { NewTaskDialog } from '../components/NewTaskDialog';
import { Button, Empty, ErrorNote, Field, Input, Loading, Section, Select, StatusBadge, Textarea, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { KIND_LABEL, PRIORITY_LABEL, STATUS_LABEL, TASK_TRANSITIONS, formatDate, timeAgo, transitionLabel } from '../lib/format';
import type { TaskDetail, TaskPriority, TaskStatus } from '../lib/types';

export function TaskDetailPage() {
  const { id = '' } = useParams();
  const task = useQuery({ queryKey: ['task', id], queryFn: () => api.get<TaskDetail>(`/tasks/${id}`) });

  return (
    <>
      <Link to="/tasks" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-ink-2 hover:text-ink">
        <ChevronLeft className="size-4" aria-hidden />
        Tasks
      </Link>
      {task.isPending ? <Loading /> : task.isError ? <ErrorNote error={task.error} /> : <TaskView task={task.data} />}
    </>
  );
}

function TaskView({ task }: { task: TaskDetail }) {
  const { canWrite } = useAuth();
  const [editing, setEditing] = useState(false);
  const [subtaskOpen, setSubtaskOpen] = useState(false);
  const terminal = task.status === 'COMPLETED' || task.status === 'CANCELLED';

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        <header>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <StatusBadge status={task.status} />
            <span className="text-sm text-ink-3">
              {KIND_LABEL[task.kind]}, {PRIORITY_LABEL[task.priority].toLowerCase()} priority
            </span>
          </div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em]">{task.title}</h1>
          {task.parentTask && (
            <p className="mt-1 text-sm text-ink-2">
              Part of{' '}
              <Link to={`/tasks/${task.parentTask.id}`} className="font-medium text-brand hover:underline">
                {task.parentTask.title}
              </Link>
            </p>
          )}
        </header>

        {task.status === 'FAILED' && task.errorMessage && (
          <div role="alert" className="rounded-lg bg-st-failed-wash px-4 py-3 text-sm text-st-failed">
            <p className="font-semibold">Why it failed</p>
            <p className="mt-0.5">{task.errorMessage}</p>
            <p className="mt-1 text-[13px]">
              Attempt {task.attempts} of {task.maxAttempts}.
              {task.attempts >= task.maxAttempts && ' Raise the retry limit to try again.'}
            </p>
          </div>
        )}

        {canWrite && !terminal && <Actions task={task} />}

        {editing ? (
          <EditForm task={task} onDone={() => setEditing(false)} />
        ) : (
          <Section
            title="Brief"
            aside={
              canWrite &&
              !terminal && (
                <Button variant="quiet" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )
            }
          >
            <div className="px-4 py-4">
              {task.description ? (
                <p className="max-w-[72ch] whitespace-pre-wrap leading-relaxed text-ink">{task.description}</p>
              ) : (
                <p className="text-ink-3">No details were given.</p>
              )}
            </div>
          </Section>
        )}

        <Section
          title="Subtasks"
          aside={
            canWrite &&
            !terminal && (
              <Button variant="quiet" onClick={() => setSubtaskOpen(true)}>
                <Plus className="size-4" aria-hidden />
                Add subtask
              </Button>
            )
          }
        >
          {task.subtasks.length === 0 ? (
            <p className="px-4 py-4 text-sm text-ink-3">None yet. Managers create subtasks for their workers once AI execution is switched on (Phase 2).</p>
          ) : (
            <ul className="divide-y divide-rule">
              {task.subtasks.map((s) => (
                <li key={s.id}>
                  <Link to={`/tasks/${s.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-sunken">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{s.title}</span>
                      <span className="block text-[13px] text-ink-3">{s.assignedAgent?.name ?? 'Unassigned'}</span>
                    </span>
                    <StatusBadge status={s.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="History">
          <ol className="px-4 py-4">
            {task.events.map((e, i) => (
              <li key={e.id} className="relative flex gap-3 pb-5 last:pb-0">
                {i < task.events.length - 1 && <span aria-hidden className="absolute left-[5px] top-4 h-full w-px bg-rule" />}
                <span
                  aria-hidden
                  className={cx(
                    'relative mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-panel ring-1',
                    e.toStatus ? dotColor(e.toStatus) : 'bg-rule-strong ring-rule-strong',
                  )}
                />
                <div className="min-w-0 text-sm">
                  <p className="text-ink">
                    {e.type === 'created' ? 'Created' : e.type === 'retry' ? 'Retried' : e.type === 'updated' ? 'Edited' : `Moved to ${STATUS_LABEL[e.toStatus!]}`}
                    <span className="text-ink-3">
                      {' '}
                      by {e.actorUser?.name ?? e.actorAgent?.name ?? 'the system'}
                    </span>
                  </p>
                  {e.message && !/^\w+ → \w+$/.test(e.message) && e.type !== 'created' && <p className="mt-0.5 text-ink-2">{e.message}</p>}
                  <time dateTime={e.createdAt} title={formatDate(e.createdAt, true)} className="text-[13px] text-ink-3">
                    {timeAgo(e.createdAt)}
                  </time>
                </div>
              </li>
            ))}
          </ol>
        </Section>
      </div>

      <aside className="space-y-6">
        <Section title="Details">
          <dl className="divide-y divide-rule text-sm">
            <Meta label="Assigned to">
              {task.assignedAgent ? (
                <Link to={`/organization/${task.assignedAgent.id}`} className="font-medium text-brand hover:underline">
                  {task.assignedAgent.name}
                </Link>
              ) : task.department ? (
                `${task.department.name} department`
              ) : (
                'General Manager (goal)'
              )}
            </Meta>
            <Meta label="Department">{task.department?.name ?? 'Company-wide'}</Meta>
            <Meta label="Due">{task.dueAt ? formatDate(task.dueAt, true) : 'No due date'}</Meta>
            <Meta label="Attempts">
              <span className="num">
                {task.attempts} of {task.maxAttempts}
              </span>
            </Meta>
            <Meta label="Created">
              {formatDate(task.createdAt, true)}
              {task.createdBy && <span className="block text-ink-3">by {task.createdBy.name}</span>}
            </Meta>
            {task.startedAt && <Meta label="Started">{formatDate(task.startedAt, true)}</Meta>}
            {task.completedAt && <Meta label={task.status === 'CANCELLED' ? 'Cancelled' : 'Finished'}>{formatDate(task.completedAt, true)}</Meta>}
          </dl>
        </Section>

        <Section title="Waits for">
          {task.dependencies.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-3">No dependencies. This task can start any time.</p>
          ) : (
            <ul className="divide-y divide-rule">
              {task.dependencies.map(({ dependsOn: d }) => (
                <li key={d.id}>
                  <Link to={`/tasks/${d.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm hover:bg-sunken">
                    <span className="truncate">{d.title}</span>
                    <StatusBadge status={d.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="AI runs">
          {task.runs.length === 0 ? (
            <Empty title="No runs yet">Model calls, token usage and tool calls for this task will be listed here.</Empty>
          ) : (
            <ul className="divide-y divide-rule text-sm">
              {task.runs.map((r) => (
                <li key={r.id} className="px-4 py-2.5">
                  {r.agent.name}, {r.model} ({r.status.toLowerCase()})
                </li>
              ))}
            </ul>
          )}
        </Section>
      </aside>

      <NewTaskDialog open={subtaskOpen} onClose={() => setSubtaskOpen(false)} parentTaskId={task.id} />
    </div>
  );
}

function Actions({ task }: { task: TaskDetail }) {
  const qc = useQueryClient();
  const [failing, setFailing] = useState(false);
  const [reason, setReason] = useState('');
  const move = useMutation({
    mutationFn: (body: { to: TaskStatus; message?: string }) => api.post<TaskDetail>(`/tasks/${task.id}/transition`, body),
    onSuccess: (updated) => {
      qc.setQueryData(['task', task.id], updated);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
      setFailing(false);
      setReason('');
    },
  });

  const unmet = task.dependencies.filter((d) => d.dependsOn.status !== 'COMPLETED').length;
  const targets = TASK_TRANSITIONS[task.status];
  const retryBlocked = task.status === 'FAILED' && task.attempts >= task.maxAttempts;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {targets
          .filter((to) => to !== 'CANCELLED')
          .map((to) => {
            const disabled = (to === 'RUNNING' && task.status === 'QUEUED' && unmet > 0) || (to === 'QUEUED' && retryBlocked);
            return (
              <Button
                key={to}
                variant={to === 'COMPLETED' || (task.status === 'FAILED' && to === 'QUEUED') ? 'primary' : 'secondary'}
                disabled={disabled}
                title={disabled ? (to === 'QUEUED' ? 'Retry limit reached' : `Waiting on ${unmet} unfinished task${unmet === 1 ? '' : 's'}`) : undefined}
                busy={move.isPending && move.variables?.to === to}
                onClick={() => (to === 'FAILED' ? setFailing(true) : move.mutate({ to }))}
              >
                {transitionLabel(task.status, to)}
              </Button>
            );
          })}
        <Button
          variant="danger"
          busy={move.isPending && move.variables?.to === 'CANCELLED'}
          onClick={() => {
            const msg = task._count.subtasks > 0 ? 'Cancel this task and all its unfinished subtasks?' : 'Cancel this task?';
            if (window.confirm(msg)) move.mutate({ to: 'CANCELLED' });
          }}
        >
          Cancel task
        </Button>
      </div>
      {failing && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            move.mutate({ to: 'FAILED', message: reason });
          }}
          className="flex flex-wrap items-end gap-2 rounded-lg border border-rule bg-panel p-3"
        >
          <div className="min-w-[240px] flex-1">
            <Field label="What went wrong?">
              {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} autoFocus required />}
            </Field>
          </div>
          <Button type="button" variant="quiet" onClick={() => setFailing(false)}>
            Keep running
          </Button>
          <Button type="submit" variant="danger" disabled={!reason.trim()} busy={move.isPending}>
            Mark failed
          </Button>
        </form>
      )}
      <ErrorNote error={move.error} />
    </div>
  );
}

function EditForm({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueAt, setDueAt] = useState(task.dueAt ? toLocalInput(task.dueAt) : '');
  const [maxAttempts, setMaxAttempts] = useState(task.maxAttempts);

  const save = useMutation({
    mutationFn: () =>
      api.patch<TaskDetail>(`/tasks/${task.id}`, {
        title,
        description,
        priority,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        maxAttempts,
      }),
    onSuccess: (updated) => {
      qc.setQueryData(['task', task.id], updated);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      onDone();
    },
  });

  return (
    <Section title="Edit brief">
      <form
        className="space-y-4 px-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Title">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required />}</Field>
        <Field label="Details">{(id) => <Textarea id={id} rows={5} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />}</Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Priority">
            {(id) => (
              <Select id={id} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
                {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Due">{(id) => <Input id={id} type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />}</Field>
          <Field label="Retry limit" hint={`At least ${Math.max(1, task.attempts)}`}>
            {(id) => (
              <Input id={id} type="number" min={Math.max(1, task.attempts)} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value) || 1)} />
            )}
          </Field>
        </div>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="quiet" onClick={onDone}>
            Discard
          </Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save changes
          </Button>
        </div>
      </form>
    </Section>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 px-4 py-2.5">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
  );
}

function dotColor(s: TaskStatus): string {
  return {
    QUEUED: 'bg-st-queued ring-st-queued',
    RUNNING: 'bg-st-running ring-st-running',
    AWAITING_APPROVAL: 'bg-st-waiting ring-st-waiting',
    COMPLETED: 'bg-st-done ring-st-done',
    FAILED: 'bg-st-failed ring-st-failed',
    CANCELLED: 'bg-st-cancelled ring-st-cancelled',
  }[s];
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
