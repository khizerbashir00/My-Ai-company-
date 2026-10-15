import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api';
import { AGENT_KIND_LABEL, PRIORITY_LABEL } from '../lib/format';
import type { Agent, Department, TaskDetail, TaskPriority } from '../lib/types';
import { Button, ErrorNote, Field, Input, Select, Textarea } from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
  parentTaskId?: string;
}

export function NewTaskDialog({ open, onClose, parentTaskId }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.get<Agent[]>('/agents'), enabled: open });
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.get<Department[]>('/departments'), enabled: open });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState(''); // "agent:<id>" | "dept:<id>" | ""
  const [priority, setPriority] = useState<TaskPriority>('NORMAL');
  const [dueAt, setDueAt] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(3);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const create = useMutation({
    mutationFn: () => {
      const [type, id] = assignee.split(':');
      return api.post<{ task: TaskDetail }>('/tasks', {
        title,
        ...(description && { description }),
        ...(type === 'agent' && { assignedAgentId: id }),
        ...(type === 'dept' && { departmentId: id }),
        priority,
        ...(dueAt && { dueAt: new Date(dueAt).toISOString() }),
        maxAttempts,
        ...(parentTaskId && { parentTaskId }),
      });
    },
    onSuccess: ({ task }) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
      if (parentTaskId) void qc.invalidateQueries({ queryKey: ['task', parentTaskId] });
      setTitle('');
      setDescription('');
      setAssignee('');
      setPriority('NORMAL');
      setDueAt('');
      onClose();
      navigate(`/tasks/${task.id}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const gm = agents.data?.filter((a) => a.kind === 'GENERAL_MANAGER') ?? [];
  const byDept = (key: string) => agents.data?.filter((a) => a.department?.key === key) ?? [];

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="new-task-title"
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-rule bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/35"
    >
      <form onSubmit={submit} className="flex max-h-[90dvh] flex-col">
        <div className="flex items-center justify-between border-b border-rule px-5 py-4">
          <h2 id="new-task-title" className="text-lg font-semibold">
            {parentTaskId ? 'New subtask' : 'New task'}
          </h2>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-5">
          <Field label="What needs doing?" hint="Write it the way you’d brief a manager.">
            {(id) => (
              <Input
                id={id}
                required
                minLength={3}
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Find US businesses asking for a new website"
                autoFocus
              />
            )}
          </Field>
          <Field label="Details" hint="Optional. Targets, constraints, deadlines, what a good result looks like.">
            {(id) => <Textarea id={id} rows={4} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <Field
            label="Assign to"
            hint={
              assignee === ''
                ? 'Unassigned tasks become goals for the General Manager to plan.'
                : assignee.startsWith('dept:')
                  ? 'The department’s manager will decide who does it.'
                  : undefined
            }
          >
            {(id) => (
              <Select id={id} value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={agents.isPending}>
                <option value="">Goal for the General Manager</option>
                {gm.map((a) => (
                  <option key={a.id} value={`agent:${a.id}`} disabled={!a.isEnabled}>
                    {a.name}
                  </option>
                ))}
                {departments.data?.map((d) => (
                  <optgroup key={d.id} label={d.name}>
                    <option value={`dept:${d.id}`}>{d.name} department (manager decides)</option>
                    {byDept(d.key).map((a) => (
                      <option key={a.id} value={`agent:${a.id}`} disabled={!a.isEnabled}>
                        {a.name} ({AGENT_KIND_LABEL[a.kind].toLowerCase()}){a.isEnabled ? '' : ', disabled'}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
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
            <Field label="Due">
              {(id) => <Input id={id} type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />}
            </Field>
            <Field label="Retry limit">
              {(id) => (
                <Input id={id} type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value) || 1)} />
              )}
            </Field>
          </div>
          <ErrorNote error={create.error} />
        </div>

        <div className="flex justify-end gap-2 border-t border-rule px-5 py-4">
          <Button type="button" variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={create.isPending} disabled={title.trim().length < 3}>
            Create task
          </Button>
        </div>
      </form>
    </dialog>
  );
}
