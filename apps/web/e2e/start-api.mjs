// Boots an isolated API for the browser tests:
// resets TEST_DATABASE_URL, seeds a known CEO, builds, and starts the API on port 3100.
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { E2E_CEO } from './credentials.mjs';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api');
dotenv.config({ path: path.join(apiDir, '.env') });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set in apps/api/.env');
if (!/test/i.test(new URL(url).pathname)) throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test"');

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: '3100',
  DATABASE_URL: url,
  TRUST_PROXY: '0',
  CORS_ORIGINS: 'http://localhost:5174',
  JWT_SECRET: process.env.JWT_SECRET || 'playwright-only-secret-at-least-32-characters-long',
  OPENAI_API_KEY: '',
  OPENAI_MODEL: '',
  OPENAI_MODEL_ADVANCED: '',
  CEO_EMAIL: E2E_CEO.email,
  CEO_NAME: E2E_CEO.name,
  CEO_PASSWORD: E2E_CEO.password,
};
const run = (cmd, args) => execFileSync(cmd, args, { cwd: apiDir, env, stdio: 'inherit' });

run(process.execPath, ['--no-warnings', '--experimental-wasm-modules', 'scripts/prisma-wasm.mjs', 'reset']);
run('npx', ['ts-node', '--transpile-only', 'prisma/seed.ts']);
run('npx', ['nest', 'build']);

const api = spawn(process.execPath, ['dist/main.js'], { cwd: apiDir, env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => api.kill(sig));
api.on('exit', (code) => process.exit(code ?? 0));
