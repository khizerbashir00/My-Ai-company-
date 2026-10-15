const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { testDatabaseUrl } = require('./test-env');

/** Recreates the test schema from the committed migrations once per run. */
module.exports = async function globalSetup() {
  const url = testDatabaseUrl();
  execFileSync(process.execPath, ['--no-warnings', '--experimental-wasm-modules', 'scripts/prisma-wasm.mjs', 'reset'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' },
    stdio: 'inherit',
  });
};
