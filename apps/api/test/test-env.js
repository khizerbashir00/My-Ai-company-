// Resolves the test database URL. Refuses anything that does not look like a dedicated test DB,
// so the e2e suite (which truncates every table) can never wipe your real data.
require('dotenv/config');

function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL database for e2e tests (its name must contain "test").');
  }
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(name)) throw new Error(`Refusing to run e2e tests against database "${name}" — its name must contain "test".`);
  return url;
}

module.exports = { testDatabaseUrl };
