#!/usr/bin/env node
// Binary-free migrations using Prisma's official WASM schema engine (@prisma/schema-engine-wasm)
// through the same @prisma/adapter-pg driver adapter the app uses at runtime.
//
// Why: `prisma migrate` downloads a native schema-engine binary from binaries.prisma.sh.
// Networks that block that host (locked-down CI, some corporate proxies) can use this instead.
// It reads/writes the standard prisma/migrations folder and _prisma_migrations table, so it is
// interchangeable with `prisma migrate deploy` / `prisma migrate dev`.
//
// Usage (run with: node --experimental-wasm-modules scripts/prisma-wasm.mjs <command>):
//   create <name>   Diff migrations folder → schema.prisma and write a new migration (no DB changes)
//   deploy          Apply pending migrations to DATABASE_URL
//   reset           Drop everything in DATABASE_URL's schema, then deploy (refuses when NODE_ENV=production)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { SchemaEngine } from '@prisma/schema-engine-wasm';
import { PrismaPg } from '@prisma/adapter-pg';
import { bindMigrationAwareSqlAdapterFactory } from '@prisma/driver-adapter-utils';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

async function adminQuery(config, sql) {
  const client = new pg.Client(config);
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const schemaPath = path.join(root, 'prisma', 'schema.prisma');
const migrationsDir = path.join(root, 'prisma', 'migrations');
const filters = { externalTables: [], externalEnums: [] };
// schema.prisma as of the latest migration created by this script (committed to Git)
const snapshotPath = path.join(root, 'prisma', 'migrations-schema.snapshot.prisma');

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function loadMigrations() {
  fs.mkdirSync(migrationsDir, { recursive: true });
  const lockPath = path.join(migrationsDir, 'migration_lock.toml');
  const dirs = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return {
    baseDir: migrationsDir,
    lockfile: {
      path: 'migration_lock.toml',
      content: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null,
    },
    shadowDbInitScript: '',
    migrationDirectories: dirs.map((name) => {
      const file = path.join(migrationsDir, name, 'migration.sql');
      return {
        path: name,
        migrationFile: {
          path: 'migration.sql',
          content: fs.existsSync(file) ? { tag: 'ok', value: fs.readFileSync(file, 'utf8') } : { tag: 'error', value: 'missing migration.sql' },
        },
      };
    }),
  };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

async function main() {
  const [command, name] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  // Discrete fields (not connectionString) so the adapter's temporary shadow database name takes effect.
  const u = new URL(url);
  const pgConfig = {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
  const pgSchema = u.searchParams.get('schema') ?? undefined;
  const pgOptions = pgSchema ? { schema: pgSchema } : undefined;
  const base = new PrismaPg(pgConfig, pgOptions);
  // The stock shadow-DB helper drops the database before closing its pool; manage the lifecycle here instead.
  base.connectToShadowDb = async () => {
    const shadowName = `prisma_shadow_${randomUUID().replace(/-/g, '')}`;
    await adminQuery(pgConfig, `CREATE DATABASE "${shadowName}"`);
    const shadow = await new PrismaPg({ ...pgConfig, database: shadowName }, pgOptions).connect();
    const dispose = shadow.dispose.bind(shadow);
    shadow.dispose = async () => {
      await dispose();
      await adminQuery(pgConfig, `DROP DATABASE IF EXISTS "${shadowName}" WITH (FORCE)`);
    };
    return shadow;
  };
  const factory = bindMigrationAwareSqlAdapterFactory(base);
  const engine = await SchemaEngine.new({ datamodels: [['schema.prisma', schema]] }, () => {}, factory);

  switch (command) {
    case 'create': {
      if (!name || !/^[a-z0-9_]+$/.test(name)) fail('Provide a migration name using lowercase letters, digits and underscores');
      // Diff schema-to-schema against the snapshot written with the previous migration. This avoids
      // introspecting a live database (the adapter cannot decode some pg_catalog column types).
      const migrations = loadMigrations();
      const hasSnapshot = fs.existsSync(snapshotPath);
      if (migrations.migrationDirectories.length && !hasSnapshot) {
        fail(`Migrations exist but ${path.relative(root, snapshotPath)} is missing. Use \`prisma migrate dev\` instead.`);
      }
      const from = hasSnapshot
        ? { tag: 'schemaDatamodel', files: [{ path: 'schema.prisma', content: fs.readFileSync(snapshotPath, 'utf8') }] }
        : { tag: 'empty' };
      const res = await engine.diff({
        from,
        to: { tag: 'schemaDatamodel', files: [{ path: 'schema.prisma', content: schema }] },
        script: true,
        exitCode: null,
        filters,
      });
      const sql = (res.stdout ?? '').trim();
      if (!sql || /^-- This is an empty migration\.?$/.test(sql)) {
        console.log('✔ Schema and migrations are in sync — nothing to create.');
        break;
      }
      const dir = path.join(migrationsDir, `${timestamp()}_${name}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'migration.sql'), sql + '\n');
      const lock = path.join(migrationsDir, 'migration_lock.toml');
      if (!fs.existsSync(lock)) {
        fs.writeFileSync(lock, '# Please do not edit this file manually\n# It should be added in your version-control system (e.g., Git)\nprovider = "postgresql"\n');
      }
      fs.writeFileSync(snapshotPath, schema);
      console.log(`✔ Created ${path.relative(root, dir)}/migration.sql`);
      break;
    }
    case 'deploy': {
      const out = await engine.applyMigrations({ migrationsList: loadMigrations(), filters });
      console.log(out.appliedMigrationNames.length ? `✔ Applied: ${out.appliedMigrationNames.join(', ')}` : '✔ Database already up to date.');
      break;
    }
    case 'reset': {
      if (process.env.NODE_ENV === 'production') fail('Refusing to reset a production database');
      await engine.reset({ filter: filters });
      const out = await engine.applyMigrations({ migrationsList: loadMigrations(), filters });
      console.log(`✔ Reset and applied: ${out.appliedMigrationNames.join(', ') || '(none)'}`);
      break;
    }
    default:
      fail('Unknown command. Use: create <name> | deploy | reset');
  }
  engine.free?.();
  process.exit(0);
}

main().catch((err) => fail(err?.message ?? String(err)));
