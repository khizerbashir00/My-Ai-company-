import * as bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { AGENTS, DEPARTMENTS } from '../agents/agent-catalog';
import { PERMISSIONS } from '../agents/registry';
import { defaultHnConfig, HN_SOURCE_KEY } from '../connectors/hacker-news/hn.connector';

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

  // Only seed connectors that are actually implemented — never claim Reddit/LinkedIn/etc.
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
