import * as bcrypt from 'bcryptjs';
import type { PrismaClient } from '../generated/prisma/client';
import { AGENTS, DEPARTMENTS } from '../agents/agent-catalog';
import { PERMISSIONS } from '../agents/registry';

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
      description: 'Leads you add by hand or import from a CSV you collected yourself.',
      complianceNotes: 'Only import contacts you are permitted to store and contact. Keep the original source URL for every lead.',
      capabilities: ['import'],
      scanIntervalMinutes: 0,
      isEnabled: true,
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
