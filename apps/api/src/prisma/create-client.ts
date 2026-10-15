import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** Postgres driver adapter for a DATABASE_URL, honouring its ?schema= parameter. */
export function createPgAdapter(databaseUrl: string): PrismaPg {
  const schema = new URL(databaseUrl).searchParams.get('schema') ?? undefined;
  return new PrismaPg({ connectionString: databaseUrl }, schema ? { schema } : undefined);
}

/** Standalone client for scripts (seed) and tests. The Nest app uses PrismaService. */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: createPgAdapter(databaseUrl) });
}
