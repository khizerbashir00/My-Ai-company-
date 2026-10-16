import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Subscribes to the API's Server-Sent Events stream and refreshes affected queries.
 * Events only carry IDs, so the UI always refetches through the normal authorized endpoints.
 */
export function useLiveUpdates(enabled: boolean): LiveState {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource('/api/events/stream', { withCredentials: true });
    es.onopen = () => setState('live');
    es.onerror = () => setState(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');

    const onTask = (e: MessageEvent<string>) => {
      const data = JSON.parse(e.data) as { taskId: string; parentTaskId: string | null };
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['task', data.taskId] });
      if (data.parentTaskId) void qc.invalidateQueries({ queryKey: ['task', data.parentTaskId] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
      void qc.invalidateQueries({ queryKey: ['org'] });
      void qc.invalidateQueries({ queryKey: ['departments'] });
    };
    const onAgent = (e: MessageEvent<string>) => {
      const data = JSON.parse(e.data) as { agentId: string };
      void qc.invalidateQueries({ queryKey: ['agent', data.agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['org'] });
    };
    const onLead = (e: MessageEvent<string>) => {
      const data = JSON.parse(e.data) as { leadId: string };
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['lead', data.leadId] });
      void qc.invalidateQueries({ queryKey: ['lead-briefing', data.leadId] });
      void qc.invalidateQueries({ queryKey: ['lead-pipeline'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
    };
    const onScan = () => {
      void qc.invalidateQueries({ queryKey: ['sources'] });
      void qc.invalidateQueries({ queryKey: ['source-scans'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
    };
    es.addEventListener('task.created', onTask);
    es.addEventListener('task.updated', onTask);
    es.addEventListener('agent.updated', onAgent);
    es.addEventListener('lead.created', onLead);
    es.addEventListener('lead.updated', onLead);
    es.addEventListener('source.scan.updated', onScan);
    const onApproval = () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    };
    const onNotification = () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    };
    es.addEventListener('approval.updated', onApproval);
    es.addEventListener('notification.created', onNotification);
    return () => es.close();
  }, [enabled, qc]);

  return state;
}
