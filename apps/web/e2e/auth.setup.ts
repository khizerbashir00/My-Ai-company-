import { expect, test as setup } from '@playwright/test';
// @ts-expect-error plain ESM helper shared with the API launcher
import { E2E_CEO } from './credentials.mjs';

// One real login through the UI; other tests reuse the session (the login endpoint is rate-limited).
setup('sign in as CEO', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(E2E_CEO.email);
  await page.getByLabel('Password').fill(E2E_CEO.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.context().storageState({ path: 'e2e/.auth/ceo.json' });
});
