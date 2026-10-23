/**
 * E2E: region scope reach contours (scope-contours.js) on the map and live
 * pages.
 *
 * Each region scope gets an outline of the area its nodes are proven to reach,
 * following their direct links (the neighbor graph): solid for nodes seen
 * carrying its traffic (transported_scopes), dashed for nodes that only
 * declare it (declared_regions). The "Reach contours" toggle draws them,
 * ?contours=1 deep-links them, the Region Scope picker narrows them to one
 * scope, a per-scope list shows and hides them (?contoursHide=), hovering
 * names every scope under the cursor on both pages (the live map draws
 * canvases above the outlines), and the outlines never take pointer events.
 * On the live page a scope's outline flashes when one of its packets arrives.
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
// One proven link: SF Two ↔ Oakland, about 11.6 km. #bay's outline follows
// it into one lobed shape instead of two separate floor circles.
const EDGES = [{ source: pk('a2'), target: pk('a3'), weight: 12, score: 0.8, bidirectional: true, avg_snr: 4, ambiguous: false }];

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
  let graphCalls = 0;

  console.log(`\n=== Region scope reach contours E2E against ${BASE} ===`);

  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/nodes') return json({ nodes: NODES, total: NODES.length, has_more: false, counts: { repeaters: NODES.length, rooms: 0, companions: 0, sensors: 0 } });
    if (path === '/api/analytics/neighbor-graph') { graphCalls++; return json({ nodes: [], edges: EDGES, stats: {} }); }
    if (path === '/api/observers') return json({ observers: [] });
    if (path === '/api/packets') return json({ packets: [], total: 0 });
    if (path === '/api/config/map') return json({ center: [37.6, -122.2], zoom: 9 });
    return json({});
  });

  const areas = () => page.$$eval('path.mc-scope-area', (els) => els.map((el) => el.getAttribute('class')));
  const colourOf = (scope) => page.evaluate((s) => 'mc-reach-c' + window.ScopeContours.colorIndex(s), scope);
  // A screen point inside every outline with one of these colour classes
  // (and outside the others' holes), found with the SVG path's own fill
  // test. The outlines take no pointer events, so elementsFromPoint cannot.
  const pointInside = (classes) => page.evaluate((cls) => {
    const paths = cls.map((c) => document.querySelector('path.mc-scope-area.' + c));
    if (paths.some((p) => !p)) return null;
    const inFill = (p, x, y) => {
      const m = p.getScreenCTM().inverse();
      const q = new DOMPoint(x, y).matrixTransform(m);
      return p.isPointInFill(q);
    };
    const r = paths[0].getBoundingClientRect();
    for (let y = r.top + 1; y < r.bottom; y += 3) {
      for (let x = r.left + 1; x < r.right; x += 3) {
        if (paths.every((p) => inFill(p, x, y))) return { x, y };
      }
    }
    return null;
  }, classes);

  await page.goto(BASE + '/#/map', { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => {
    localStorage.removeItem('meshcore-map-scope-contours');
    localStorage.removeItem('meshcore-scope-contours-hidden');
    localStorage.setItem('meshcore-map-clustering', 'false');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#leaflet-map');
  await page.waitForSelector('.leaflet-marker-icon');

  await step('off by default: no outlines, no list, no neighbor-graph fetch', async () => {
    assert(!(await page.$eval('#mcScopeContours', (el) => el.checked)), 'toggle checked by default');
    assert((await areas()).length === 0, 'outlines drawn while off');
    assert(await page.$eval('#mcScopeList', (el) => el.hidden), 'scope list shown while off');
    assert(graphCalls === 0, 'neighbor graph fetched while off: ' + graphCalls);
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

  await step('the outlines follow the neighbor graph, fetched once', async () => {
    assert(graphCalls === 1, 'neighbor graph calls: ' + graphCalls);
    // SF Two and Oakland are linked: a point midway between them is inside
    // #bay's outline, which two 1.5 km floor circles would never reach.
    const bay = await colourOf('bay');
    const mid = await page.evaluate((c) => {
      const p = document.querySelector('path.mc-scope-area.' + c);
      const m = window.__mc_map, pt = m.latLngToContainerPoint([37.795, -122.335]);
      const box = m.getContainer().getBoundingClientRect();
      const q = new DOMPoint(box.left + pt.x, box.top + pt.y).matrixTransform(p.getScreenCTM().inverse());
      return p.isPointInFill(q);
    }, bay);
    assert(mid, 'the #bay outline does not follow the SF Two - Oakland link');
  });

  await step('the choice is stored and written to the URL', async () => {
    assert(await page.evaluate(() => localStorage.getItem('meshcore-map-scope-contours')) === 'true', 'not stored');
    assert(/[?&]contours=1\b/.test(await page.evaluate(() => location.hash)), 'hash: ' + (await page.evaluate(() => location.hash)));
  });

  await step('outlines sit under the markers and never take pointer events', async () => {
    const z = await page.evaluate(() => ({
      c: Number(getComputedStyle(document.querySelector('.leaflet-mcScopeContours-pane')).zIndex),
      m: Number(getComputedStyle(document.querySelector('.leaflet-marker-pane')).zIndex),
    }));
    assert(z.c < z.m, 'contour pane ' + z.c + ' not under marker pane ' + z.m);
    const pe = await page.$$eval('path.mc-scope-area', (els) => els.map((el) => getComputedStyle(el).pointerEvents));
    assert(pe.every((v) => v === 'none'), 'pointer-events: ' + pe.join(','));
  });

  await step('hovering names every scope under the cursor', async () => {
    const sf = await colourOf('sf'), bay = await colourOf('bay');
    const pt = await pointInside(sf === bay ? [sf] : [sf, bay]);
    assert(pt, 'no point inside both #sf and #bay');
    await page.mouse.move(pt.x, pt.y);
    await page.waitForSelector('.leaflet-tooltip.mc-scope-tip', { timeout: 3000 });
    const text = await page.$eval('.leaflet-tooltip.mc-scope-tip', (el) => el.textContent);
    assert(/#sf · carried by 2 nodes/.test(text) && /#bay · carried by 2 nodes/.test(text), 'tooltip: ' + text);
    assert((await page.$$('path.mc-scope-area.is-hovered')).length === 2, 'hovered outlines not highlighted');
    await page.mouse.move(5, 450);
    await page.waitForFunction(() => !document.querySelector('.leaflet-tooltip.mc-scope-tip'), null, { timeout: 3000 });
  });

  await step('the scope list shows a row per scope with All / None', async () => {
    assert(!(await page.$eval('#mcScopeList', (el) => el.hidden)), 'list hidden while contours are on');
    const rows = await page.$$eval('#mcScopeList .mc-scope-row', (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
    assert(rows.length === 3 && rows[0].startsWith('#bay') && rows[2].startsWith('#south-bay'), 'rows: ' + rows.join(' | '));
  });

  await step('unchecking a scope hides it, stores it, and writes it to the URL', async () => {
    await page.uncheck('#mcScopeList input[data-scope="bay"]');
    await page.waitForFunction(() => document.querySelectorAll('path.mc-scope-area').length === 2);
    assert(/[?&]contoursHide=bay\b/.test(await page.evaluate(() => location.hash)), 'hash: ' + (await page.evaluate(() => location.hash)));
    assert(await page.evaluate(() => localStorage.getItem('meshcore-scope-contours-hidden')) === '["bay"]', 'not stored');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('path.mc-scope-area');
    assert((await areas()).length === 2, 'hidden scope came back after reload');
    assert(!(await page.$eval('#mcScopeList input[data-scope="bay"]', (el) => el.checked)), 'bay row checked after reload');
  });

  await step('None hides every scope; All brings them back', async () => {
    await page.click('#mcScopeList [data-scope-none]');
    await page.waitForFunction(() => document.querySelectorAll('path.mc-scope-area').length === 0);
    await page.click('#mcScopeList [data-scope-all]');
    await page.waitForFunction(() => document.querySelectorAll('path.mc-scope-area').length === 3);
    assert(!/contoursHide/.test(await page.evaluate(() => location.hash)), 'contoursHide left in the URL');
  });

  await step('the Region Scope picker narrows the outlines to one scope', async () => {
    await page.waitForSelector('#mcRegionFilter option[value="south-bay"]', { state: 'attached' });
    await page.selectOption('#mcRegionFilter', 'south-bay');
    await page.waitForFunction(() => document.querySelectorAll('path.mc-scope-area').length === 1);
    assert((await areas())[0].includes('mc-scope-area-declared'), (await areas()).join(' | '));
    await page.selectOption('#mcRegionFilter', '');
    await page.waitForFunction(() => document.querySelectorAll('path.mc-scope-area').length === 3);
  });

  await step('?contours=0 overrides the stored choice; ?contours=1&contoursHide= restores both', async () => {
    await page.goto(BASE + '/#/map?contours=0', { waitUntil: 'load' });
    await page.waitForSelector('.leaflet-marker-icon');
    assert(!(await page.$eval('#mcScopeContours', (el) => el.checked)), 'checked despite contours=0');
    assert((await areas()).length === 0, 'outlines drawn despite contours=0');
    await page.goto(BASE + '/#/map?contours=1&contoursHide=sf', { waitUntil: 'load' });
    await page.waitForSelector('path.mc-scope-area');
    assert(await page.$eval('#mcScopeContours', (el) => el.checked), 'unchecked despite contours=1');
    assert((await areas()).length === 2, 'contoursHide=sf not applied: ' + (await areas()).join(' | '));
    await page.click('#mcScopeList [data-scope-all]');
  });

  await step('the toggle off removes the outlines and the list', async () => {
    await page.click('#mcScopeContours');
    await page.waitForFunction(() => !document.querySelector('path.mc-scope-area'));
    assert(await page.$eval('#mcScopeList', (el) => el.hidden), 'list still shown');
    assert(!/[?&]contours=/.test(await page.evaluate(() => location.hash)), 'contours param left in the URL');
  });

  await step('live: ?contours=1 draws the outlines on the canvas map, with the list in the legend', async () => {
    await page.goto(BASE + '/#/live?contours=1', { waitUntil: 'load' });
    await page.waitForSelector('#liveMap');
    await page.waitForSelector('path.mc-scope-area');
    assert(await page.$eval('#liveScopeContoursToggle', (el) => el.checked), 'live toggle unchecked');
    assert((await areas()).length === 3, 'live outlines: ' + (await areas()).join(' | '));
    const legend = await page.$eval('#liveScopeList', (el) => ({ hidden: el.hidden, text: el.textContent }));
    assert(!legend.hidden && /REGION SCOPES/.test(legend.text) && /#south-bay/.test(legend.text), 'legend list: ' + JSON.stringify(legend));
  });

  await step('live: hovering works through the canvases above the outlines', async () => {
    const sf = await colourOf('sf');
    const pt = await pointInside([sf]);
    assert(pt, 'no point inside #sf');
    // Something other than the outline is on top there: the canvas renderer
    // or the heat map. The hover must not depend on the outline's events.
    const top = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el && el.tagName; }, pt);
    await page.mouse.move(pt.x, pt.y);
    await page.waitForSelector('.leaflet-tooltip.mc-scope-tip', { timeout: 3000 });
    const text = await page.$eval('.leaflet-tooltip.mc-scope-tip', (el) => el.textContent);
    assert(/#sf · carried by 2 nodes/.test(text), 'tooltip: ' + text + ' (top element ' + top + ')');
  });

  await step('live: a scoped packet flashes only its scope, and the flash ends', async () => {
    const sfClass = await colourOf('sf');
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

  await page.evaluate(() => {
    localStorage.removeItem('meshcore-map-scope-contours');
    localStorage.removeItem('live-scope-contours');
    localStorage.removeItem('meshcore-scope-contours-hidden');
    localStorage.removeItem('meshcore-map-clustering');
  });
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
