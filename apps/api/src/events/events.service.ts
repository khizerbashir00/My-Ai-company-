import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export type AppEvent =
  | { type: 'task.created'; taskId: string; status: string; parentTaskId: string | null }
  | { type: 'task.updated'; taskId: string; status: string; parentTaskId: string | null }
  | { type: 'agent.updated'; agentId: string }
  | { type: 'lead.created'; leadId: string }
  | { type: 'lead.updated'; leadId: string }
  | { type: 'source.scan.updated'; scanRunId: string; connectionId: string; status: string }
  | { type: 'approval.updated'; approvalId: string; status: string }
  | { type: 'notification.created'; notificationId: string; userId: string }
  | { type: 'message.created'; threadId: string; agentId: string };

/**
 * In-process event bus feeding the live SSE stream.
 * Events carry IDs only; clients refetch through authenticated, authorized endpoints.
 * Phase 4 (BullMQ workers in a separate process) will bridge this through Redis pub/sub.
 */
@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly subject = new Subject<AppEvent>();

  emit(event: AppEvent): void {
    this.subject.next(event);
  }

  stream(): Observable<AppEvent> {
    return this.subject.asObservable();
  }

  onModuleDestroy(): void {
    this.subject.complete();
  }
}
