import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  const session = JSON.parse(readFileSync(process.env.POWERSHIFT_BROWSER_SESSION_FILE!, 'utf8'));
  await page.addInitScript(({ authority, clientId, user }) => {
    // Existing OIDC session storage, with a genuinely signed test access token.
    // Production code still performs normal backend JWT verification.
    if (!sessionStorage.getItem(`oidc.user:${authority}:${clientId}`)) sessionStorage.setItem(`oidc.user:${authority}:${clientId}`, JSON.stringify(user));
  }, session);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your energy, made clearer.' })).toBeVisible();
});

async function newProfile(page: Page, name: string, sector = 'home') {
  await page.getByRole('button', { name: 'New profile', exact: true }).click();
  await page.getByLabel('Profile name', { exact: true }).fill(name);
  await page.getByLabel('Type of space', { exact: true }).selectOption(sector);
  await page.getByRole('dialog').getByRole('button', { name: 'Create profile', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.topbar')).toContainText(name);
  await expect(page.getByRole('button', { name: 'Add appliance', exact: true }).first()).toBeEnabled();
}
async function editor(page: Page) {
  await page.getByRole('button', { name: 'Add appliance', exact: true }).first().click();
  return page.getByRole('dialog');
}
async function save(page: Page) {
  await page.getByLabel('I reviewed the values above', { exact: false }).check();
  await page.getByRole('button', { name: 'Save appliance', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}

test('complete manual journey, incomplete warnings, editing, deletion and profile selection', async ({ page }) => {
  await newProfile(page, 'Browser home');
  const dialog = await editor(page);
  await dialog.getByRole('button', { name: 'Ceiling fan', exact: true }).click();
  await expect(page.getByLabel('Rated power (W)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Effective load (%)', { exact: true })).toHaveValue('');
  await page.getByLabel('Rated power (W)', { exact: true }).fill('100');
  await page.getByLabel('Hours used per day', { exact: true }).fill('5');
  await page.getByLabel('Effective load (%)', { exact: true }).fill('100');
  await save(page);
  await expect(page.getByRole('article', { name: 'Daily energy', exact: true })).toContainText('0.5');
  await expect(page.getByRole('article', { name: '30-day energy', exact: true })).toContainText('15');
  await editor(page);
  await page.getByLabel('Appliance name', { exact: true }).fill('Unknown load refrigerator');
  await page.getByLabel('Rated power (W)', { exact: true }).fill('200');
  await page.getByLabel('Hours used per day', { exact: true }).fill('0');
  await expect(page.getByRole('dialog')).toContainText('1 estimate input is unknown');
  await save(page);
  await expect(page.locator('.incomplete-banner')).toContainText('1 appliance needs');
  await expect(page.getByRole('article', { name: 'Daily energy', exact: true })).toContainText('0.5');
  await page.getByRole('button', { name: 'Review incomplete' }).click();
  await expect(page.getByRole('button', { name: 'Edit Ceiling fan', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Unknown load refrigerator', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All appliances', exact: true }).click();
  await page.getByLabel('Tariff (₦ / kWh) · optional', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Update estimate', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Grid-equivalent cost', exact: true })).toContainText('₦1500.00');
  await page.getByRole('button', { name: 'Edit Ceiling fan', exact: true }).click();
  await expect(page.getByLabel('I reviewed the values above', { exact: false })).not.toBeChecked();
  await page.getByLabel('Hours used per day', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Confirm that you reviewed these values, including any unknowns.')).toBeVisible();
  await page.getByLabel('I reviewed the values above', { exact: false }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('article', { name: 'Daily energy', exact: true })).toContainText('1');
  await page.getByRole('button', { name: 'Delete Ceiling fan', exact: true }).click();
  await page.getByRole('button', { name: 'Keep appliance', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Ceiling fan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Ceiling fan', exact: true }).click();
  await page.getByRole('button', { name: 'Delete appliance', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('article', { name: 'Daily energy', exact: true })).toContainText('—');
  await expect(page.getByText('No complete, confirmed appliances are available for an estimate yet.')).toBeVisible();
  await newProfile(page, 'Browser office', 'office');
  await expect(page.getByRole('heading', { name: 'Every appliance adds a little clarity.' })).toBeVisible();
  await page.getByLabel('CURRENT PROFILE', { exact: true }).selectOption({ label: 'Browser home' });
  await expect(page.getByRole('button', { name: 'Edit Unknown load refrigerator', exact: true })).toBeVisible();
  await expect(page.getByLabel('Tariff (₦ / kWh) · optional', { exact: true })).toHaveValue('');
  await page.reload();
  await page.getByLabel('CURRENT PROFILE', { exact: true }).selectOption({ label: 'Browser home' });
  await expect(page.getByRole('button', { name: 'Edit Unknown load refrigerator', exact: true })).toBeVisible();
});

test('validation, exact decimals, zero tariff and small screen accessibility', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await newProfile(page, 'Mobile precision home');
  await editor(page);
  await expect(page.getByLabel('Appliance name', { exact: true })).toBeFocused();
  await page.getByLabel('Appliance name', { exact: true }).fill('Precision light');
  await page.getByLabel('Rated power (W)', { exact: true }).fill('100.00000000000000000000001');
  await page.getByLabel('Hours used per day', { exact: true }).fill('25');
  await page.getByLabel('Effective load (%)', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Save appliance', exact: true }).click();
  await expect(page.getByText('Enter 24 or less.', { exact: true })).toBeVisible();
  await page.getByLabel('Hours used per day', { exact: true }).fill('0');
  const requestPromise = page.waitForRequest(r => r.method() === 'POST' && /\/appliances$/.test(r.url()));
  await save(page);
  expect((await requestPromise).postData()).toContain('100.00000000000000000000001');
  await expect(page.getByRole('article', { name: 'Daily energy', exact: true })).toContainText('0');
  await page.getByLabel('Tariff (₦ / kWh) · optional', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Update estimate', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Grid-equivalent cost', exact: true })).toContainText('₦0.00');
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))).toEqual([]);
  await page.screenshot({ path: 'test-results/mobile-dashboard.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 320);
});

test('stale edits preserve drafts and recovery reloads server values', async ({ page }) => {
  await newProfile(page, 'Versioned profile');
  await editor(page);
  await page.getByLabel('Appliance name', { exact: true }).fill('Versioned fan');
  await save(page);
  await page.getByRole('button', { name: 'Edit Versioned fan', exact: true }).click();
  await page.getByLabel('Appliance name', { exact: true }).fill('Unsaved draft');
  await page.route('**/api/appliances/*', route => route.request().method() === 'PATCH' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'STALE_VERSION', message: 'Conflict', details: [], request_id: 'test-stale' } }) }) : route.continue());
  await page.getByLabel('I reviewed the values above', { exact: false }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('changed in another session');
  await expect(page.getByLabel('Appliance name', { exact: true })).toHaveValue('Unsaved draft');
  await page.getByRole('button', { name: 'Discard changes and reload' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Versioned fan', exact: true })).toBeVisible();
});

test('a failed save keeps the request key and shows recoverable feedback', async ({ page }) => {
  await newProfile(page, 'Retry home');
  await editor(page);
  await page.getByLabel('Appliance name', { exact: true }).fill('Retry lamp');
  let first = true; const payloads: string[] = [];
  await page.route('**/api/profiles/*/appliances', async route => {
    payloads.push(route.request().postData()!);
    if (first) { first = false; await route.abort(); } else await route.continue();
  });
  await page.getByLabel('I reviewed the values above', { exact: false }).check();
  await page.getByRole('button', { name: 'Save appliance', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Check your connection');
  await page.getByRole('button', { name: 'Save appliance', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(JSON.parse(payloads[0]).client_request_id).toBe(JSON.parse(payloads[1]).client_request_id);
});

test('session rejection clears private UI and sign-in uses PKCE', async ({ page }) => {
  await newProfile(page, 'Private session home');
  await page.route('**/api/profiles/*', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: 'Expired', details: [], request_id: 'test-expired' } }) }));
  await page.getByRole('button', { name: 'Update estimate', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Understand the energy/ })).toBeVisible();
  await expect(page.locator('.topbar')).not.toBeVisible();
  const session = JSON.parse(readFileSync(process.env.POWERSHIFT_BROWSER_SESSION_FILE!, 'utf8'));
  expect(await page.evaluate(key => sessionStorage.getItem(key), `oidc.user:${session.authority}:${session.clientId}`)).toBeNull();
  await page.route('https://identity.example.test/.well-known/openid-configuration', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ issuer: 'https://identity.example.test/', authorization_endpoint: 'https://identity.example.test/authorize', token_endpoint: 'https://identity.example.test/token', jwks_uri: 'https://identity.example.test/jwks', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] }) }));
  await page.route('https://identity.example.test/authorize?**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Test identity sign-in</h1>' }));
  await page.getByRole('button', { name: 'Sign in to your workspace' }).click();
  await expect(page).toHaveURL(/\/authorize\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')?.length).toBeGreaterThan(30);
  expect(url.searchParams.get('state')).toBeTruthy();
});

test('desktop keyboard dialog and contrast checks', async ({ page }) => {
  await newProfile(page, 'Accessible workspace');
  await editor(page);
  await expect(page.getByLabel('Appliance name', { exact: true })).toBeFocused();
  for (let index = 0; index < 22; index++) {
    await page.keyboard.press('Tab');
    expect(await page.getByRole('dialog').evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
  }
  const modalAudit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(modalAudit.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await editor(page);
  await page.getByLabel('Appliance name', { exact: true }).fill('Living room fan');
  await page.getByLabel('Rated power (W)', { exact: true }).fill('100');
  await page.getByLabel('Hours used per day', { exact: true }).fill('5');
  await page.getByLabel('Effective load (%)', { exact: true }).fill('100');
  await save(page);
  await editor(page);
  await page.getByLabel('Appliance name', { exact: true }).fill('Freezer · usage pending');
  await save(page);
  await page.getByLabel('Tariff (₦ / kWh) · optional', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Update estimate', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Grid-equivalent cost', exact: true })).toContainText('₦1500.00');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))).toEqual([]);
  await page.screenshot({ path: 'test-results/desktop-dashboard.png', fullPage: true });
});
