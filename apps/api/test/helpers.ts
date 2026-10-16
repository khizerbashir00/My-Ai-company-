import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AI_PROVIDER } from '../src/ai/ai.types';
import { FakeAiProvider } from '../src/ai/fake-ai.provider';
import { seedDatabase } from '../src/database/seed';
import { PrismaService } from '../src/prisma/prisma.service';

export const CEO = { email: 'ceo@example.test', password: 'correct-horse-battery-staple', name: 'Test CEO' };
export const VIEWER = { email: 'viewer@example.test', password: 'viewer-password-123', name: 'Test Viewer' };

export async function createTestApp(opts?: {
  fakeAi?: FakeAiProvider;
}): Promise<{ app: INestApplication; prisma: PrismaService; fakeAi?: FakeAiProvider }> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (opts?.fakeAi) {
    builder.overrideProvider(AI_PROVIDER).useValue(opts.fakeAi);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService), fakeAi: opts?.fakeAi };
}

/** Empties every application table, then seeds the default org plus a CEO and a read-only viewer. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await seedDatabase(prisma, { ceo: CEO });
  await prisma.user.create({
    data: { email: VIEWER.email, name: VIEWER.name, role: 'VIEWER', passwordHash: await bcrypt.hash(VIEWER.password, 4) },
  });
}

let ipCounter = 0;
/** A distinct fake client IP per call (see TRUST_PROXY in setup-env). */
export const nextClientIp = () => `10.99.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

/** Logs in and returns a supertest agent that carries the session cookie. */
export async function loginAgent(app: INestApplication, creds: { email: string; password: string }) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/auth/login').set('X-Forwarded-For', nextClientIp()).send({ email: creds.email, password: creds.password }).expect(200);
  return agent;
}

export async function agentIdByKey(prisma: PrismaService, key: string): Promise<string> {
  return (await prisma.agentDefinition.findUniqueOrThrow({ where: { key }, select: { id: true } })).id;
}
