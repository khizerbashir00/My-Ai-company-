import { Injectable, Logger } from '@nestjs/common';
import type { ActorType } from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../common/auth.decorators';

export interface AuditEntry {
  actorType: ActorType;
  actorUserId?: string | null;
  actorAgentId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
  ctx?: RequestContext;
}

const SECRET_KEYS = /pass(word)?|secret|token|api[_-]?key|authorization|cookie/i;

/** Append-only audit trail. Strips anything that looks like a secret before writing. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    try {
      await client.auditLog.create({
        data: {
          actorType: entry.actorType,
          actorUserId: entry.actorUserId ?? null,
          actorAgentId: entry.actorAgentId ?? null,
          action: entry.action,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          data: entry.data ? (redact(entry.data) as Prisma.InputJsonValue) : Prisma.JsonNull,
          ip: entry.ctx?.ip ?? null,
          userAgent: entry.ctx?.userAgent ?? null,
        },
      });
    } catch (err) {
      // Inside a transaction the caller must see the failure so the whole change rolls back.
      if (tx) throw err;
      this.logger.error(`Failed to write audit log for ${entry.action}`);
    }
  }
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : redact(v)]),
    );
  }
  return value;
}
