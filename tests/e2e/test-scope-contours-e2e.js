/**
 * E2E: region scope reach contours (scope-contours.js) on the map and live
 * pages.
 *
 * Each region scope gets an outline within 8 km of the nodes that handle it:
 * solid for nodes seen carrying its traffic (transported_scopes), dashed for
 * nodes that only declare it (declared_regions). The "Reach contours" toggle
 * draws them, ?contours=1 deep-links them, the Region Scope picker narrows
 * them to one scope, and they sit under the markers. On the live page the
 * outline of a scope flashes when one of its packets arrives.
 *
 * Backend-independent: every /api/* call is mocked via page.route, and the
 * live packet is delivered to the page's own WebSocket listeners.
 *
 * Run: BASE_URL=http://localhost:13581 node test-scope-contours-e2e.js
 */
'use strict';
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:13581';

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const pk = (b) => b + '0'.repeat(62);
const now = new Date().toISOString();
// Spellings as the server sends them: transported_scopes keeps the '#',
// declared_regions has it stripped.
const NODES = [
  { public_key: pk('a1'), name: 'SF One', role: 'repeater', lat: 37.77, lon: -122.42, last_seen: now, hash_size: 1, transported_scopes: ['#sf'] },
  { public_key: pk('a2'), name: 'SF Two', role: 'repeater', lat: 37.79, lon: -122.40, last_seen: now, hash_size: 1, transported_scopes: ['#sf', '#bay'] },
  { public_key: pk('a3'), name: 'Oakland', role: 'repeater', lat: 37.80, lon: -122.27, last_seen: now, hash_size: 1, transported_scopes: ['#bay'] },
  { public_key: pk('a4'), name: 'San Jose', role: 'repeater', lat: 37.34, lon: -121.89, last_seen: now, hash_size: 1, declared_regions: ['south-bay'] },
];

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  console.log(`\n=== Region scope reach contours E2E against ${BASE} ===`);

  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/nodes') return json({ nodes: NODES, total: NODES.length, has_more: false, counts: { repeaters: NODES.length, rooms: 0, companions: 0, sensors: 0 } });
    if (path === '/api/observers') return json({ observers: [] });
    if (path === '/api/packets') return json({ packets: [], total: 0 });
    if (path === '/api/config/map') return json({ center: [37.6, -122.2], zoom: 9 });
    return json({});
  });

  const areas = () => page.$$eval('path.mc-scope-area', (els) => els.map((el) => el.getAttribute('class')));

  await page.goto(BASE + '/#/map', { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => localStorage.removeItem('meshcore-map-scope-contours'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#leaflet-map');
  await page.waitForSelector('.leaflet-marker-icon');

  await step('off by default: no outlines drawn', async () => {
    assert(!(await page.$eval('#mcScopeContours', (el) => el.checked)), 'toggle checked by default');
    assert((await areas()).length === 0, 'outlines drawn while off');
  });

  await step('the toggle draws solid outlines for carried scopes and a dashed one for declared-only', async () => {
    await page.click('#mcScopeContours');
    await page.waitForSelector('path.mc-scope-area');
    const cls = await areas();
    assert(cls.filter((c) => c.includes('mc-scope-area-observed')).length === 2, 'observed outlines: ' + cls.join(' | '));
    assert(cls.filter((c) => c.includes('mc-scope-area-declared')).length === 1, 'declared outlines: ' + cls.join(' | '));
    const dash = await page.$eval('path.mc-scope-area-declared', (el) => getComputedStyle(el).strokeDasharray);
    assert(dash && dash !== 'none', 'declared-only outline is not dashed: ' + dash);
    const stroke = await page.$eval('path.mc-scope-area-observed', (el) => getComputedStyle(el).stroke);
    assert(stroke && stroke !== 'none' && stroke !== 'rgb(51, 136, 255)', 'outline not coloured by its CSS variable: ' + stroke);
  });

  await step('the choice is stored and written to the URL', async () => {
    assert(await page.evaluate(() => localStorage.getItem('meshcore-map-scope-contours')) === 'true', 'not stored');
    assert(/[?&]contours=1\b/.test(await page.evaluate(() => location.hash)), 'hash: ' + (await page.evaluate(() => location.hash)));
  });

  await step('outlines sit under the markers', async () => {
    const z = await page.evaluate(() => ({
      c: Number(getComputedStyle(document.querySelector('.leaflet-mcScopeContours-pane')).zIndex),
      m: Number(getComputedStyle(document.querySelector('.leaflet-marker-pane')).zIndex),
    }));
    assert(z.c < z.m, 'contour pane ' + z.c + ' not under marker pane ' + z.m);
  });

  await step('the Region Scope picker narrows the outlines to one scope', async () => {
    await page.waitForSelector('#mcRegionFilter option[value="south-bay"]', { state: 'attached' });
    await page.selectOption('#mcRegionFilter', 'south-bay');
    await page.waitForFunction(() => document.querySelectorAll('path.mc-scope-area').length === 1);
    const cls = await areas();
    assert(cls[0].includes('mc-scope-area-declared'), cls.join(' | '));
    await page.selectOption('#mcRegionFilter', '');
    await page.waitForFunction(() => document.querySelectorAll('path.mc-scope-area').length === 3);
  });

  await step('?contours=0 overrides the stored choice; ?contours=1 restores it', async () => {
    await page.goto(BASE + '/#/map?contours=0', { waitUntil: 'load' });
    await page.waitForSelector('.leaflet-marker-icon');
    assert(!(await page.$eval('#mcScopeContours', (el) => el.checked)), 'checked despite contours=0');
    assert((await areas()).length === 0, 'outlines drawn despite contours=0');
    await page.goto(BASE + '/#/map?contours=1', { waitUntil: 'load' });
    await page.waitForSelector('path.mc-scope-area');
    assert(await page.$eval('#mcScopeContours', (el) => el.checked), 'unchecked despite contours=1');
  });

  await step('the toggle off removes the outlines', async () => {
    await page.click('#mcScopeContours');
    await page.waitForFunction(() => !document.querySelector('path.mc-scope-area'));
    assert(!/[?&]contours=/.test(await page.evaluate(() => location.hash)), 'contours param left in the URL');
  });

  await step('live: ?contours=1 draws the outlines on the canvas map', async () => {
    await page.goto(BASE + '/#/live?contours=1', { waitUntil: 'load' });
    await page.waitForSelector('#liveMap');
    await page.waitForSelector('path.mc-scope-area');
    assert(await page.$eval('#liveScopeContoursToggle', (el) => el.checked), 'live toggle unchecked');
    assert((await areas()).length === 3, 'live outlines: ' + (await areas()).join(' | '));
  });

  await step('live: a scoped packet flashes only its scope, and the flash ends', async () => {
    const sfClass = await page.evaluate(() => 'mc-reach-c' + window.ScopeContours.colorIndex('sf'));
    await page.evaluate(() => {
      const pkt = {
        id: 999001, hash: 'e2econtour0001', raw_hex: '0000', route_type: 0, payload_type: 5, timestamp: new Date().toISOString(),
        observer_id: 'obs-e2e', observer_name: 'E2E', snr: 5, rssi: -90, path_json: '[]', scope_name: '#sf',
        decoded: { header: { payloadTypeName: 'GRP_TXT' }, payload: {} },
      };
      // app.js's listener list: the live page's handler is on it.
      wsListeners.forEach((fn) => fn({ type: 'packet', data: pkt }));
    });
    await page.waitForSelector('path.mc-scope-area.is-pulsing', { timeout: 3000 });
    const pulsing = await page.$$eval('path.mc-scope-area.is-pulsing', (els) => els.map((el) => el.getAttribute('class')));
    assert(pulsing.length === 1 && pulsing[0].includes(sfClass) && pulsing[0].includes('observed'), 'pulsing: ' + pulsing.join(' | '));
    await page.waitForFunction(() => !document.querySelector('path.is-pulsing'), null, { timeout: 4000 });
  });

  await step('no page errors', async () => {
    assert(errors.length === 0, errors.join(' | '));
  });

  await page.evaluate(() => { localStorage.removeItem('meshcore-map-scope-contours'); localStorage.removeItem('live-scope-contours'); });
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
