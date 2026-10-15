import 'dotenv/config';
import { createPrismaClient } from '../src/prisma/create-client';
import { seedDatabase } from '../src/database/seed';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const email = process.env.CEO_EMAIL?.trim();
  const password = process.env.CEO_PASSWORD ?? '';
  const name = process.env.CEO_NAME?.trim() || 'CEO';
  if (!email) throw new Error('CEO_EMAIL is not set');
  if (password.length < 12) throw new Error('CEO_PASSWORD must be at least 12 characters');

  const prisma = createPrismaClient(url);
  try {
    const res = await seedDatabase(prisma, { ceo: { email, name, password } });
    console.log(`✔ Seeded ${res.departments} departments and ${res.agents} agent definitions.`);
    console.log(res.ceoCreated ? `✔ Created CEO account ${email}` : `• CEO account ${email} already exists (password unchanged)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`✖ Seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
