/** E2E tests: real Nest app + real PostgreSQL test database (TEST_DATABASE_URL). */
module.exports = {
  rootDir: '..',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.js',
  testTimeout: 30000,
};
