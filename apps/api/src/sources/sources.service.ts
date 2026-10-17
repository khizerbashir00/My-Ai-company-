import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { ConnectionStatus } from '../generated/prisma/client';
import { AuthUser, RequestContext } from '../common/auth.decorators';
import { IMPORT_ONLY_SOURCES, MANUAL_IMPORT_SOURCE_KEY } from '../database/seed';
import { ConnectorRegistry } from '../connectors/connector.registry';
import { defaultHnConfig, HN_SOURCE_KEY } from '../connectors/hacker-news/hn.connector';
import { defaultRedditConfig, REDDIT_SOURCE_KEY } from '../connectors/reddit/reddit.connector';
import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScanQueueService } from './scan-queue.service';
import { ScanService } from './scan.service';
import type { ListScanRunsQueryDto, ManualImportLeadDto, UpdateConnectionDto } from './sources.dto';

/** Operator-facing status — never claim a platform is connected without an implemented connector. */
export type ConnectorDisplayStatus =
  | 'MANUAL_FALLBACK'
  | 'UNIMPLEMENTED'
  | 'UNCONFIGURED'
  | 'UNAUTHORIZED'
  | 'UNAVAILABLE'
  | 'DISABLED'
  | 'ERROR'
  | 'CONFIGURED'
  | 'WORKING';

@Injectable()
export class SourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorRegistry,
    private readonly scan: ScanService,
    private readonly queue: ScanQueueService,
    private readonly leads: LeadsService,
  ) {}

  async list() {
    const sources = await this.prisma.source.findMany({
      orderBy: { name: 'asc' },
      include: {
        connections: {
          orderBy: { createdAt: 'asc' },
          include: {
            scanRuns: {
              where: { status: 'SUCCEEDED' },
              orderBy: { finishedAt: 'desc' },
              take: 1,
              select: { id: true, finishedAt: true, itemsCreated: true, itemsFound: true },
            },
          },
        },
      },
    });

    return {
      jobsMode: this.queue.jobsMode,
      redisConfigured: this.queue.redisConfigured,
      implementedConnectors: this.connectors.list(),
      items: sources.map((s) => this.toSourceView(s)),
    };
  }

  async get(id: string) {
    const source = await this.prisma.source.findUnique({
      where: { id },
      include: {
        connections: {
          orderBy: { createdAt: 'asc' },
          include: {
            scanRuns: {
              where: { status: 'SUCCEEDED' },
              orderBy: { finishedAt: 'desc' },
              take: 1,
              select: { id: true, finishedAt: true, itemsCreated: true, itemsFound: true },
            },
          },
        },
      },
    });
    if (!source) throw new NotFoundException('Source not found');
    return this.toSourceView(source);
  }

  async updateConnection(connectionId: string, dto: UpdateConnectionDto) {
    const connection = await this.prisma.sourceConnection.findUnique({
      where: { id: connectionId },
      include: { source: true },
    });
    if (!connection) throw new NotFoundException('Connection not found');
    if (connection.source.key === MANUAL_IMPORT_SOURCE_KEY) {
      throw new BadRequestException('Manual import has no remote connection to configure.');
    }

    const connector = this.connectors.get(connection.source.key);
    const nextConfig = dto.config !== undefined ? dto.config : ((connection.config as Record<string, unknown> | null) ?? {});
    if (connector && dto.config !== undefined) {
      const errors = connector.validateConfig(nextConfig);
      if (errors.length) throw new BadRequestException(errors.join(' '));
    }

    let status: ConnectionStatus = connection.status;
    if (dto.enabled === false) status = 'DISABLED';
    else if (connector) {
      if (!connector.isAuthorized(process.env)) status = 'UNCONFIGURED';
      else if (connector.validateConfig(nextConfig).length) status = 'UNCONFIGURED';
      else if (connection.status === 'DISABLED' || connection.status === 'UNCONFIGURED' || connection.status === 'ERROR') {
        status = 'CONFIGURED';
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.scanIntervalMinutes !== undefined) {
        await tx.source.update({
          where: { id: connection.sourceId },
          data: { scanIntervalMinutes: dto.scanIntervalMinutes },
        });
      }
      if (dto.enabled !== undefined) {
        await tx.source.update({
          where: { id: connection.sourceId },
          data: { isEnabled: dto.enabled },
        });
      }
      return tx.sourceConnection.update({
        where: { id: connectionId },
        data: {
          ...(dto.label !== undefined ? { label: dto.label.trim() || 'default' } : {}),
          ...(dto.config !== undefined ? { config: nextConfig as Prisma.InputJsonValue } : {}),
          status,
          lastError: status === 'CONFIGURED' || status === 'CONNECTED' ? null : connection.lastError,
          credentialsEnv: connector?.descriptor.credentialsEnv ?? null,
        },
        include: { source: true },
      });
    });

    return this.get(updated.sourceId);
  }

  async startScan(connectionId: string) {
    const runId = await this.scan.createRun(connectionId, 'MANUAL');
    const enqueued = await this.queue.enqueue(runId);
    const run = await this.prisma.sourceScanRun.findUniqueOrThrow({ where: { id: runId } });
    return {
      scanRunId: run.id,
      status: run.status,
      trigger: run.trigger,
      jobsMode: enqueued.mode,
      bullJobId: enqueued.bullJobId,
    };
  }

  /** Agent tool path: enqueue a scan for an implemented, authorized, configured source. */
  async searchViaTool(args: { sourceKey?: string; maxResults?: number }) {
    const key = (args.sourceKey?.trim() || HN_SOURCE_KEY).toLowerCase();
    if (key === MANUAL_IMPORT_SOURCE_KEY) {
      throw new BadRequestException('Manual import is not a searchable connector. Use CSV or New lead.');
    }
    const connector = this.connectors.get(key);
    if (!connector) {
      throw new BadRequestException(
        `No connector implemented for "${key}". Implemented: ${this.connectors.list().map((c) => c.key).join(', ') || '(none)'}.`,
      );
    }
    if (!connector.isAuthorized(process.env)) {
      throw new BadRequestException(`Connector "${key}" is unauthorized. Set ${connector.descriptor.credentialsEnv}.`);
    }

    const source = await this.prisma.source.findUnique({
      where: { key },
      include: { connections: { orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    if (!source?.isEnabled) throw new BadRequestException(`Source "${key}" is disabled or not seeded.`);
    const connection = source.connections[0];
    if (!connection || connection.status === 'DISABLED') {
      throw new BadRequestException(`No active connection for "${key}". Configure it under Sources.`);
    }

    if (args.maxResults != null && Number.isFinite(args.maxResults)) {
      const config = { ...((connection.config as Record<string, unknown> | null) ?? {}), maxResults: Math.min(Math.max(1, Number(args.maxResults)), 200) };
      const errors = connector.validateConfig(config);
      if (errors.length) throw new BadRequestException(errors.join(' '));
      await this.prisma.sourceConnection.update({
        where: { id: connection.id },
        data: { config: config as Prisma.InputJsonValue, status: connection.status === 'UNCONFIGURED' ? 'CONFIGURED' : connection.status },
      });
    }

    const runId = await this.scan.createRun(connection.id, 'AGENT');
    const enqueued = await this.queue.enqueue(runId);
    return {
      scanRunId: runId,
      sourceKey: key,
      status: 'QUEUED',
      jobsMode: enqueued.mode,
      message: 'Scan queued. New leads are ingested with source URL + external id idempotency and handed to qualification.',
    };
  }

  async listScanRuns(q: ListScanRunsQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const where: Prisma.SourceScanRunWhereInput = q.connectionId ? { connectionId: q.connectionId } : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.sourceScanRun.count({ where }),
      this.prisma.sourceScanRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          connection: {
            select: {
              id: true,
              label: true,
              source: { select: { id: true, key: true, name: true } },
            },
          },
        },
      }),
    ]);

    return {
      items: items.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        bullJobId: r.bullJobId,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs:
          r.startedAt && r.finishedAt ? Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime()) : null,
        itemsFound: r.itemsFound,
        itemsCreated: r.itemsCreated,
        itemsDeduped: r.itemsDeduped,
        itemsSkipped: r.itemsSkipped,
        errorMessage: r.errorMessage,
        meta: r.meta,
        createdAt: r.createdAt,
        connection: r.connection,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      summary: await this.scanHistorySummary(q.connectionId),
    };
  }

  async getScanRun(id: string) {
    const r = await this.prisma.sourceScanRun.findUnique({
      where: { id },
      include: {
        connection: {
          select: { id: true, label: true, source: { select: { id: true, key: true, name: true } } },
        },
      },
    });
    if (!r) throw new NotFoundException('Scan run not found');
    return {
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      bullJobId: r.bullJobId,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.startedAt && r.finishedAt ? Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime()) : null,
      itemsFound: r.itemsFound,
      itemsCreated: r.itemsCreated,
      itemsDeduped: r.itemsDeduped,
      itemsSkipped: r.itemsSkipped,
      errorMessage: r.errorMessage,
      meta: r.meta,
      createdAt: r.createdAt,
      connection: r.connection,
    };
  }

  /** Manual import fallback when integrations are unavailable — always uses manual_import source. */
  async manualImport(dto: ManualImportLeadDto, user: AuthUser, ctx: RequestContext) {
    return this.leads.create(
      {
        name: dto.name,
        contactName: dto.contactName,
        contactEmail: dto.contactEmail,
        contactUrl: dto.contactUrl,
        websiteUrl: dto.websiteUrl,
        requirements: dto.requirements,
        requestedSkills: dto.requestedSkills,
        budgetText: dto.budgetText,
        notes: dto.notes ? `${dto.notes}\n[Manual import fallback]` : '[Manual import fallback]',
        sourceUrl: dto.sourceUrl,
        externalId: dto.externalId,
        postDate: dto.postDate,
      },
      user,
      ctx,
    );
  }

  /** Ensure implemented connectors + import-only sources exist (idempotent). Called from seed and boot. */
  async ensureDefaultConnections(): Promise<void> {
    for (const connector of this.connectors.list().map((d) => this.connectors.get(d.key)!)) {
      const key = connector.descriptor.key;
      const defaultConfig =
        key === HN_SOURCE_KEY
          ? { ...defaultHnConfig(), maxResults: connector.descriptor.defaultMaxResults }
          : key === REDDIT_SOURCE_KEY
            ? defaultRedditConfig()
            : { maxResults: connector.descriptor.defaultMaxResults };

      const source = await this.prisma.source.upsert({
        where: { key },
        create: {
          key,
          name: connector.descriptor.name,
          platform: connector.descriptor.platform,
          accessMethod: connector.descriptor.accessMethod,
          description: connector.descriptor.description,
          complianceNotes: connector.descriptor.complianceNotes,
          capabilities: connector.descriptor.capabilities,
          scanIntervalMinutes: connector.descriptor.defaultScanIntervalMinutes,
          isEnabled: true,
        },
        update: {
          description: connector.descriptor.description,
          complianceNotes: connector.descriptor.complianceNotes,
          capabilities: connector.descriptor.capabilities,
        },
      });

      const existing = await this.prisma.sourceConnection.findUnique({
        where: { sourceId_label: { sourceId: source.id, label: 'default' } },
      });
      if (!existing) {
        await this.prisma.sourceConnection.create({
          data: {
            sourceId: source.id,
            label: 'default',
            status: 'CONFIGURED',
            config: defaultConfig as Prisma.InputJsonValue,
            credentialsEnv: connector.descriptor.credentialsEnv,
          },
        });
      }
    }

    for (const src of IMPORT_ONLY_SOURCES) {
      await this.prisma.source.upsert({
        where: { key: src.key },
        create: {
          key: src.key,
          name: src.name,
          platform: src.platform,
          accessMethod: 'MANUAL_IMPORT',
          description: src.description,
          complianceNotes: src.complianceNotes,
          capabilities: ['import'],
          scanIntervalMinutes: 0,
          isEnabled: true,
        },
        update: {
          description: src.description,
          complianceNotes: src.complianceNotes,
          capabilities: ['import'],
          accessMethod: 'MANUAL_IMPORT',
          isEnabled: true,
        },
      });
    }
  }

  private async scanHistorySummary(connectionId?: string) {
    const where: Prisma.SourceScanRunWhereInput = connectionId ? { connectionId } : {};
    const [failed, succeeded, lastSuccess] = await Promise.all([
      this.prisma.sourceScanRun.count({ where: { ...where, status: 'FAILED' } }),
      this.prisma.sourceScanRun.count({ where: { ...where, status: 'SUCCEEDED' } }),
      this.prisma.sourceScanRun.findFirst({
        where: { ...where, status: 'SUCCEEDED' },
        orderBy: { finishedAt: 'desc' },
        select: { id: true, finishedAt: true, itemsCreated: true, connectionId: true },
      }),
    ]);
    return { failed, succeeded, lastSuccessfulRun: lastSuccess };
  }

  private toSourceView(
    s: {
      id: string;
      key: string;
      name: string;
      platform: string;
      accessMethod: string;
      description: string;
      complianceNotes: string;
      capabilities: string[];
      scanIntervalMinutes: number;
      isEnabled: boolean;
      connections: Array<{
        id: string;
        label: string;
        status: ConnectionStatus;
        config: unknown;
        credentialsEnv: string | null;
        cursor: string | null;
        lastSyncAt: Date | null;
        lastSuccessAt: Date | null;
        lastError: string | null;
        scanRuns: Array<{ id: string; finishedAt: Date | null; itemsCreated: number; itemsFound: number }>;
      }>;
    },
  ) {
    const connector = this.connectors.get(s.key);
    const isManual = s.key === MANUAL_IMPORT_SOURCE_KEY || s.accessMethod === 'MANUAL_IMPORT';
    const connection = s.connections[0] ?? null;
    const config = (connection?.config as Record<string, unknown> | null) ?? {};
    const configErrors = connector ? connector.validateConfig(config) : [];
    const authorized = connector ? connector.isAuthorized(process.env) : false;
    const displayStatus = this.displayStatus({
      isManual,
      implemented: Boolean(connector),
      authorized,
      configOk: configErrors.length === 0,
      isEnabled: s.isEnabled,
      connectionStatus: connection?.status ?? null,
    });

    return {
      id: s.id,
      key: s.key,
      name: s.name,
      platform: s.platform,
      accessMethod: s.accessMethod,
      description: s.description,
      complianceNotes: s.complianceNotes,
      capabilities: s.capabilities,
      scanIntervalMinutes: s.scanIntervalMinutes,
      isEnabled: s.isEnabled,
      displayStatus,
      implemented: Boolean(connector) || isManual,
      authorized,
      configErrors,
      connector: connector
        ? {
            documentationUrl: connector.descriptor.documentationUrl,
            credentialsEnv: connector.descriptor.credentialsEnv,
            requiredConfigKeys: connector.descriptor.requiredConfigKeys,
            defaultMaxResults: connector.descriptor.defaultMaxResults,
            defaultScanIntervalMinutes: connector.descriptor.defaultScanIntervalMinutes,
          }
        : null,
      connection: connection
        ? {
            id: connection.id,
            label: connection.label,
            status: connection.status,
            config: connection.config,
            credentialsEnv: connection.credentialsEnv,
            lastSyncAt: connection.lastSyncAt,
            lastSuccessAt: connection.lastSuccessAt,
            lastError: connection.lastError,
            lastSuccessfulRun: connection.scanRuns[0] ?? null,
          }
        : null,
      permissions: {
        canScan: displayStatus === 'WORKING' || displayStatus === 'CONFIGURED' || displayStatus === 'ERROR',
        canConfigure: Boolean(connector) && !isManual,
        manualImportFallback: true,
      },
    };
  }

  private displayStatus(input: {
    isManual: boolean;
    implemented: boolean;
    authorized: boolean;
    configOk: boolean;
    isEnabled: boolean;
    connectionStatus: ConnectionStatus | null;
  }): ConnectorDisplayStatus {
    if (input.isManual) return 'MANUAL_FALLBACK';
    if (!input.implemented) return 'UNIMPLEMENTED';
    if (!input.isEnabled || input.connectionStatus === 'DISABLED') return 'DISABLED';
    if (!input.authorized) return 'UNAUTHORIZED';
    if (!input.configOk || input.connectionStatus === 'UNCONFIGURED' || !input.connectionStatus) return 'UNCONFIGURED';
    if (input.connectionStatus === 'ERROR') return 'ERROR';
    if (input.connectionStatus === 'CONNECTED') return 'WORKING';
    if (input.connectionStatus === 'CONFIGURED') return 'CONFIGURED';
    return 'UNAVAILABLE';
  }
}
