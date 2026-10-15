import { Controller, MessageEvent, Sse } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { interval, map, merge, Observable } from 'rxjs';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** Server-Sent Events stream for live dashboard updates. Authenticated via the session cookie. */
  @SkipThrottle()
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    const heartbeat = interval(25_000).pipe(map((): MessageEvent => ({ type: 'heartbeat', data: { at: new Date().toISOString() } })));
    const appEvents = this.events.stream().pipe(map((e): MessageEvent => ({ type: e.type, data: e })));
    return merge(appEvents, heartbeat);
  }
}
