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
    es.addEventListener('task.created', onTask);
    es.addEventListener('task.updated', onTask);
    es.addEventListener('agent.updated', onAgent);
    return () => es.close();
  }, [enabled, qc]);

  return state;
}
