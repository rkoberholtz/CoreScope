/**
 * E2E: region scope reach contours (scope-contours.js) on the map and live
 * pages.
 *
 * Each region scope gets an outline of the area its nodes are proven to reach,
 * following their two-way links (the neighbor graph): solid for nodes seen
 * carrying its traffic (transported_scopes), dashed for nodes configured for
 * it (default_scope, configured_scope, declared_regions) but not carrying it.
 * Clicking inside outlines lists each scope's repeaters. The "Reach contours" toggle draws them,
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
const zlib = require('zlib');

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
  // In view at the test zoom: Leaflet leaves an off-screen outline's path empty.
  { public_key: pk('a4'), name: 'Daly South', role: 'repeater', lat: 37.74, lon: -122.30, last_seen: now, hash_size: 1, declared_regions: ['south-bay'] },
  { public_key: pk('a5'), name: 'SF Default', role: 'repeater', lat: 37.76, lon: -122.44, last_seen: now, hash_size: 1, default_scope: '#sf', transported_scopes: ['#sf'] },
];
// Terrain: flat 50 m with a 150 m ridge, 300 m wide, running north-south
// about 1 km west of SF Default. Served as Terrarium PNGs in place of AWS
// Terrain Tiles, so the test needs no network and knows the answer.
const RIDGE_LON = -122.4514, RIDGE_HALF = 0.0017;
function terrariumPng(z, x, y) {
  const n = Math.pow(2, z), W = 256;
  const raw = Buffer.alloc((W * 3 + 1) * W);
  for (let py = 0; py < W; py++) {
    raw[py * (W * 3 + 1)] = 0;
    for (let px = 0; px < W; px++) {
      const lon = (x + (px + 0.5) / W) / n * 360 - 180;
      const elev = Math.abs(lon - RIDGE_LON) < RIDGE_HALF ? 150 : 50;
      const v = elev + 32768, o = py * (W * 3 + 1) + 1 + px * 3;
      raw[o] = Math.floor(v / 256); raw[o + 1] = Math.floor(v) % 256; raw[o + 2] = Math.round((v % 1) * 256);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TILE_GLOB = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/**';
function serveTiles(page, mode) {
  return page.route(TILE_GLOB, (route) => {
    if (mode === 'fail') return route.fulfill({ status: 503, body: 'down' });
    const m = route.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
    route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: terrariumPng(+m[1], +m[2], +m[3]) });
  });
}

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

  await serveTiles(page, 'ok');
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/nodes') return json({ nodes: NODES, total: NODES.length, has_more: false, counts: { repeaters: NODES.length, rooms: 0, companions: 0, sensors: 0 } });
    if (path === '/api/analytics/neighbor-graph') { graphCalls++; return json({ nodes: [], edges: EDGES, stats: {} }); }
    if (path === '/api/observers') return json({ observers: [] });
    if (path === '/api/packets') return json({ packets: [], total: 0 });
    // Close enough that a 1.5 km floor circle is ~50 px across, so hover and
    // click points can sit well inside the narrow 32-sector lobes.
    if (path === '/api/config/map') return json({ center: [37.785, -122.35], zoom: 11, antennaHeights: { [pk('a1').slice(0, 12)]: 30 } });
    return json({});
  });

  const areas = () => page.$$eval('path.mc-scope-area', (els) => els.map((el) => el.getAttribute('class')));
  const colourOf = (scope) => page.evaluate((s) => 'mc-reach-c' + window.ScopeContours.colorIndex(s), scope);
  const outline = (scope) => 'path.mc-scope-area[data-scope="' + scope + '"]';
  // A screen point well inside every listed scope's outline (and outside
  // their holes): it and the points 4 px around it pass the SVG path's own
  // fill test, since Leaflet simplifies the drawn path by about a pixel and
  // the edge is where drawing and hit test may differ. The outlines take no
  // pointer events, so elementsFromPoint cannot do this. Never on a node
  // marker, whose clicks are the node's.
  const pointInside = (scopes) => page.evaluate((list) => {
    const paths = list.map((s) => document.querySelector('path.mc-scope-area[data-scope="' + s + '"]'));
    if (paths.some((p) => !p)) return null;
    const inFill = (p, x, y) => p.isPointInFill(new DOMPoint(x, y).matrixTransform(p.getScreenCTM().inverse()));
    const r = paths[0].getBoundingClientRect();
    for (let y = r.top + 1; y < r.bottom; y += 3) {
      for (let x = r.left + 1; x < r.right; x += 3) {
        const around = [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]];
        if (!paths.every((p) => around.every(([dx, dy]) => inFill(p, x + dx, y + dy)))) continue;
        const top = document.elementFromPoint(x, y);
        if (top && top.closest('.leaflet-marker-icon')) continue;
        return { x, y };
      }
    }
    return null;
  }, scopes);

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

  await step('the toggle draws solid outlines for carried scopes and a dashed one for configured-only', async () => {
    await page.click('#mcScopeContours');
    await page.waitForSelector('path.mc-scope-area');
    const cls = await areas();
    assert(cls.filter((c) => c.includes('mc-scope-area-observed')).length === 2, 'observed outlines: ' + cls.join(' | '));
    assert(cls.filter((c) => c.includes('mc-scope-area-configured')).length === 1, 'configured outlines: ' + cls.join(' | '));
    // Terrain answers re-draw the outlines as they arrive; read a path that
    // is still in the page.
    const dash = await page.waitForFunction(() => {
      const el = document.querySelector('path.mc-scope-area-configured');
      const v = el && el.isConnected ? getComputedStyle(el).strokeDasharray : '';
      return v && v !== 'none' ? v : false;
    }, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => '');
    assert(dash && dash !== 'none', 'configured-only outline is not dashed: ' + dash);
    const stroke = await page.waitForFunction(() => {
      const el = document.querySelector('path.mc-scope-area-observed');
      const v = el && el.isConnected ? getComputedStyle(el).stroke : '';
      return v && v !== 'none' ? v : false;
    }, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => '');
    assert(stroke && stroke !== 'none' && stroke !== 'rgb(51, 136, 255)', 'outline not coloured by its CSS variable: ' + stroke);
  });

  await step('the outlines follow the neighbor graph, fetched once', async () => {
    assert(graphCalls === 1, 'neighbor graph calls: ' + graphCalls);
    // SF Two and Oakland are linked: a point midway between them is inside
    // #bay's outline, which two 1.5 km floor circles would never reach.
    const mid = await page.evaluate((sel) => {
      const p = document.querySelector(sel);
      const m = window.__mc_map, pt = m.latLngToContainerPoint([37.795, -122.335]);
      const box = m.getContainer().getBoundingClientRect();
      const q = new DOMPoint(box.left + pt.x, box.top + pt.y).matrixTransform(p.getScreenCTM().inverse());
      return p.isPointInFill(q);
    }, outline('bay'));
    assert(mid, 'the #bay outline does not follow the SF Two - Oakland link');
  });

  // Whether a point is inside a scope's drawn outline, by the SVG path's own
  // fill test at the point's screen position.
  const insideAt = (scope, lat, lon) => page.evaluate(({ sel, lat, lon }) => {
    const p = document.querySelector(sel); if (!p) return null;
    const m = window.__mc_map, pt = m.latLngToContainerPoint([lat, lon]);
    const box = m.getContainer().getBoundingClientRect();
    return p.isPointInFill(new DOMPoint(box.left + pt.x, box.top + pt.y).matrixTransform(p.getScreenCTM().inverse()));
  }, { sel: outline(scope), lat, lon });
  // 1 km east/west at this latitude, in degrees of longitude.
  const KM_LON = 1 / (111.32 * Math.cos(37.79 * Math.PI / 180));

  await step('terrain trims the outline behind the ridge and leaves the open side alone', async () => {
    // SF Two (37.79, -122.40): radius ~12.8 km from its 11.6 km link. The
    // ridge is ~4.5 km west of it: 6 km west is in its shadow, 8 km east is
    // open ground. Terrain arrives after the first draw, so wait for it.
    await page.waitForFunction(({ sel, lon }) => {
      const p = document.querySelector(sel); if (!p) return false;
      const m = window.__mc_map, pt = m.latLngToContainerPoint([37.79, lon]), box = m.getContainer().getBoundingClientRect();
      return !p.isPointInFill(new DOMPoint(box.left + pt.x, box.top + pt.y).matrixTransform(p.getScreenCTM().inverse()));
    }, { sel: outline('sf'), lon: -122.40 - 6 * KM_LON }, { timeout: 10000 });
    assert(await insideAt('sf', 37.79, -122.40 + 8 * KM_LON), '8 km east of SF Two is outside #sf');
    assert(!(await insideAt('sf', 37.79, -122.40 - 6 * KM_LON)), '6 km west, behind the ridge, is inside #sf');
    const hint = await page.$eval('#mcScopeList', (el) => el.textContent);
    assert(/AWS Terrain Tiles/.test(hint) && !/Terrain unavailable/.test(hint), 'hint: ' + hint);
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
    const pt = await pointInside(['sf', 'bay']);
    assert(pt, 'no point inside both #sf and #bay');
    await page.mouse.move(pt.x, pt.y);
    await page.waitForSelector('.leaflet-tooltip.mc-scope-tip', { timeout: 3000 });
    const text = await page.$eval('.leaflet-tooltip.mc-scope-tip', (el) => el.textContent);
    assert(/#sf · carried by 3 nodes/.test(text) && /#bay · carried by 2 nodes/.test(text), 'tooltip: ' + text);
    assert((await page.$$('path.mc-scope-area.is-hovered')).length === 2, 'hovered outlines not highlighted');
    await page.mouse.move(5, 450);
    await page.waitForFunction(() => !document.querySelector('.leaflet-tooltip.mc-scope-tip'), null, { timeout: 3000 });
  });

  await step('clicking inside an outline lists that scope\'s repeaters, configured first', async () => {
    const pt = await pointInside(['sf', 'bay']);
    assert(pt, 'no point inside #sf and #bay');
    await page.mouse.click(pt.x, pt.y);
    await page.waitForSelector('.leaflet-popup.mc-scope-popup', { timeout: 3000 });
    const text = await page.$eval('.mc-scope-popup', (el) => el.textContent.replace(/\s+/g, ' '));
    assert(/#sf 1 configured · 3 carrying/.test(text) && /#bay 0 configured · 2 carrying/.test(text), 'popup: ' + text);
    const sfPart = text.split('#bay')[0].split('#sf')[1] || text;
    assert(sfPart.indexOf('SF Default') < sfPart.indexOf('SF One'), 'configured repeater not listed first: ' + sfPart);
    assert(/SF Default\s*default\s*carrying/.test(text), 'tags: ' + text);
    // Mast heights the terrain model used: SF One's is set in config (by a
    // 12-char prefix); SF Two's link to Oakland crosses flat ground, which
    // needs no more than the assumed 10 m.
    assert(/SF One\s*carrying\s*30 m mast \(set\)/.test(text), 'set mast: ' + text);
    assert(/SF Two\s*carrying\s*10 m mast/.test(text), 'assumed mast: ' + text);
    const href = await page.$eval('.mc-scope-popup a', (a) => a.getAttribute('href'));
    assert(href === '#/nodes/' + encodeURIComponent('a5' + '0'.repeat(62)), 'link: ' + href);
    assert(!(await page.$('.leaflet-tooltip.mc-scope-tip')), 'hover tooltip over the popup');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.mc-scope-popup'), null, { timeout: 3000 });
  });

  await step('clicking a node marker inside an outline does not open the scope box', async () => {
    await page.click('.leaflet-marker-icon');
    await page.waitForTimeout(500);
    assert(!(await page.$('.mc-scope-popup')), 'scope box opened for a marker click');
    await page.keyboard.press('Escape');
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
    assert((await areas())[0].includes('mc-scope-area-configured'), (await areas()).join(' | '));
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
    await page.goto(BASE + '/#/live?contours=1&lat=37.785&lon=-122.35&zoom=11', { waitUntil: 'load' });
    await page.waitForSelector('#liveMap');
    await page.waitForSelector('path.mc-scope-area');
    assert(await page.$eval('#liveScopeContoursToggle', (el) => el.checked), 'live toggle unchecked');
    assert((await areas()).length === 3, 'live outlines: ' + (await areas()).join(' | '));
    const legend = await page.$eval('#liveScopeList', (el) => ({ hidden: el.hidden, text: el.textContent }));
    assert(!legend.hidden && /REGION SCOPES/.test(legend.text) && /#south-bay/.test(legend.text), 'legend list: ' + JSON.stringify(legend));
  });

  await step('live: hovering works through the canvases above the outlines', async () => {
    const pt = await pointInside(['sf']);
    assert(pt, 'no point inside #sf');
    // Something other than the outline is on top there: the canvas renderer
    // or the heat map. The hover must not depend on the outline's events.
    const top = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el && el.tagName; }, pt);
    await page.mouse.move(pt.x, pt.y);
    await page.waitForSelector('.leaflet-tooltip.mc-scope-tip', { timeout: 3000 });
    const text = await page.$eval('.leaflet-tooltip.mc-scope-tip', (el) => el.textContent);
    assert(/#sf · carried by 3 nodes/.test(text), 'tooltip: ' + text + ' (top element ' + top + ')');
  });

  await step('live: clicking inside an outline lists its repeaters', async () => {
    const pt = await pointInside(['sf']);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForSelector('.leaflet-popup.mc-scope-popup', { timeout: 3000 });
    const text = await page.$eval('.mc-scope-popup', (el) => el.textContent);
    assert(/#sf/.test(text) && /SF Default/.test(text), 'popup: ' + text);
    await page.keyboard.press('Escape');
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

  await step('when elevation tiles fail, outlines fall back to radius + links and say so', async () => {
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => errors.push(e.message));
    await serveTiles(p2, 'fail');
    await p2.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/nodes') return json({ nodes: NODES, total: NODES.length, has_more: false, counts: {} });
      if (path === '/api/analytics/neighbor-graph') return json({ nodes: [], edges: EDGES, stats: {} });
      if (path === '/api/config/map') return json({ center: [37.785, -122.35], zoom: 11 });
      return json({});
    });
    await p2.goto(BASE + '/#/map?contours=1', { waitUntil: 'load' });
    await p2.waitForSelector('path.mc-scope-area[data-scope="sf"]');
    await p2.waitForFunction(() => /Terrain unavailable/.test((document.getElementById('mcScopeList') || {}).textContent || ''), null, { timeout: 10000 });
    const westInside = await p2.evaluate(({ lon }) => {
      const p = document.querySelector('path.mc-scope-area[data-scope="sf"]');
      const m = window.__mc_map, pt = m.latLngToContainerPoint([37.79, lon]), box = m.getContainer().getBoundingClientRect();
      return p.isPointInFill(new DOMPoint(box.left + pt.x, box.top + pt.y).matrixTransform(p.getScreenCTM().inverse()));
    }, { lon: -122.40 - 6 * KM_LON });
    assert(westInside, 'without terrain, 6 km west of SF Two should be inside its 12.8 km radius');
    await ctx2.close();
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
