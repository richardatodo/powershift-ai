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

test('saved reports agree with dashboard, export CSV and remain unchanged after edits', async ({page}) => {
  await newProfile(page,'Report home');
  await editor(page);
  await page.getByLabel('Appliance name',{exact:true}).fill('=Fan, "quoted"');
  await page.getByLabel('Rated power (W)',{exact:true}).fill('100');
  await page.getByLabel('Hours used per day',{exact:true}).fill('5');
  await page.getByLabel('Effective load (%)',{exact:true}).fill('50');
  await save(page);
  await editor(page);await page.getByLabel('Appliance name',{exact:true}).fill('Incomplete refrigerator');await save(page);
  await page.getByLabel('Period (days)',{exact:true}).fill('7');
  await page.getByLabel('Tariff (₦ / kWh) · optional',{exact:true}).fill('100');
  await page.getByRole('button',{name:'Update estimate',exact:true}).click();
  await expect(page.getByRole('article',{name:'Daily energy',exact:true})).toContainText('0.25');
  await expect(page.getByRole('article',{name:'7-day energy',exact:true})).toContainText('1.75');
  await expect(page.getByRole('article',{name:'Grid-equivalent cost',exact:true})).toContainText('175.00');
  await page.getByRole('button',{name:'Needs details',exact:false}).click();
  const capture=page.waitForResponse(response => response.url().endsWith('/api/reports') && response.request().method()==='POST');
  await page.getByRole('button',{name:'Save report',exact:true}).click();
  const saved=await (await capture).json();
  await expect(page).toHaveURL(new RegExp('report='+saved.id));
  await expect(page.getByRole('article',{name:'Report daily energy',exact:true})).toContainText('0.25');
  await expect(page.getByRole('article',{name:'Report period energy',exact:true})).toContainText('1.75');
  await expect(page.getByRole('article',{name:'Report grid-equivalent cost',exact:true})).toContainText('175.00');
  await expect(page.getByRole('table')).toContainText('=Fan, "quoted"');
  await expect(page.getByRole('table')).toContainText('Incomplete refrigerator');
  await expect(page.getByRole('region',{name:'Warnings & exclusions',exact:true})).toContainText('INCOMPLETE_RECORDS');
  await expect(page.getByRole('region',{name:'Assumptions & boundaries',exact:true})).toContainText('not measured');
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download CSV',exact:true}).click();
  const file=await downloaded;expect(file.suggestedFilename()).toBe(`powershift-${saved.id}.csv`);
  const csv=readFileSync((await file.path())!,'utf8');
  expect(csv.split('\r\n')[0]?.split(',')).toHaveLength(20);
  expect(csv).toContain("'=Fan");expect(csv).toContain('MISSING_VALUE');expect(csv).toContain('1.750000');expect(csv).toContain('175.00');
  const a11y=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(a11y.violations).toEqual([]);
  await page.screenshot({path:'test-results/m8-report-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const mobileAudit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(mobileAudit.violations).toEqual([]);
  await page.getByRole('region',{name:'Saved appliance details',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  await page.setViewportSize({width:320,height:700});
  expect(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/m8-report-mobile.png',fullPage:true});
  await page.emulateMedia({media:'print'});
  await expect(page.getByRole('navigation',{name:'Report actions',exact:true})).not.toBeVisible();
  await expect(page.getByRole('region',{name:'Assumptions & boundaries',exact:true})).toBeVisible();
  await page.setViewportSize({width:794,height:1123});
  expect(await page.getByRole('table').evaluate(table => table.scrollWidth<=table.clientWidth+1)).toBe(true);
  await page.screenshot({path:'test-results/m8-report-print.png',fullPage:true});
  await page.emulateMedia({media:'screen'});await page.setViewportSize({width:1280,height:900});
  const reportUrl=page.url();await page.reload();
  await expect(page.getByRole('article',{name:'Report period energy',exact:true})).toContainText('1.75');
  await page.getByRole('button',{name:'Back to dashboard',exact:true}).click();
  await expect(page.getByLabel('Period (days)',{exact:true})).toHaveValue('7');
  await expect(page.getByLabel('Tariff (₦ / kWh) · optional',{exact:true})).toHaveValue('100');
  await page.getByRole('button',{name:'Edit =Fan, "quoted"',exact:true}).click();
  await page.getByLabel('Rated power (W)',{exact:true}).fill('200');
  await page.getByLabel('I reviewed the values above',{exact:false}).check();
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('article',{name:'Daily energy',exact:true})).toContainText('0.5');
  await page.goto(reportUrl);
  await expect(page.getByRole('article',{name:'Report daily energy',exact:true})).toContainText('0.25');
});

test('empty report, retry request key, print action and missing report handling',async({page}) => {
  await newProfile(page,'Empty report home');
  const keys:string[]=[];let attempts=0;
  await page.route('**/api/reports',async route => {
    keys.push(route.request().postDataJSON().client_request_id);attempts++;
    if(attempts===1) await route.abort('failed');else await route.continue();
  });
  await page.getByRole('button',{name:'Save report',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Check your connection');
  await page.getByRole('button',{name:'Save report',exact:true}).click();
  await expect(page.getByText('No appliances were saved in this snapshot.',{exact:false})).toBeVisible();
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
  await expect(page.getByRole('article',{name:'Report grid-equivalent cost',exact:true})).toContainText('Not estimated');
  await page.evaluate(() => { (window as Window & {printed?:boolean}).printed=false;window.print=()=>{(window as Window & {printed?:boolean}).printed=true;}; });
  await page.getByRole('button',{name:'Print report',exact:true}).click();
  expect(await page.evaluate(()=>(window as Window & {printed?:boolean}).printed)).toBe(true);
  await page.goto('/?report=11111111-1111-4111-8111-111111111111');
  await expect(page.getByRole('alert')).toContainText('The resource was not found.');
  await expect(page.getByRole('button',{name:'Download CSV',exact:true})).not.toBeVisible();
});

test('report capture detects concurrent edits and CSV rejection clears private report UI',async({page})=>{
  await newProfile(page,'Concurrent report home');
  await editor(page);await page.getByLabel('Appliance name',{exact:true}).fill('Concurrent fan');
  await page.getByLabel('Rated power (W)',{exact:true}).fill('100');await page.getByLabel('Hours used per day',{exact:true}).fill('1');
  await page.getByLabel('Effective load (%)',{exact:true}).fill('100');await save(page);
  const session=JSON.parse(readFileSync(process.env.POWERSHIFT_BROWSER_SESSION_FILE!,'utf8'));
  const profiles=await page.request.get('/api/profiles',{headers:{Authorization:'Bearer '+session.user.access_token}});
  const savedProfile=(await profiles.json()).profiles.find((profile:{name:string})=>profile.name==='Concurrent report home');
  const workspace=await page.request.get('/api/profiles/'+savedProfile.id,{headers:{Authorization:'Bearer '+session.user.access_token}});
  const appliance=(await workspace.json()).appliances[0];
  const edited=await page.request.patch('/api/appliances/'+appliance.id,{headers:{Authorization:'Bearer '+session.user.access_token},data:{rated_watts:200,version:appliance.version,confirmation:true}});
  expect(edited.status()).toBe(200);
  await page.getByRole('button',{name:'Save report',exact:true}).click();
  await expect(page.getByText('The profile changed since the dashboard estimate.',{exact:false})).toBeVisible();
  await expect(page.getByRole('article',{name:'Report daily energy',exact:true})).toContainText('0.2');
  await page.route('**/export.csv',route=>route.fulfill({status:401,contentType:'text/plain',body:'Unauthorized'}));
  await page.getByRole('button',{name:'Download CSV',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Understand the energy',exact:false})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Energy estimate report',exact:true})).not.toBeVisible();
});

test('local scan consent, editable unconfirmed candidates and explicit save', async ({ page }) => {
  await newProfile(page, 'Scan browser home');
  await editor(page);
  await page.getByRole('button', { name: 'Read an appliance label', exact: true }).click();
  // Generated 2x2 PNG; local-model transport is mocked by browser_server.py.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP8//8/AwMDEwMYAAAkBgMBXaJOiAAAAABJRU5ErkJggg==', 'base64');
  await page.getByLabel('Label photo', { exact: false }).setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png});
  await expect(page.getByRole('button', { name: 'Extract label values', exact: true })).toBeDisabled();
  await page.getByLabel('I agree to the local photo processing', { exact: false }).check();
  await page.getByRole('button', { name: 'Extract label values', exact: true }).click();
  await expect(page.getByText('Review every extracted value before saving.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Appliance name', {exact:true})).toHaveValue('Scanned fan');
  await expect(page.getByLabel('Rated power (W)', {exact:true})).toHaveValue('60');
  await expect(page.getByLabel('Hours used per day', {exact:true})).toHaveValue('');
  await expect(page.getByLabel('Effective load (%)', {exact:true})).toHaveValue('');
  await expect(page.getByLabel('I reviewed the values above', { exact: false })).not.toBeChecked();
  await page.getByRole('button', {name:'Save appliance',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Appliance name',{exact:true}).fill('Reviewed scan fan');
  await page.getByLabel('Hours used per day',{exact:true}).fill('5');
  await page.getByLabel('Effective load (%)',{exact:true}).fill('50');
  const a11y = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(a11y.violations).toEqual([]);
  await page.getByRole('dialog').evaluate(dialog => { dialog.scrollTop=0; });
  await page.getByRole('dialog').screenshot({path:'test-results/scan-review.png'});
  await save(page);
  await expect(page.getByRole('article',{name:'Daily energy',exact:true})).toContainText('0.15');
  await page.getByRole('button',{name:'Edit Reviewed scan fan',exact:true}).click();
  await expect(page.getByLabel('Rated power (W)',{exact:true})).toHaveValue('60');
});

test('scan unavailable retains manual entry and does not submit without consent', async ({ page }) => {
  await newProfile(page, 'Manual scan fallback');
  await page.route('**/api/status', route => route.fulfill({status:200,contentType:'application/json',body:'{"imageScanningConfigured":false}'}));
  await editor(page);
  await page.getByRole('button',{name:'Read an appliance label',exact:true}).click();
  await expect(page.getByText('Label scanning is not configured.',{exact:false})).toBeVisible();
  await page.getByLabel('Appliance name',{exact:true}).fill('Manual fallback fan');
  await page.getByLabel('Rated power (W)',{exact:true}).fill('60');
  await save(page);
  await expect(page.getByRole('button',{name:'Edit Manual fallback fan',exact:true})).toBeVisible();
});

for (const status of [502, 503]) test(`scan failure ${status} preserves the manual fallback`, async ({ page }) => {
  await newProfile(page, `Scan failure ${status}`);
  await page.route('**/api/scan', route => route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:{
    code:status===503?'SCANNER_UNAVAILABLE':'INVALID_SCAN_RESULT',message:'Local scanning failed. Enter values manually.',details:[],request_id:'browser-scan-failure'}})}));
  await editor(page);
  await page.getByRole('button',{name:'Read an appliance label',exact:true}).click();
  await page.getByLabel('Label photo',{exact:false}).setInputFiles({name:'synthetic.png',mimeType:'image/png',
    buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP8//8/AwMDEwMYAAAkBgMBXaJOiAAAAABJRU5ErkJggg==','base64')});
  await page.getByLabel('I agree to the local photo processing',{exact:false}).check();
  await page.getByRole('button',{name:'Extract label values',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Local scanning failed. Enter values manually.');
  await page.getByRole('button',{name:'Continue manually',exact:true}).click();
  await page.getByLabel('Appliance name',{exact:true}).fill('Fallback after model failure');
  await save(page);
  await expect(page.getByRole('button',{name:'Edit Fallback after model failure',exact:true})).toBeVisible();
});

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
