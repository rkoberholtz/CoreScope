/**
 * E2E: region contours (scope-contours.js) on the map and live
 * pages.
 *
 * Each region scope gets a schematic area: an octagon of a fixed radius
 * round every node seen carrying its traffic (transported_scopes) or
 * configured for it (default_scope, configured_scope, declared_regions), and
 * a thin band between two of them that hear each other (the neighbor
 * graph). Nothing is drawn between members with no known link.
 * Clicking inside an area lists each scope's repeaters. The "Region contours" toggle draws them,
 * ?contours=1 deep-links them, the Region Scope picker narrows them to one
 * scope, a per-scope list shows and hides them (?contoursHide=), hovering
 * names every scope under the cursor on both pages (the live map draws
 * canvases above the areas), and the areas never take pointer events.
 * On the live page a scope's area flashes when one of its packets arrives.
 * mapDefaults.contours sets the radius, the band width and a repeater's own
 * radius.
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
  // In view at the test zoom: Leaflet leaves an off-screen outline's path empty.
  // Seen carrying #bay before its list dropped it: the list wins, so it is
  // not a #bay member (carriedScopes).
  { public_key: pk('a4'), name: 'Daly South', role: 'repeater', lat: 37.74, lon: -122.30, last_seen: now, hash_size: 1, declared_regions: ['south-bay'], transported_scopes: ['#bay'] },
  { public_key: pk('a5'), name: 'SF Default', role: 'repeater', lat: 37.76, lon: -122.44, last_seen: now, hash_size: 1, default_scope: '#sf', transported_scopes: ['#sf'] },
];
// Two known links. SF Two ↔ Oakland, about 11.6 km: their 4 km octagons do
// not meet, so #bay gets a band between them. SF One ↔ SF Default, about
// 2.1 km. Nothing links SF Two to either, so #sf is two groups,
// [SF One, SF Default] and [SF Two].
const EDGES = [
  { source: pk('a2'), target: pk('a3'), weight: 12, score: 0.8, bidirectional: true, heard_by_source: 3, heard_by_target: 3, avg_snr: 4, ambiguous: false },
  { source: pk('a1'), target: pk('a5'), weight: 20, score: 0.9, bidirectional: true, heard_by_source: 3, heard_by_target: 3, avg_snr: 8, ambiguous: false },
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
  let graphCalls = 0;

  console.log(`\n=== Region contours E2E against ${BASE} ===`);

  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/nodes') return json({ nodes: NODES, total: NODES.length, has_more: false, counts: { repeaters: NODES.length, rooms: 0, companions: 0, sensors: 0 } });
    if (path === '/api/analytics/neighbor-graph') { graphCalls++; return json({ nodes: [], edges: EDGES, stats: {} }); }
    if (path === '/api/observers') return json({ observers: [] });
    if (path === '/api/packets') return json({ packets: [], total: 0 });
    if (path === '/api/config/map') return json({ center: [37.785, -122.35], zoom: 11 });
    return json({});
  });

  // One entry per scope drawn: each is two paths, a fill and an outline.
  const areas = () => page.$$eval('path.mc-scope-area', (els) => {
    const seen = new Map();
    els.forEach((el) => { const s = el.getAttribute('data-scope'); if (!seen.has(s)) seen.set(s, el.getAttribute('class')); });
    return Array.from(seen.values());
  });
  const pathsPerScope = () => page.$$eval('path.mc-scope-area', (els) => {
    const out = {};
    els.forEach((el) => { const s = el.getAttribute('data-scope'); out[s] = (out[s] || 0) + 1; });
    return out;
  });
  // A scope's colour, from its swatch in the scope list of the page in view.
  const colourOf = (scope) => page.evaluate((s) => {
    const box = Array.from(document.querySelectorAll('.mc-scope-row input')).find((el) => el.getAttribute('data-scope') === s && el.offsetParent);
    const sw = box && box.nextElementSibling;
    return sw ? (sw.className.match(/mc-reach-c\d/) || [''])[0] : 'no swatch for ' + s;
  }, scope);
  const fillOf = (scope) => 'path.mc-scope-fill[data-scope="' + scope + '"]';
  const lineOf = (scope) => 'path.mc-scope-line[data-scope="' + scope + '"]';
  // A screen point well inside every listed scope's area: it and the
  // points 4 px around it pass the SVG fill path's own
  // fill test, since Leaflet simplifies the drawn path by about a pixel and
  // the edge is where drawing and hit test may differ. The outlines take no
  // pointer events, so elementsFromPoint cannot do this. Never on a node
  // marker, whose clicks are the node's.
  const pointInside = (scopes) => page.evaluate((list) => {
    const paths = list.map((s) => document.querySelector('path.mc-scope-fill[data-scope="' + s + '"]'));
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
    localStorage.removeItem('meshcore-scope-contours-view');
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

  // Whether a point is inside a scope's drawn area, by the SVG fill path's
  // own fill test at the point's screen position.
  const insideAt = (scope, lat, lon, p = page) => p.evaluate(({ sel, lat, lon }) => {
    const el = document.querySelector(sel); if (!el) return null;
    const m = window.__mc_map, pt = m.latLngToContainerPoint([lat, lon]);
    const box = m.getContainer().getBoundingClientRect();
    return el.isPointInFill(new DOMPoint(box.left + pt.x, box.top + pt.y).matrixTransform(el.getScreenCTM().inverse()));
  }, { sel: fillOf(scope), lat, lon });
  // Links arrive after the first draw: wait until a point is inside (or outside).
  const waitInside = (scope, lat, lon, want = true, p = page) => p.waitForFunction(({ sel, lat, lon, want }) => {
    const el = document.querySelector(sel); if (!el) return false;
    const m = window.__mc_map, pt = m.latLngToContainerPoint([lat, lon]);
    const box = m.getContainer().getBoundingClientRect();
    return el.isPointInFill(new DOMPoint(box.left + pt.x, box.top + pt.y).matrixTransform(el.getScreenCTM().inverse())) === want;
  }, { sel: fillOf(scope), lat, lon, want }, { timeout: 10000 });
  // 1 km east/west and north/south at this latitude, in degrees.
  const KM_LON = 1 / (111.32 * Math.cos(37.79 * Math.PI / 180));
  const KM_LAT = 1 / 111.32;

  await step('the toggle draws one area per scope, a fill and an outline, a configured-only one too', async () => {
    await page.click('#mcScopeContours');
    await page.waitForSelector('path.mc-scope-area');
    const cls = await areas();
    assert(cls.length === 3, 'areas: ' + cls.join(' | '));
    assert(cls.every((c) => !/observed|configured/.test(c)), 'a kind of area: ' + cls.join(' | '));
    const per = await pathsPerScope();
    assert(per.sf === 2 && per.bay === 2 && per['south-bay'] === 2, 'paths per scope: ' + JSON.stringify(per));
    const style = await page.evaluate(({ fill, line }) => {
      const f = getComputedStyle(document.querySelector(fill)), l = getComputedStyle(document.querySelector(line));
      return { fillStroke: f.stroke, fillRule: f.fillRule, fillFill: f.fill, lineFill: l.fill, lineStroke: l.stroke, dash: l.strokeDasharray };
    }, { fill: fillOf('south-bay'), line: lineOf('south-bay') });
    assert(style.fillStroke === 'none', 'the fill is stroked, so overlapping shapes show their edges: ' + JSON.stringify(style));
    assert(style.fillRule === 'nonzero', 'overlapping shapes would cancel: ' + JSON.stringify(style));
    assert(style.lineFill === 'none', 'the outline is filled: ' + JSON.stringify(style));
    assert(style.dash === 'none', 'configured-only #south-bay drawn dashed: ' + style.dash);
    assert(style.lineStroke !== 'none' && style.lineStroke !== 'rgb(51, 136, 255)' && style.fillFill === style.lineStroke, 'not coloured by its CSS variable: ' + JSON.stringify(style));
  });

  await step('a repeater is a round-cornered octagon 4 km round it, and the list says the areas are schematic', async () => {
    // Daly South (37.74, -122.30) is #south-bay's only member.
    assert(await insideAt('south-bay', 37.74, -122.30 + 3 * KM_LON), '3 km east of Daly South is outside');
    assert(await insideAt('south-bay', 37.74 + 3 * KM_LAT, -122.30), '3 km north of Daly South is outside');
    assert(!(await insideAt('south-bay', 37.74, -122.30 + 4.5 * KM_LON)), '4.5 km east of Daly South is inside');
    assert(!(await insideAt('south-bay', 37.74 - 4.5 * KM_LAT, -122.30)), '4.5 km south of Daly South is inside');
    const d = await page.$eval(lineOf('south-bay'), (el) => el.getAttribute('d'));
    // Rounded corners: more than the eight points of a plain octagon.
    assert((d.match(/L/g) || []).length >= 16 && (d.match(/M/g) || []).length === 1, 'not one round-cornered outline: ' + d);
    const hint = await page.$eval('#mcScopeList .mc-scope-hint', (el) => el.textContent);
    assert(/Schematic, not measured coverage/.test(hint) && /octagon 4 km round every repeater/.test(hint), 'hint: ' + hint);
    assert(!/[Tt]errain|Convex|Detailed/.test(hint), 'the old model is described: ' + hint);
  });

  await step('a thin band joins two members that hear each other; the neighbor graph is fetched once', async () => {
    // SF Two and Oakland are linked, 11.6 km apart: midway between them is
    // inside #bay, which two 4 km octagons alone would not reach.
    await waitInside('bay', 37.795, -122.335);
    assert(graphCalls === 1, 'neighbor graph calls: ' + graphCalls);
    // A band, not an area: 2 km either side of it is empty.
    assert(!(await insideAt('bay', 37.795 + 2 * KM_LAT, -122.335)), '2 km north of the band is inside #bay');
    assert(!(await insideAt('bay', 37.795 - 2 * KM_LAT, -122.335)), '2 km south of the band is inside #bay');
    // #sf has no link from SF Two to Oakland's side: nothing of it out there.
    assert(!(await insideAt('sf', 37.795, -122.335)), '#sf drawn along a link that is not between its members');
  });

  await step('the choice is stored and written to the URL', async () => {
    assert(await page.evaluate(() => localStorage.getItem('meshcore-map-scope-contours')) === 'true', 'not stored');
    assert(/[?&]contours=1\b/.test(await page.evaluate(() => location.hash)), 'hash: ' + (await page.evaluate(() => location.hash)));
  });

  await step('areas sit under the markers and never take pointer events', async () => {
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
    assert(/#sf · 3 nodes · 2 separate groups/.test(text) && /#bay · 2 nodes/.test(text), 'tooltip: ' + text);
    assert(text.split('#sf').length === 2, 'a split scope named twice: ' + text);
    // The fill and the outline of each.
    assert((await page.$$('path.mc-scope-area.is-hovered')).length === 4, 'hovered areas not highlighted');
    await page.mouse.move(5, 450);
    await page.waitForFunction(() => !document.querySelector('.leaflet-tooltip.mc-scope-tip'), null, { timeout: 3000 });
  });

  await step('clicking inside an outline lists that scope\'s repeaters, configured first', async () => {
    const pt = await pointInside(['sf', 'bay']);
    assert(pt, 'no point inside #sf and #bay');
    await page.mouse.click(pt.x, pt.y);
    await page.waitForSelector('.leaflet-popup.mc-scope-popup', { timeout: 3000 });
    const text = await page.$eval('.mc-scope-popup', (el) => el.textContent.replace(/\s+/g, ' '));
    assert(/#sf 1 with known config · 3 seen carrying · 2 separate groups/.test(text) && /#bay 0 with known config · 2 seen carrying(?! ·)/.test(text), 'popup: ' + text);
    // Different lists, so a section each (scopes with the same list share one).
    const heads = await page.$$eval('.mc-scope-popup .mc-scope-pop-scope', (els) => els.map((el) => el.querySelectorAll('.mc-scope-pop-name').length));
    assert(heads.length === 2 && heads.every((n) => n === 1), 'sections: ' + JSON.stringify(heads));
    // Sorted by name: #bay, then #sf.
    assert(text.indexOf('#bay') < text.indexOf('#sf'), 'not sorted by name: ' + text);
    assert(!/Daly South/.test(text.split('#sf')[0]), 'stale carrying listed under #bay: ' + text);
    const sfPart = text.split('#sf')[1];
    assert(sfPart.indexOf('SF Default') < sfPart.indexOf('SF One'), 'configured repeater not listed first: ' + sfPart);
    assert(/SF Default\s*default\s*carrying/.test(text), 'tags: ' + text);
    const href = await page.$$eval('.mc-scope-popup .mc-scope-pop-scope', (els) => {
      const sf = els.find((el) => /#sf\b/.test(el.textContent));
      return sf && sf.querySelector('a').getAttribute('href');
    });
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
    await page.waitForFunction(() => new Set(Array.from(document.querySelectorAll('path.mc-scope-area'), (p) => p.getAttribute('data-scope'))).size === 2);
    assert(/[?&]contoursHide=bay\b/.test(await page.evaluate(() => location.hash)), 'hash: ' + (await page.evaluate(() => location.hash)));
    assert(await page.evaluate(() => localStorage.getItem('meshcore-scope-contours-hidden')) === '["bay"]', 'not stored');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('path.mc-scope-area');
    assert((await areas()).length === 2, 'hidden scope came back after reload');
    assert(!(await page.$eval('#mcScopeList input[data-scope="bay"]', (el) => el.checked)), 'bay row checked after reload');
  });

  await step('None hides every scope; All brings them back', async () => {
    await page.click('#mcScopeList [data-scope-none]');
    await page.waitForFunction(() => new Set(Array.from(document.querySelectorAll('path.mc-scope-area'), (p) => p.getAttribute('data-scope'))).size === 0);
    await page.click('#mcScopeList [data-scope-all]');
    await page.waitForFunction(() => new Set(Array.from(document.querySelectorAll('path.mc-scope-area'), (p) => p.getAttribute('data-scope'))).size === 3);
    assert(!/contoursHide/.test(await page.evaluate(() => location.hash)), 'contoursHide left in the URL');
  });

  await step('the Region Scope picker narrows the outlines to one scope', async () => {
    await page.waitForSelector('#mcRegionFilter option[value="south-bay"]', { state: 'attached' });
    await page.selectOption('#mcRegionFilter', 'south-bay');
    await page.waitForFunction(() => new Set(Array.from(document.querySelectorAll('path.mc-scope-area'), (p) => p.getAttribute('data-scope'))).size === 1);
    assert((await areas())[0].includes(await colourOf('south-bay')), (await areas()).join(' | '));
    await page.selectOption('#mcRegionFilter', '');
    await page.waitForFunction(() => new Set(Array.from(document.querySelectorAll('path.mc-scope-area'), (p) => p.getAttribute('data-scope'))).size === 3);
  });

  await step('there is no shape picker, and an old ?contoursView= link still opens the overlay', async () => {
    assert(!(await page.$('#mcScopeView')), 'the area shape picker is still on the page');
    await page.goto(BASE + '/#/map?contours=1&contoursView=detailed', { waitUntil: 'load' });
    await page.waitForSelector('path.mc-scope-area');
    assert((await areas()).length === 3, 'areas: ' + (await areas()).join(' | '));
    assert(!(await page.$('#mcScopeView button')), 'a view button was drawn');
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
    assert(!legend.hidden && /#south-bay/.test(legend.text), 'legend list: ' + JSON.stringify(legend));
    assert(/^\s*REGION SCOPES/.test(legend.text), 'no heading above the list: ' + legend.text.slice(0, 60));
    assert(!(await page.$('#liveScopeView')), 'the area shape picker is still in the legend');
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
    assert(/#sf · 3 nodes/.test(text), 'tooltip: ' + text + ' (top element ' + top + ')');
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
    // #sf's fill and outline, and nothing else.
    assert(pulsing.length === 2 && pulsing.every((c) => c.includes(sfClass)), 'pulsing: ' + pulsing.join(' | '));
    await page.waitForFunction(() => !document.querySelector('path.is-pulsing'), null, { timeout: 4000 });
  });

  await step('live: the legend\'s scope checkboxes and All work (the legend itself takes no clicks)', async () => {
    await page.click('#liveScopeList input[data-scope="sf"]');
    await page.waitForFunction(() => new Set(Array.from(document.querySelectorAll('path.mc-scope-area'), (p) => p.getAttribute('data-scope'))).size === 2, null, { timeout: 3000 });
    await page.click('#liveScopeList [data-scope-all]');
    await page.waitForFunction(() => new Set(Array.from(document.querySelectorAll('path.mc-scope-area'), (p) => p.getAttribute('data-scope'))).size === 3, null, { timeout: 3000 });
  });

  // Bay Edge: configured for #bay, not seen carrying it, 20 km south of
  // Oakland and clear of the map's control panel.
  const BAY_EDGE = { public_key: pk('a6'), name: 'Bay Edge', role: 'repeater', lat: 37.62, lon: -122.25, last_seen: now, hash_size: 1, default_scope: '#bay' };
  // 2 km south of Bay Edge; a point on the line to Oakland, 4.1 km north of
  // Bay Edge, just past its octagon; 5 km east of Oakland.
  const SOUTH = [37.62 - 2 * KM_LAT, -122.25], GAP = [37.657, -122.255], OAK_EAST = [37.80, -122.27 + 5 * KM_LON];
  const bayEdgePage = async (edges, contours) => {
    const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p3 = await ctx3.newPage();
    p3.on('pageerror', (e) => errors.push(e.message));
    const nodes = NODES.concat([BAY_EDGE]);
    await p3.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/nodes') return json({ nodes, total: nodes.length, has_more: false, counts: {} });
      if (path === '/api/analytics/neighbor-graph') return json({ nodes: [], edges, stats: {} });
      if (path === '/api/config/map') return json(Object.assign({ center: [37.785, -122.35], zoom: 11 }, contours ? { contours } : {}));
      return json({});
    });
    await p3.goto(BASE + '/#/map?contours=1', { waitUntil: 'load' });
    await p3.waitForSelector(fillOf('bay'));
    // The links have arrived once the SF Two - Oakland band is drawn.
    await waitInside('bay', 37.795, -122.335, true, p3);
    const screen = (ll) => p3.evaluate(([lat, lon]) => {
      const m = window.__mc_map, box = m.getContainer().getBoundingClientRect(), c = m.latLngToContainerPoint([lat, lon]);
      const top = document.elementFromPoint(box.left + c.x, box.top + c.y);
      return { x: box.left + c.x, y: box.top + c.y, onMap: !!(top && top.closest('#leaflet-map')) };
    }, ll);
    const inside = (ll) => insideAt('bay', ll[0], ll[1], p3);
    return { ctx3, p3, screen, inside };
  };

  await step('a configured repeater with no link to the rest of its scope gets its octagon; the gap is not drawn', async () => {
    const { ctx3, p3, screen, inside } = await bayEdgePage(EDGES);
    assert(await inside(SOUTH), 'Bay Edge has no area round it');
    assert(!(await inside(GAP)), 'the unlinked gap is drawn');
    const pt = await screen(SOUTH);
    assert(pt.onMap, 'probe point is under a control: ' + JSON.stringify(pt));
    await p3.mouse.move(pt.x, pt.y);
    await p3.waitForSelector('.leaflet-tooltip.mc-scope-tip', { timeout: 3000 });
    const text = await p3.$eval('.leaflet-tooltip.mc-scope-tip', (el) => el.textContent);
    assert(/^#bay · 3 nodes · 2 separate groups$/.test(text.trim()), 'tooltip: ' + text);
    await ctx3.close();
  });

  await step('linked to Oakland, a band crosses the gap and #bay is one group', async () => {
    const link = { source: pk('a3'), target: pk('a6'), weight: 6, score: 0.6, bidirectional: false, heard_by_source: 0, heard_by_target: 3, avg_snr: 2, ambiguous: false };
    const { ctx3, p3, screen, inside } = await bayEdgePage(EDGES.concat([link]));
    assert(await inside(SOUTH), 'Bay Edge has no area round it');
    assert(await inside(GAP), 'no band across the linked gap');
    assert(!(await inside([GAP[0], GAP[1] - 2 * KM_LON])), 'the band is as wide as an area: 2 km off the line is inside');
    const pt = await screen(SOUTH);
    await p3.mouse.move(pt.x, pt.y);
    await p3.waitForSelector('.leaflet-tooltip.mc-scope-tip', { timeout: 3000 });
    const text = await p3.$eval('.leaflet-tooltip.mc-scope-tip', (el) => el.textContent);
    assert(/^#bay · 3 nodes$/.test(text.trim()), 'tooltip: ' + text);
    await ctx3.close();
  });

  await step('mapDefaults.contours sets the radius and a repeater\'s own, and the list says so', async () => {
    // 1.5 km for everyone, 6 km for Oakland (by a prefix of its key).
    const { ctx3, p3, inside } = await bayEdgePage(EDGES, { radiusKm: 1.5, radii: { [pk('a3').slice(0, 12)]: 6 } });
    const hint = await p3.$eval('#mcScopeList .mc-scope-hint', (el) => el.textContent);
    assert(/octagon 1\.5 km round every repeater/.test(hint), 'hint: ' + hint);
    assert(!(await inside(SOUTH)), '2 km south of Bay Edge is inside a 1.5 km octagon');
    assert(await inside([37.62 - 1 * KM_LAT, -122.25]), '1 km south of Bay Edge is outside');
    assert(await inside(OAK_EAST), '5 km east of Oakland is outside its own 6 km octagon');
    await ctx3.close();
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
