import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type ScanTrigger } from '../generated/prisma/client';
import { ConnectorRegistry } from '../connectors/connector.registry';
import { ConnectorHttpError } from '../connectors/http-client';
import { EventsService } from '../events/events.service';
import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';

const SCAN_TIMEOUT_MS = 120_000;

@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorRegistry,
    private readonly leads: LeadsService,
    private readonly tasks: TasksService,
    private readonly events: EventsService,
  ) {}

  /** Create a QUEUED scan run row (caller may then enqueue BullMQ or execute inline). */
  async createRun(connectionId: string, trigger: ScanTrigger): Promise<string> {
    const connection = await this.prisma.sourceConnection.findUnique({
      where: { id: connectionId },
      include: { source: true },
    });
    if (!connection) throw new NotFoundException('Source connection not found');
    if (!connection.source.isEnabled) throw new BadRequestException('Source is disabled.');
    if (connection.status === 'DISABLED') throw new BadRequestException('Connection is disabled.');

    const connector = this.connectors.get(connection.source.key);
    if (!connector) {
      throw new BadRequestException(
        `No connector is implemented for "${connection.source.key}". Use Manual import, or wait until that integration ships.`,
      );
    }
    if (!connector.isAuthorized(process.env)) {
      throw new BadRequestException(
        `Connector "${connection.source.key}" is unauthorized. Set ${connector.descriptor.credentialsEnv ?? 'required credentials'} on the server.`,
      );
    }
    const config = (connection.config as Record<string, unknown> | null) ?? {};
    const configErrors = connector.validateConfig(config);
    if (configErrors.length) {
      throw new BadRequestException(`Connection is not configured: ${configErrors.join(' ')}`);
    }

    const run = await this.prisma.sourceScanRun.create({
      data: { connectionId, status: 'QUEUED', trigger },
    });
    this.events.emit({ type: 'source.scan.updated', scanRunId: run.id, connectionId, status: 'QUEUED' });
    return run.id;
  }

  /** Execute a scan run end-to-end (used by BullMQ worker and tests). */
  async executeRun(scanRunId: string): Promise<void> {
    const run = await this.prisma.sourceScanRun.findUnique({
      where: { id: scanRunId },
      include: { connection: { include: { source: true } } },
    });
    if (!run) throw new NotFoundException('Scan run not found');
    if (run.status === 'SUCCEEDED' || run.status === 'RUNNING') return;
    if (run.status === 'CANCELLED') return;

    const connector = this.connectors.require(run.connection.source.key);
    const config = (run.connection.config as Record<string, unknown> | null) ?? {};
    const maxResults = Number(config.maxResults) > 0 ? Math.min(Number(config.maxResults), 200) : connector.descriptor.defaultMaxResults;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

    await this.prisma.sourceScanRun.update({
      where: { id: scanRunId },
      data: { status: 'RUNNING', startedAt: new Date(), errorMessage: null },
    });
    await this.prisma.sourceConnection.update({
      where: { id: run.connectionId },
      data: { lastSyncAt: new Date(), lastError: null },
    });
    this.events.emit({ type: 'source.scan.updated', scanRunId, connectionId: run.connectionId, status: 'RUNNING' });

    let itemsFound = 0;
    let itemsCreated = 0;
    let itemsDeduped = 0;
    let itemsSkipped = 0;
    let pages = 0;
    let cursor: string | null = run.connection.cursor;
    const createdLeadIds: string[] = [];

    try {
      while (itemsFound < maxResults) {
        const page = await connector.fetchPage({
          config,
          cursor,
          maxResults: maxResults - itemsFound,
          signal: controller.signal,
        });
        pages += 1;
        cursor = page.nextCursor;

        for (const item of page.items) {
          itemsFound += 1;
          try {
            const result = await this.leads.ingestFromConnector(
              {
                name: item.name,
                contactName: item.contactName ?? undefined,
                contactEmail: item.contactEmail ?? undefined,
                contactUrl: item.contactUrl ?? undefined,
                websiteUrl: item.websiteUrl ?? undefined,
                requirements: item.requirements,
                requestedSkills: item.requestedSkills,
                budgetText: item.budgetText ?? undefined,
                notes: item.notes,
                sourceUrl: item.sourceUrl,
                externalId: item.externalId,
                postDate: item.postDate?.toISOString(),
                discoveredAt: item.discoveredAt.toISOString(),
                sourceId: run.connection.sourceId,
                stage: 'NEW',
              },
              item.rawSnapshot ?? null,
            );
            if (result.duplicate) itemsDeduped += 1;
            else {
              itemsCreated += 1;
              createdLeadIds.push(result.leadId);
            }
          } catch (err) {
            itemsSkipped += 1;
            this.logger.warn(`Skip candidate ${item.externalId}: ${err instanceof Error ? err.message : 'error'}`);
          }
          if (itemsFound >= maxResults) break;
        }

        if (!cursor || page.items.length === 0) break;
        // Pace requests to stay well under public API rate limits.
        await delay(350, controller.signal);
      }

      await this.prisma.$transaction([
        this.prisma.sourceScanRun.update({
          where: { id: scanRunId },
          data: {
            status: 'SUCCEEDED',
            finishedAt: new Date(),
            itemsFound,
            itemsCreated,
            itemsDeduped,
            itemsSkipped,
            meta: { pages, maxResults, query: config.query ?? null } as Prisma.InputJsonValue,
          },
        }),
        this.prisma.sourceConnection.update({
          where: { id: run.connectionId },
          data: {
            status: 'CONNECTED',
            lastSuccessAt: new Date(),
            lastSyncAt: new Date(),
            lastError: null,
            cursor: cursor,
          },
        }),
      ]);
      this.events.emit({ type: 'source.scan.updated', scanRunId, connectionId: run.connectionId, status: 'SUCCEEDED' });

      for (const leadId of createdLeadIds) {
        await this.enqueueQualification(leadId).catch((err) =>
          this.logger.warn(`Qualification handoff failed for ${leadId}: ${err instanceof Error ? err.message : 'error'}`),
        );
      }
    } catch (err) {
      const message = publicScanError(err);
      await this.prisma.$transaction([
        this.prisma.sourceScanRun.update({
          where: { id: scanRunId },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            itemsFound,
            itemsCreated,
            itemsDeduped,
            itemsSkipped,
            errorMessage: message,
            meta: { pages, maxResults } as Prisma.InputJsonValue,
          },
        }),
        this.prisma.sourceConnection.update({
          where: { id: run.connectionId },
          data: { status: 'ERROR', lastSyncAt: new Date(), lastError: message },
        }),
      ]);
      this.events.emit({ type: 'source.scan.updated', scanRunId, connectionId: run.connectionId, status: 'FAILED' });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Create a qualification worker task for a newly discovered lead (idempotent). */
  private async enqueueQualification(leadId: string): Promise<void> {
    const worker = await this.prisma.agentDefinition.findUnique({
      where: { key: 'lead_qualification_worker' },
      select: { id: true, isEnabled: true },
    });
    if (!worker?.isEnabled) return;

    const ceo = await this.prisma.user.findFirst({ where: { role: 'CEO', isActive: true }, select: { id: true } });
    if (!ceo) return;

    await this.tasks.createAs(
      {
        title: `Qualify lead ${leadId.slice(0, 8)}`,
        description: 'Score this newly discovered lead using the documented rubric. Do not invent missing facts.',
        assignedAgentId: worker.id,
        idempotencyKey: `qualify-lead:${leadId}`,
        input: { leadId, reason: 'connector_scan' },
        priority: 'NORMAL',
      },
      { type: 'SYSTEM', createdByUserId: ceo.id },
    );
  }
}

function publicScanError(err: unknown): string {
  if (err instanceof ConnectorHttpError) return err.message.slice(0, 2000);
  if (err instanceof BadRequestException) {
    const r = err.getResponse();
    if (typeof r === 'string') return r;
    if (typeof r === 'object' && r && 'message' in r) {
      const m = (r as { message: string | string[] }).message;
      return (Array.isArray(m) ? m.join('; ') : String(m)).slice(0, 2000);
    }
  }
  if (err instanceof Error && err.name === 'AbortError') return 'Scan timed out or was cancelled.';
  return 'Scan failed.';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ConnectorHttpError('aborted', undefined, false));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new ConnectorHttpError('aborted', undefined, false));
      },
      { once: true },
    );
  });
}
