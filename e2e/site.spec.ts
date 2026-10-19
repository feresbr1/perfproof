import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const errors: string[] = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
});
test.afterEach(() => expect(errors).toEqual([]));

test('landing explains the product with real output', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Find the slow line.');
  await expect(page.locator('.term').first()).toContainText('report.js:24');
  await expect(page.locator('.term').nth(1)).toContainText('FASTER');
  await page.getByRole('link', { name: 'See a real report' }).click();
  await expect(page).toHaveURL(/#\/demo$/);
  await expect(page.getByRole('heading', { name: 'Demo report' })).toBeVisible();
});

test('demo report: hot lines expand, flame graph zooms and searches', async ({ page }) => {
  await page.goto('./#/demo');
  const first = page.locator('.pp-line').first();
  await expect(first).toContainText('report.js:24');
  await expect(first.locator('.is-hot')).toContainText('visitors.includes');
  await expect(first).toContainText('Set or Map');

  const second = page.locator('.pp-line').nth(1).getByRole('button');
  await second.click();
  await expect(page.locator('.pp-line').nth(1).locator('.is-hot')).toContainText('new RegExp');

  const flame = page.getByTestId('flame');
  await flame
    .getByRole('button', { name: /^summarise / })
    .first()
    .click();
  await expect(page.locator('.pp-crumbs')).toContainText('summarise');
  await page.getByRole('button', { name: 'Reset zoom' }).click();
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveCount(0);

  await page.getByPlaceholder('Search functions or files…').fill('parse');
  await expect(page.locator('.pp-detail')).toContainText('matches');

  await page.getByRole('button', { name: /^Total/ }).click();
  await expect(page.locator('.pp-table tbody tr').first()).toContainText('(module)');
});

test('viewer opens a raw .cpuprofile from the file picker', async ({ page }) => {
  await page.goto('./#/view');
  await expect(page.getByText('Drop .cpuprofile files here')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({
    name: 'log-report.cpuprofile',
    mimeType: 'application/json',
    buffer: readFileSync('public/demo/log-report.cpuprofile'),
  });
  await expect(page.locator('.pp-line').first()).toContainText('report.js:24');
  await expect(page.getByText('log-report.cpuprofile')).toBeVisible();
  await page.getByRole('button', { name: 'Open another' }).click();
  await expect(page.getByText('Drop .cpuprofile files here')).toBeVisible();
});

test('viewer explains files it cannot read', async ({ page }) => {
  await page.goto('./#/view');
  await page.locator('input[type=file]').setInputFiles({
    name: 'trace.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"traceEvents": []}'),
  });
  await expect(page.getByRole('alert')).toContainText('Performance trace');
  await page.locator('input[type=file]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await expect(page.getByRole('alert')).toContainText('not JSON');
});

test('sample profile download link works', async ({ page, request }) => {
  await page.goto('./#/view');
  const href = await page.getByRole('link', { name: 'Download a sample' }).getAttribute('href');
  const res = await request.get(new URL(href!, page.url()).toString());
  expect(res.ok()).toBe(true);
  expect(JSON.parse(await res.text()).nodes.length).toBeGreaterThan(10);
});

test('no horizontal scrolling and direct navigation works', async ({ page }) => {
  for (const hash of ['', '#/demo', '#/view']) {
    await page.goto(`./${hash}`);
    await page.reload();
    await expect(page.locator('main')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
