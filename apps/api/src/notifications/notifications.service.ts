import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { NotificationType } from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string | null;
  /** Unique per (user, event). Duplicate inserts are ignored. */
  dedupeKey: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  async notify(input: NotifyInput): Promise<{ created: boolean; id: string | null }> {
    try {
      const row = await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title.slice(0, 200),
          body: (input.body ?? '').slice(0, 2000),
          link: input.link ?? null,
          dedupeKey: input.dedupeKey.slice(0, 200),
        },
      });
      this.events.emit({ type: 'notification.created', notificationId: row.id, userId: input.userId });
      return { created: true, id: row.id };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { created: false, id: null };
      }
      throw err;
    }
  }

  /** Notify every active CEO (and ADMIN if no CEO). Dedupes per user. */
  async notifyCeo(input: Omit<NotifyInput, 'userId'>): Promise<number> {
    const ceos = await this.prisma.user.findMany({
      where: { role: 'CEO', isActive: true },
      select: { id: true },
    });
    const targets = ceos.length
      ? ceos
      : await this.prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
    let created = 0;
    for (const u of targets) {
      const r = await this.notify({ ...input, userId: u.id });
      if (r.created) created += 1;
    }
    return created;
  }

  async unreadCount(userId: string) {
    const unread = await this.prisma.notification.count({ where: { userId, readAt: null } });
    return { unread };
  }

  async listForUser(userId: string, opts?: { unreadOnly?: boolean; page?: number; pageSize?: number }) {
    const page = Math.max(1, opts?.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 30));
    const where = { userId, ...(opts?.unreadOnly ? { readAt: null } : {}) };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async markRead(userId: string, id: string) {
    const row = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Notification not found');
    if (row.readAt) return row;
    return this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}
