import { expect, test } from '@playwright/test';
// @ts-expect-error plain ESM helper shared with the API launcher
import { E2E_CEO } from './credentials.mjs';

test.describe('signing in', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('rejects a wrong password, then signs in and out', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email').fill(E2E_CEO.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Invalid email or password');

    await page.getByLabel('Password').fill(E2E_CEO.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Returns to the page originally requested
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test('overview shows honest empty states and what needs attention', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('AI isn’t configured yet')).toBeVisible();
  await expect(page.getByText('No leads yet')).toBeVisible();
  await expect(page.getByText('Live updates on')).toBeVisible();

  const sales = page.locator('section', { has: page.getByRole('heading', { name: 'Sales', exact: true }) });
  await expect(sales.getByText('Leads discovered')).toBeVisible();
  await sales.getByRole('button', { name: 'How these are counted' }).click();
  await expect(sales.getByText('Leads discovered in the range.')).toBeVisible();
});

test('create a task and drive it through the state machine', async ({ page }) => {
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.getByLabel('What needs doing?').fill('Find US dental clinics asking for a website redesign');
  await dialog.getByLabel('Details').fill('Only explicit requests from the last 14 days.');
  await dialog.getByLabel('Assign to').selectOption({ label: 'Sales department (manager decides)' });
  await dialog.getByLabel('Priority').selectOption('HIGH');
  await dialog.getByRole('button', { name: 'Create task' }).click();

  await expect(page.getByRole('heading', { name: 'Find US dental clinics asking for a website redesign' })).toBeVisible();
  await expect(page.getByText('Department task, high priority')).toBeVisible();
  await expect(page.getByText('Queued', { exact: true }).first()).toBeVisible();

  // Only legal moves are offered
  await expect(page.getByRole('button', { name: 'Mark completed' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Moved to Running')).toBeVisible();

  await page.getByRole('button', { name: 'Mark failed' }).click();
  await page.getByLabel('What went wrong?').fill('Source API returned 503');
  await page.getByRole('button', { name: 'Mark failed' }).last().click();
  await expect(page.getByRole('alert').filter({ hasText: 'Why it failed' })).toContainText('Source API returned 503');

  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Retried')).toBeVisible();

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByText('Moved to Cancelled')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toHaveCount(0);

  // Find it again from the list with filters and search
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Cancelled', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('dental');
  await expect(page).toHaveURL(/status=CANCELLED/);
  await expect(page.getByRole('link', { name: 'Find US dental clinics asking for a website redesign' })).toBeVisible();
  await page.getByRole('button', { name: 'Running', exact: true }).click();
  await page.getByRole('button', { name: 'Cancelled', exact: true }).click();
  await expect(page.getByText('No tasks match these filters')).toBeVisible();
});

test('tasks created elsewhere appear live without reloading', async ({ page, context }) => {
  await page.goto('/tasks');
  await expect(page.getByText('Live updates on')).toBeVisible();

  const other = await context.newPage();
  await other.goto('/');
  const res = await other.evaluate(async () => {
    const r = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Weekly competitor pricing check' }) });
    return r.status;
  });
  expect(res).toBe(201);

  await expect(page.getByRole('link', { name: 'Weekly competitor pricing check' })).toBeVisible({ timeout: 5000 });
});

test('organization chart and editing an agent role', async ({ page }) => {
  await page.goto('/organization');
  await expect(page.getByRole('link', { name: /AI General Manager/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sales', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Marketing', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Worker/ })).toHaveCount(12);

  await page.getByRole('link', { name: /Outreach Writing Worker/ }).click();
  await expect(page.getByRole('heading', { name: 'Outreach Writing Worker' })).toBeVisible();

  // Human-only permissions can never be ticked for an AI role
  await expect(page.getByLabel(/deals\.confirm/)).toBeDisabled();
  await expect(page.getByLabel(/permissions\.manage/)).toBeDisabled();

  // Granting sending shows it is locked behind approval
  await page.getByLabel(/^outreach\.send/).check();
  await expect(page.getByText('Always needs your approval')).toBeVisible();

  const instructions = page.getByLabel('Instructions');
  await instructions.fill('Write short, specific messages that reference the prospect’s own words. Never exaggerate our experience.');
  await page.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByText('You have unsaved changes')).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel('Instructions')).toHaveValue(/prospect’s own words/);
  await expect(page.getByLabel(/^outreach\.send/)).toBeChecked();
});
