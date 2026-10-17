import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Subscribes to the API's Server-Sent Events stream and refreshes affected queries.
 * Events only carry IDs, so the UI always refetches through the normal authorized endpoints.
 * Reconnects with backoff when the browser closes the EventSource.
 */
export function useLiveUpdates(enabled: boolean): LiveState {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const bind = (source: EventSource) => {
      source.onopen = () => {
        attemptRef.current = 0;
        setState('live');
      };
      source.onerror = () => {
        if (closed) return;
        setState(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
        if (source.readyState === EventSource.CLOSED) {
          source.close();
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(attemptRef.current, 5));
          attemptRef.current += 1;
          reconnectTimer = setTimeout(connect, delay);
        }
      };

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
      const onApproval = () => {
        void qc.invalidateQueries({ queryKey: ['approvals'] });
        void qc.invalidateQueries({ queryKey: ['metrics'] });
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void qc.invalidateQueries({ queryKey: ['notifications-unread'] });
      };
      const onNotification = () => {
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void qc.invalidateQueries({ queryKey: ['notifications-unread'] });
      };
      const onMessage = (e: MessageEvent<string>) => {
        const data = JSON.parse(e.data) as { threadId: string };
        void qc.invalidateQueries({ queryKey: ['messages'] });
        void qc.invalidateQueries({ queryKey: ['messages', 'thread', data.threadId] });
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void qc.invalidateQueries({ queryKey: ['notifications-unread'] });
      };
      source.addEventListener('task.created', onTask);
      source.addEventListener('task.updated', onTask);
      source.addEventListener('agent.updated', onAgent);
      source.addEventListener('lead.created', onLead);
      source.addEventListener('lead.updated', onLead);
      source.addEventListener('source.scan.updated', onScan);
      source.addEventListener('approval.updated', onApproval);
      source.addEventListener('notification.created', onNotification);
      source.addEventListener('message.created', onMessage);
      const onControl = () => {
        void qc.invalidateQueries({ queryKey: ['control-status'] });
      };
      const onSocial = () => {
        void qc.invalidateQueries({ queryKey: ['control-status'] });
        void qc.invalidateQueries({ queryKey: ['system-status'] });
      };
      source.addEventListener('control.updated', onControl);
      source.addEventListener('social.updated', onSocial);
      // Task and scan changes also move Control Center numbers.
      source.addEventListener('task.updated', onControl);
      source.addEventListener('task.created', onControl);
      source.addEventListener('source.scan.updated', onControl);
    };

    const connect = () => {
      if (closed) return;
      setState('connecting');
      es = new EventSource('/api/events/stream', { withCredentials: true });
      bind(es);
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [enabled, qc]);

  return state;
}
