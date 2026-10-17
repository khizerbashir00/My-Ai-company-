import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Empty, ErrorNote, Loading, PageHeader, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';

interface ThreadAgent {
  id: string;
  key: string;
  name: string;
  kind: string;
  role: string;
}

interface ThreadSummary {
  id: string;
  subject: string;
  lastMessageAt: string;
  createdAt: string;
  agent: ThreadAgent;
  lastMessage: { id: string; body: string; authorKind: string; createdAt: string } | null;
}

interface ThreadMessage {
  id: string;
  body: string;
  authorKind: 'USER' | 'AGENT';
  createdAt: string;
  taskId: string | null;
  user: { id: string; name: string; role: string } | null;
  agent: { id: string; key: string; name: string; kind: string } | null;
}

interface ThreadDetail {
  id: string;
  subject: string;
  lastMessageAt: string;
  agent: ThreadAgent & { isEnabled: boolean };
  messages: ThreadMessage[];
}

interface AgentOption {
  id: string;
  key: string;
  name: string;
  kind: string;
  role: string;
  department: { key: string; name: string } | null;
}

export function MessagesPage() {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [agentId, setAgentId] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const threads = useQuery({
    queryKey: ['messages', 'threads'],
    queryFn: () => api.get<ThreadSummary[]>('/messages'),
  });
  const agents = useQuery({
    queryKey: ['messages', 'agents'],
    queryFn: () => api.get<AgentOption[]>('/messages/agents'),
  });
  const thread = useQuery({
    queryKey: ['messages', 'thread', threadId],
    queryFn: () => api.get<ThreadDetail>(`/messages/${threadId}`),
    enabled: Boolean(threadId),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread.data?.messages.length, threadId]);

  const send = useMutation({
    mutationFn: async () => {
      const body = draft.trim();
      if (!body) throw new Error('Write a message first.');
      if (threadId) {
        return api.post<ThreadDetail>(`/messages/${threadId}`, { body });
      }
      if (!agentId) throw new Error('Pick a teammate first.');
      return api.post<ThreadDetail>('/messages', { body, agentId });
    },
    onSuccess: (data) => {
      setDraft('');
      void qc.invalidateQueries({ queryKey: ['messages'] });
      if (!threadId || threadId !== data.id) navigate(`/messages/${data.id}`);
      else void qc.setQueryData(['messages', 'thread', data.id], data);
    },
  });

  return (
    <>
      <PageHeader
        title="Messages"
        description="Talk to your AI teammates. They reply here — and message you again after they finish work."
      />

      <div className="grid min-h-[70vh] grid-cols-1 overflow-hidden rounded-lg border border-rule bg-panel lg:grid-cols-[280px_1fr]">
        <aside className="border-b border-rule lg:border-b-0 lg:border-r">
          <div className="border-b border-rule px-3 py-2.5 text-[13px] font-medium text-ink-3">Conversations</div>
          {threads.isPending ? (
            <Loading label="Loading threads" />
          ) : threads.isError ? (
            <div className="p-3">
              <ErrorNote error={threads.error} />
            </div>
          ) : threads.data.length === 0 ? (
            <p className="p-4 text-sm text-ink-3">No conversations yet. Start one on the right.</p>
          ) : (
            <ul className="max-h-[40vh] overflow-y-auto lg:max-h-[calc(70vh-2.5rem)]">
              {threads.data.map((t) => (
                <li key={t.id}>
                  <Link
                    to={`/messages/${t.id}`}
                    className={cx(
                      'block border-b border-rule px-3 py-3 hover:bg-sunken',
                      threadId === t.id && 'bg-brand-wash',
                    )}
                  >
                    <span className="block text-sm font-medium text-ink">{t.agent.name}</span>
                    <span className="mt-0.5 line-clamp-2 block text-[13px] text-ink-3">
                      {t.lastMessage?.body ?? t.subject ?? 'No messages'}
                    </span>
                    <span className="mt-1 block text-[12px] text-ink-3">{timeAgo(t.lastMessageAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="flex min-h-[50vh] flex-col">
          {!threadId ? (
            <div className="flex flex-1 flex-col">
              <div className="flex-1 p-6">
                <Empty title="Message your team">
                  Pick a teammate below and ask for a status update, a plan, or next steps. They answer as themselves —
                  General Manager, Sales Manager, workers, and the rest.
                </Empty>
              </div>
              {canWrite ? (
                <Composer
                  agents={agents.data ?? []}
                  agentId={agentId}
                  onAgentChange={setAgentId}
                  draft={draft}
                  onDraftChange={setDraft}
                  pending={send.isPending}
                  error={send.error}
                  onSend={() => send.mutate()}
                  showAgentPicker
                />
              ) : null}
            </div>
          ) : thread.isPending ? (
            <Loading label="Opening conversation" />
          ) : thread.isError ? (
            <div className="p-4">
              <ErrorNote error={thread.error} />
            </div>
          ) : (
            <>
              <header className="border-b border-rule px-4 py-3">
                <h2 className="font-semibold text-ink">{thread.data.agent.name}</h2>
                <p className="text-[13px] text-ink-3">{thread.data.agent.role}</p>
              </header>
              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {thread.data.messages.map((m) => {
                  const mine = m.authorKind === 'USER';
                  return (
                    <div key={m.id} className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
                      <div
                        className={cx(
                          'max-w-[85%] rounded-lg px-3 py-2 text-sm',
                          mine ? 'bg-ink text-panel' : 'bg-sunken text-ink',
                        )}
                      >
                        {!mine && (
                          <p className="mb-1 text-[12px] font-medium text-ink-3">{m.agent?.name ?? 'Teammate'}</p>
                        )}
                        <p className="whitespace-pre-wrap">{m.body}</p>
                        <p className={cx('mt-1 text-[11px]', mine ? 'text-panel/70' : 'text-ink-3')}>
                          {timeAgo(m.createdAt)}
                          {m.taskId ? (
                            <>
                              {' · '}
                              <Link to={`/tasks/${m.taskId}`} className="underline underline-offset-2">
                                related task
                              </Link>
                            </>
                          ) : null}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
              {canWrite ? (
                <Composer
                  agents={[]}
                  agentId=""
                  onAgentChange={() => undefined}
                  draft={draft}
                  onDraftChange={setDraft}
                  pending={send.isPending}
                  error={send.error}
                  onSend={() => send.mutate()}
                  showAgentPicker={false}
                />
              ) : null}
            </>
          )}
        </section>
      </div>
    </>
  );
}

function Composer({
  agents,
  agentId,
  onAgentChange,
  draft,
  onDraftChange,
  pending,
  error,
  onSend,
  showAgentPicker,
}: {
  agents: AgentOption[];
  agentId: string;
  onAgentChange: (id: string) => void;
  draft: string;
  onDraftChange: (v: string) => void;
  pending: boolean;
  error: unknown;
  onSend: () => void;
  showAgentPicker: boolean;
}) {
  return (
    <div className="border-t border-rule p-3">
      {showAgentPicker ? (
        <label className="mb-2 block text-[13px] text-ink-2">
          Teammate
          <select
            className="mt-1 w-full rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm"
            value={agentId}
            onChange={(e) => onAgentChange(e.target.value)}
          >
            <option value="">Select…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.department ? ` · ${a.department.name}` : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="flex gap-2">
        <textarea
          className="min-h-[72px] flex-1 resize-y rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm"
          placeholder="Message as CEO…"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button
          type="button"
          disabled={pending || !draft.trim() || (showAgentPicker && !agentId)}
          onClick={onSend}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 self-end rounded-md bg-brand px-3 text-sm font-medium text-white disabled:opacity-50"
        >
          <MessageSquare className="size-4" aria-hidden />
          {pending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-[13px] text-st-failed">
          {error instanceof Error ? error.message : 'Could not send message.'}
        </p>
      ) : (
        <p className="mt-1.5 text-[12px] text-ink-3">⌘/Ctrl + Enter to send</p>
      )}
    </div>
  );
}
