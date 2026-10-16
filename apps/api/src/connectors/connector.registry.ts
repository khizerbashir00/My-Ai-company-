import { Injectable } from '@nestjs/common';
import { HackerNewsConnector, HN_SOURCE_KEY } from './hacker-news/hn.connector';
import type { ConnectorDescriptor, LeadSourceConnector } from './connector.types';

/**
 * In-process registry of implemented connectors.
 * Only keys present here are considered "implemented". Others (Reddit, LinkedIn, …)
 * must NOT be claimed as connected until a connector exists and is tested.
 */
@Injectable()
export class ConnectorRegistry {
  private readonly byKey = new Map<string, LeadSourceConnector>();

  constructor() {
    const hn = new HackerNewsConnector();
    this.byKey.set(hn.descriptor.key, hn);
  }

  list(): ConnectorDescriptor[] {
    return [...this.byKey.values()].map((c) => c.descriptor);
  }

  get(key: string): LeadSourceConnector | undefined {
    return this.byKey.get(key);
  }

  require(key: string): LeadSourceConnector {
    const c = this.byKey.get(key);
    if (!c) throw new Error(`No connector implemented for source "${key}".`);
    return c;
  }

  get hnKey(): string {
    return HN_SOURCE_KEY;
  }
}
