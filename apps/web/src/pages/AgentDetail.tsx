import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button, ErrorNote, Field, Input, Loading, Section, Select, StatusBadge, Textarea, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AGENT_KIND_LABEL, timeAgo } from '../lib/format';
import type { Agent, AgentPermission, ModelTier, Registry, SystemStatus } from '../lib/types';

export function AgentDetailPage() {
  const { id = '' } = useParams();
  const agent = useQuery({ queryKey: ['agent', id], queryFn: () => api.get<Agent>(`/agents/${id}`) });
  const registry = useQuery({ queryKey: ['registry'], queryFn: () => api.get<Registry>('/agents/registry'), staleTime: Infinity });

  return (
    <>
      <Link to="/organization" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-ink-2 hover:text-ink">
        <ChevronLeft className="size-4" aria-hidden />
        Organization
      </Link>
      {agent.isPending || registry.isPending ? (
        <Loading />
      ) : agent.isError ? (
        <ErrorNote error={agent.error} />
      ) : registry.isError ? (
        <ErrorNote error={registry.error} />
      ) : (
        <AgentView key={agent.data.id + agent.dataUpdatedAt} agent={agent.data} registry={registry.data} />
      )}
    </>
  );
}

function AgentView({ agent, registry }: { agent: Agent; registry: Registry }) {
  const { isCeo } = useAuth();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api.get<SystemStatus>('/system/status') });

  const [role, setRole] = useState(agent.role);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [reporting, setReporting] = useState(agent.reportingResponsibilities);
  const [modelTier, setModelTier] = useState<ModelTier>(agent.modelTier);
  const [modelOverride, setModelOverride] = useState(agent.modelOverride ?? '');
  const [maxOutputTokens, setMaxOutputTokens] = useState(agent.maxOutputTokens);
  const [tools, setTools] = useState<string[]>(agent.tools);
  const [perms, setPerms] = useState<AgentPermission[]>(agent.permissions);

  const permDefs = useMemo(() => new Map(registry.permissions.map((p) => [p.key, p])), [registry]);
  const held = new Set(perms.map((p) => p.permission));

  const dirtyConfig =
    role !== agent.role ||
    instructions !== agent.instructions ||
    reporting !== agent.reportingResponsibilities ||
    modelTier !== agent.modelTier ||
    (modelOverride || null) !== agent.modelOverride ||
    maxOutputTokens !== agent.maxOutputTokens ||
    tools.join() !== agent.tools.join();
  const dirtyPerms = JSON.stringify(sortPerms(perms)) !== JSON.stringify(sortPerms(agent.permissions));

  const refresh = (updated: Agent) => {
    qc.setQueryData(['agent', agent.id], updated);
    void qc.invalidateQueries({ queryKey: ['org'] });
    void qc.invalidateQueries({ queryKey: ['agents'] });
  };

  // The server checks tools against held permissions on every call, so save in three steps:
  // 1) config + only the tools the *current* permissions allow, 2) permissions, 3) the final tool list.
  const save = useMutation({
    mutationFn: async () => {
      const toolNeeds = new Map(registry.tools.map((t) => [t.name, t.requires]));
      const oldHeld = new Set(agent.permissions.map((p) => p.permission));
      const safeTools = tools.filter((t) => oldHeld.has(toolNeeds.get(t) ?? ''));
      let updated = agent;
      if (dirtyConfig || dirtyPerms) {
        updated = await api.patch<Agent>(`/agents/${agent.id}`, {
          role,
          instructions,
          reportingResponsibilities: reporting,
          modelTier,
          modelOverride: modelOverride.trim() || null,
          maxOutputTokens,
          tools: safeTools,
        });
      }
      if (dirtyPerms) updated = await api.put<Agent>(`/agents/${agent.id}/permissions`, { permissions: perms });
      if (safeTools.length !== tools.length) updated = await api.patch<Agent>(`/agents/${agent.id}`, { tools });
      return updated;
    },
    onSuccess: refresh,
  });

  const toggleEnabled = useMutation({
    mutationFn: () => api.patch<Agent>(`/agents/${agent.id}`, { isEnabled: !agent.isEnabled }),
    onSuccess: refresh,
  });

  const tierModel = modelTier === 'ADVANCED' ? status.data?.ai.advancedModel : status.data?.ai.routineModel;

  function togglePerm(key: string) {
    const def = permDefs.get(key);
    if (held.has(key)) setPerms(perms.filter((p) => p.permission !== key));
    else setPerms([...perms, { permission: key, requiresApproval: def?.approvalLocked ?? false }]);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-ink-3">
            {AGENT_KIND_LABEL[agent.kind]}
            {agent.department && ` in ${agent.department.name}`}
            {agent.parent && (
              <>
                , reports to{' '}
                <Link to={`/organization/${agent.parent.id}`} className="font-medium text-brand hover:underline">
                  {agent.parent.name}
                </Link>
              </>
            )}
          </p>
          <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-[-0.01em]">{agent.name}</h1>
          {!agent.isEnabled && <p className="mt-1 text-sm font-medium text-st-waiting">Disabled: no new work can be assigned to this role.</p>}
        </div>
        {isCeo && (
          <Button variant={agent.isEnabled ? 'secondary' : 'primary'} busy={toggleEnabled.isPending} onClick={() => toggleEnabled.mutate()}>
            {agent.isEnabled ? 'Disable role' : 'Enable role'}
          </Button>
        )}
      </header>
      <ErrorNote error={toggleEnabled.error} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Section title="Role and instructions">
            <fieldset disabled={!isCeo} className="space-y-4 px-4 py-4">
              <Field label="Role">{(id) => <Input id={id} value={role} onChange={(e) => setRole(e.target.value)} maxLength={500} />}</Field>
              <Field label="Instructions" hint="What this role does, how it should work, and what it must never do. Sent to the model with every task.">
                {(id) => (
                  <Textarea id={id} rows={12} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={8000} className="text-[14px]" />
                )}
              </Field>
              <Field label="Reports">
                {(id) => <Textarea id={id} rows={2} value={reporting} onChange={(e) => setReporting(e.target.value)} maxLength={1000} />}
              </Field>
            </fieldset>
          </Section>

          <Section title="Tools" aside={<span className="text-[13px] text-ink-3">A tool needs its permission first</span>}>
            <ul className="divide-y divide-rule">
              {registry.tools.map((t) => {
                const on = tools.includes(t.name);
                const allowed = held.has(t.requires);
                return (
                  <li key={t.name} className="flex items-start gap-3 px-4 py-2.5">
                    <input
                      id={`tool-${t.name}`}
                      type="checkbox"
                      className="mt-1 size-4 accent-[var(--brand)]"
                      checked={on}
                      disabled={!isCeo || (!on && !allowed)}
                      onChange={() => setTools(on ? tools.filter((x) => x !== t.name) : [...tools, t.name])}
                    />
                    <label htmlFor={`tool-${t.name}`} className={cx('min-w-0 flex-1 text-sm', !on && !allowed && 'text-ink-3')}>
                      <span className="font-medium">{humanize(t.name)}</span>
                      <span className="block text-[13px] text-ink-3">
                        {t.description}. Needs {t.requires}. Built in phase {t.availableFromPhase}.
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Model">
            <fieldset disabled={!isCeo} className="space-y-4 px-4 py-4">
              <Field label="Model tier" hint={tierModel ? `Uses ${tierModel}` : 'No model is configured for this tier yet (see Settings).'}>
                {(id) => (
                  <Select id={id} value={modelTier} onChange={(e) => setModelTier(e.target.value as ModelTier)}>
                    <option value="ROUTINE">Routine: economical, for classification and drafting</option>
                    <option value="ADVANCED">Advanced: stronger, for planning and review</option>
                  </Select>
                )}
              </Field>
              <Field label="Model override" hint="Optional. A model ID your OpenAI project can use; leave blank to follow the tier.">
                {(id) => <Input id={id} value={modelOverride} onChange={(e) => setModelOverride(e.target.value)} maxLength={100} placeholder="Follow the tier" />}
              </Field>
              <Field label="Output token limit">
                {(id) => (
                  <Input id={id} type="number" min={100} max={32000} step={100} value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(Number(e.target.value) || 100)} />
                )}
              </Field>
            </fieldset>
          </Section>

          <Section title="Permissions">
            <ul className="divide-y divide-rule">
              {registry.permissions.map((p) => {
                const grant = perms.find((g) => g.permission === p.key);
                return (
                  <li key={p.key} className={cx('px-4 py-2.5 text-sm', !p.agentGrantable && 'bg-sunken')}>
                    <div className="flex items-start gap-3">
                      <input
                        id={`perm-${p.key}`}
                        type="checkbox"
                        className="mt-1 size-4 accent-[var(--brand)]"
                        checked={Boolean(grant)}
                        disabled={!isCeo || !p.agentGrantable || (Boolean(grant) && tools.some((t) => registry.tools.find((x) => x.name === t)?.requires === p.key))}
                        onChange={() => togglePerm(p.key)}
                      />
                      <label htmlFor={`perm-${p.key}`} className={cx('min-w-0 flex-1', !p.agentGrantable && 'text-ink-3')}>
                        <span className="font-medium">{p.key}</span>
                        <span className="block text-[13px] text-ink-3">
                          {p.description}
                          {!p.agentGrantable && '. People only, never AI.'}
                        </span>
                      </label>
                    </div>
                    {grant && (
                      <label className="ml-7 mt-1.5 flex items-center gap-2 text-[13px] text-ink-2">
                        {p.approvalLocked ? (
                          <>
                            <Lock className="size-3.5 text-st-waiting" aria-hidden />
                            Always needs your approval
                          </>
                        ) : (
                          <>
                            <input
                              type="checkbox"
                              className="size-3.5 accent-[var(--brand)]"
                              checked={grant.requiresApproval}
                              disabled={!isCeo}
                              onChange={() => setPerms(perms.map((g) => (g.permission === p.key ? { ...g, requiresApproval: !g.requiresApproval } : g)))}
                            />
                            Ask me before each use
                          </>
                        )}
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section title="Recent tasks">
            {agent.recentTasks?.length ? (
              <ul className="divide-y divide-rule">
                {agent.recentTasks.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-sunken">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{t.title}</span>
                        <span className="block text-[13px] text-ink-3">{timeAgo(t.createdAt)}</span>
                      </span>
                      <StatusBadge status={t.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-ink-3">No tasks assigned to this role yet.</p>
            )}
          </Section>
        </div>
      </div>

      {isCeo && (dirtyConfig || dirtyPerms || save.error) && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rule-strong bg-panel px-4 py-3 shadow-lg">
          <p className="text-sm text-ink-2">You have unsaved changes to this role.</p>
          <ErrorNote error={save.error} className="order-last w-full" />
          <div className="flex gap-2">
            <Button
              variant="quiet"
              onClick={() => {
                setRole(agent.role);
                setInstructions(agent.instructions);
                setReporting(agent.reportingResponsibilities);
                setModelTier(agent.modelTier);
                setModelOverride(agent.modelOverride ?? '');
                setMaxOutputTokens(agent.maxOutputTokens);
                setTools(agent.tools);
                setPerms(agent.permissions);
                save.reset();
              }}
            >
              Discard
            </Button>
            <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
              Save role
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const sortPerms = (p: AgentPermission[]) => [...p].sort((a, b) => a.permission.localeCompare(b.permission));
const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
