import { defineConfig, devices } from '@playwright/test';

// Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use an existing Chromium instead of `npx playwright install chromium`.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath },
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/ceo.json', launchOptions: { executablePath } },
      dependencies: ['setup'],
    },
  ],
  webServer: [
    {
      command: 'node e2e/start-api.mjs',
      url: 'http://localhost:3100/api/health',
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'ignore',
    },
    {
      command: 'npx vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      env: { VITE_API_PROXY_TARGET: 'http://localhost:3100' },
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
