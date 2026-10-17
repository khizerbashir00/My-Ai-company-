import * as bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { AGENTS, DEPARTMENTS } from '../agents/agent-catalog';
import { PERMISSIONS } from '../agents/registry';
import { defaultHnConfig, HN_SOURCE_KEY } from '../connectors/hacker-news/hn.connector';
import { defaultRedditConfig, REDDIT_SOURCE_KEY } from '../connectors/reddit/reddit.connector';

export interface SeedOptions {
  ceo?: { email: string; name: string; password: string };
}

export interface SeedResult {
  departments: number;
  agents: number;
  ceoCreated: boolean;
}

export const BCRYPT_ROUNDS = 12;
export const MANUAL_IMPORT_SOURCE_KEY = 'manual_import';

/** CSV / export import only — no live scraping or fake “connected” scan. */
export const IMPORT_ONLY_SOURCES = [
  {
    key: 'linkedin',
    name: 'LinkedIn',
    platform: 'linkedin',
    description:
      'Import leads you export yourself (e.g. LinkedIn Sales Navigator or saved leads CSV). No live LinkedIn API scanning in this product.',
    complianceNotes:
      'Do not scrape LinkedIn. Only import contacts you are permitted to store and contact. Keep the original profile or post URL on every row.',
  },
  {
    key: 'facebook',
    name: 'Facebook / Meta',
    platform: 'facebook',
    description:
      'Import leads from Meta Ads lead exports or other CSV exports you already have. No Facebook group scraping or password login.',
    complianceNotes:
      'Use official Meta export tools only. No scraping of groups or personal profiles. Keep provenance URLs where available.',
  },
  {
    key: 'indeed',
    name: 'Indeed',
    platform: 'indeed',
    description:
      'Import job-seeker or employer contacts from CSV exports you collected under Indeed’s terms. No Indeed scraping.',
    complianceNotes:
      'Indeed Publisher / partner APIs are out of scope. Only import data you are allowed to retain and contact.',
  },
] as const;

/**
 * Idempotent seed. Creates missing records only — it never overwrites instructions,
 * permissions or passwords the CEO has changed in the app.
 */
export async function seedDatabase(prisma: PrismaClient, opts: SeedOptions = {}): Promise<SeedResult> {
  const deptIds = new Map<string, string>();
  for (const d of DEPARTMENTS) {
    const row = await prisma.department.upsert({
      where: { key: d.key },
      create: d,
      update: {},
    });
    deptIds.set(d.key, row.id);
  }

  // Parents are listed before children in the catalog, so one pass resolves the hierarchy.
  const agentIds = new Map<string, string>();
  for (const [index, a] of AGENTS.entries()) {
    const parentId = a.parent ? agentIds.get(a.parent) : undefined;
    if (a.parent && !parentId) throw new Error(`Agent catalog order error: parent ${a.parent} must precede ${a.key}`);
    const existing = await prisma.agentDefinition.findUnique({ where: { key: a.key } });
    const row =
      existing ??
      (await prisma.agentDefinition.create({
        data: {
          key: a.key,
          name: a.name,
          kind: a.kind,
          departmentId: a.department ? deptIds.get(a.department) : null,
          parentId: parentId ?? null,
          role: a.role,
          instructions: a.instructions,
          reportingResponsibilities: a.reportingResponsibilities,
          tools: a.tools,
          modelTier: a.modelTier,
          sortOrder: index,
          permissions: {
            create: a.permissions.map((p) => ({ permission: p, requiresApproval: PERMISSIONS[p].approvalLocked })),
          },
        },
      }));
    agentIds.set(a.key, row.id);
  }

  await prisma.source.upsert({
    where: { key: MANUAL_IMPORT_SOURCE_KEY },
    create: {
      key: MANUAL_IMPORT_SOURCE_KEY,
      name: 'Manual import',
      platform: 'manual',
      accessMethod: 'MANUAL_IMPORT',
      description: 'Leads you add by hand or import from a CSV you collected yourself. Fallback when remote connectors are unavailable.',
      complianceNotes: 'Only import contacts you are permitted to store and contact. Keep the original source URL for every lead.',
      capabilities: ['import'],
      scanIntervalMinutes: 0,
      isEnabled: true,
    },
    update: {},
  });

  // Live API connectors that are implemented in the registry.
  const hn = await prisma.source.upsert({
    where: { key: HN_SOURCE_KEY },
    create: {
      key: HN_SOURCE_KEY,
      name: 'Hacker News',
      platform: 'hacker_news',
      accessMethod: 'OFFICIAL_API',
      description:
        'Public Hacker News stories and Ask HN posts via the HN Search API (Algolia). No API key.',
      complianceNotes:
        'Uses https://hn.algolia.com/api only. No login, no CAPTCHA bypass, no scraping of protected pages. Stay within rate limits.',
      capabilities: ['search', 'pagination', 'public_posts'],
      scanIntervalMinutes: 360,
      isEnabled: true,
    },
    update: {},
  });
  const hnConnection = await prisma.sourceConnection.findUnique({
    where: { sourceId_label: { sourceId: hn.id, label: 'default' } },
  });
  if (!hnConnection) {
    const config = { ...defaultHnConfig(), maxResults: 40 };
    await prisma.sourceConnection.create({
      data: {
        sourceId: hn.id,
        label: 'default',
        status: 'CONFIGURED',
        config: config as Prisma.InputJsonValue,
      },
    });
  }

  const reddit = await prisma.source.upsert({
    where: { key: REDDIT_SOURCE_KEY },
    create: {
      key: REDDIT_SOURCE_KEY,
      name: 'Reddit',
      platform: 'reddit',
      accessMethod: 'OFFICIAL_API',
      description:
        'Public Reddit posts via the official OAuth API. Create a free app at reddit.com/prefs/apps and set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET.',
      complianceNotes:
        'OAuth API only. No scraping, no password login, no CAPTCHA bypass. Stay within Reddit rate limits.',
      capabilities: ['search', 'pagination', 'public_posts'],
      scanIntervalMinutes: 360,
      isEnabled: true,
    },
    update: {},
  });
  const redditConnection = await prisma.sourceConnection.findUnique({
    where: { sourceId_label: { sourceId: reddit.id, label: 'default' } },
  });
  if (!redditConnection) {
    await prisma.sourceConnection.create({
      data: {
        sourceId: reddit.id,
        label: 'default',
        status: 'CONFIGURED',
        config: defaultRedditConfig() as Prisma.InputJsonValue,
        credentialsEnv: 'REDDIT_CLIENT_ID',
      },
    });
  }

  // Honest import-only rows — not live scanners.
  for (const src of IMPORT_ONLY_SOURCES) {
    await prisma.source.upsert({
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

  await prisma.brandProfile.upsert({
    where: { key: 'default' },
    create: {
      key: 'default',
      voiceGuidelines: 'Clear, professional, specific. Never invent prices, results, or client logos.',
      servicesOffered: [],
      portfolioNotes: '',
      approvedClaims: [],
    },
    update: {},
  });

  await prisma.analyticsIntegration.upsert({
    where: { key: 'manual_import' },
    create: {
      key: 'manual_import',
      name: 'Manual metric import',
      isConfigured: true,
      notes: 'CSV/JSON imports entered by the CEO or Marketing Manager. Always available.',
    },
    update: {},
  });
  await prisma.analyticsIntegration.upsert({
    where: { key: 'google_analytics' },
    create: {
      key: 'google_analytics',
      name: 'Google Analytics',
      isConfigured: false,
      credentialsEnv: 'GA_CREDENTIALS_JSON',
      notes: 'Not connected until credentials env is set and a sync adapter is implemented.',
    },
    update: {},
  });

  let ceoCreated = false;
  if (opts.ceo) {
    const email = opts.ceo.email.trim().toLowerCase();
    const exists = await prisma.user.findUnique({ where: { email } });
    if (!exists) {
      await prisma.user.create({
        data: { email, name: opts.ceo.name, role: 'CEO', passwordHash: await bcrypt.hash(opts.ceo.password, BCRYPT_ROUNDS) },
      });
      ceoCreated = true;
    }
  }

  return { departments: deptIds.size, agents: agentIds.size, ceoCreated };
}
