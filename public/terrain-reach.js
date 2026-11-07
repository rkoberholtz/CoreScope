/* Terrain path-loss reach for the region-scope contours (scope-contours.js).

   For a repeater, walk outward along 72 rays (every 5°) over an elevation
   model, and at each step work out the path loss to a receiver there: free
   space plus the loss behind the worst knife edge on the way (ITU-R P.526,
   earth curvature with k = 4/3). Each ray reaches the farthest step whose
   loss is within the repeater's budget, so a hilltop past a valley counts,
   and the shadow before it is drawn as reached.

   The budget is learned from the repeater's own known receptions: the 90th
   percentile of the loss over the paths to the nodes known to hear it, when
   at least two are known, else a default of 120 dB (the mesh-wide 75th
   percentile on one live mesh). Transmit power, antenna gain, a mast on a
   roof, the receivers' sensitivity: all of it lands in the budget, so none
   of it has to be known. A line-of-sight cut did worse than a plain circle
   the same size, because a fifth to almost half of the real links have no
   line of sight; the loss budget beat it (scripts/validate-reach.js).

   Elevation comes from AWS Terrain Tiles (Terrarium PNG, public, no key,
   CORS open) unless the operator names another Terrarium source or turns
   terrain off (mapDefaults.terrainTiles, setSource). Tiles are fetched only
   around the repeaters asked about, decoded once and kept in a small LRU.
   Results are cached in memory and in localStorage, keyed by repeater,
   position, radius, partners, source and model parameters, so a reload
   costs nothing. The persisted cache is capped by size as well as count:
   localStorage is about 5 MB per site, shared with every other CoreScope
   setting.

   Model: antennas 10 m above ground at both ends unless the operator sets
   them (mapDefaults.antennaHeights), 910 MHz, 120 m steps, out to 30 km.
   The terrain is bare earth: buildings and trees are not in it. The
   percentile, the default budget, the 30 km, the reach rule and the
   receiver height the reach is drawn for are settings (setParams, from
   mapDefaults.contours); the defaults caught the most known receptions,
   which are heard mostly by rooftop repeaters. */
(function () {
  'use strict';

  var ZOOM = 11;            // ~59 m per pixel at 40°N
  var TILE = 256;
  var RAYS = 72;
  var STEP_M = 120;         // two pixels: finer adds cost, not detail
  var MAX_REACH_M = 30000;
  var ANTENNA_M = 10;       // default, and the far end of every path
  var FREQ_HZ = 910e6;
  var LAMBDA_M = 299792458 / FREQ_HZ;
  var BUDGET_PCT = 0.9;
  var MIN_BUDGET_LINKS = 2;
  var DEFAULT_BUDGET_DB = 120;
  var LINK_MAX_M = 40000;   // longer links are not profiled (tiles)
  var K = 4 / 3;
  var EARTH_R = 6371008.8;
  var M_PER_DEG = 111320;
  var MAX_TILES = 64;       // decoded tiles held: 64 x 256 KB
  var MAX_ENTRIES = 500;    // persisted results, at most
  var MAX_CHARS = 600000;   // and at most this much of localStorage (~1 KB each)
  var STORE_KEY = 'meshcore-terrain-reach-v3';
  var PARAMS = 'z' + ZOOM + 'a' + ANTENNA_M + 'f' + FREQ_HZ + 's' + STEP_M + 'm' + MAX_REACH_M + 'p' + BUDGET_PCT + 'n' + MIN_BUDGET_LINKS + 'd' + DEFAULT_BUDGET_DB;
  var TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

  // tileOf returns fractional slippy-map tile coordinates of a point.
  function tileOf(lat, lon, z) {
    var n = Math.pow(2, z);
    var latR = lat * Math.PI / 180;
    return {
      fx: (lon + 180) / 360 * n,
      fy: (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n,
    };
  }

  // decodeTerrarium turns Terrarium RGBA pixels into metres:
  // R * 256 + G + B / 256 - 32768.
  function decodeTerrarium(rgba) {
    var out = new Float32Array(rgba.length / 4);
    for (var i = 0, j = 0; j < out.length; i += 4, j++) {
      out[j] = rgba[i] * 256 + rgba[i + 1] + rgba[i + 2] / 256 - 32768;
    }
    return out;
  }

  // knifeEdgeLoss is the loss behind one knife edge, in dB, for the
  // Fresnel-Kirchhoff parameter v (ITU-R P.526): none while the path clears
  // the edge by a good part of the first Fresnel zone, 6 dB grazing.
  function knifeEdgeLoss(v) {
    return v <= -0.78 ? 0 : 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) * (v - 0.1) + 1) + v - 0.1);
  }

  // freeSpaceLoss over d metres at FREQ_HZ, in dB.
  function freeSpaceLoss(d) {
    return 20 * Math.log10(d) + 20 * Math.log10(FREQ_HZ) - 147.55;
  }

  // worstV: the largest v over the ground points strictly between the ends
  // of a path. g holds ground heights at spacing step from the transmitter
  // (g[0]) to the receiver (g[k]), NaN where unknown (it obstructs nothing);
  // hA, hC are the antennas' absolute heights. The earth's bulge,
  // s(D - s)/2kR, raises each point. -Infinity with no point between.
  // The hot loop of the model, O(steps²) per ray: no global lookups in it
  // (sqrt is held locally, g[m] !== g[m] tests for NaN).
  var sqrt = Math.sqrt;
  function worstV(g, k, step, hA, hC) {
    var D = k * step, kR2 = 2 * K * EARTH_R, v = -Infinity, c = 2 * D / LAMBDA_M;
    for (var m = 1; m < k; m++) {
      var gm = g[m];
      if (gm !== gm) continue;
      var s = m * step, f = s / D;
      var h = gm + s * (D - s) / kR2 - (hA + (hC - hA) * f);
      var x = h * sqrt(c / (s * (D - s)));
      if (x > v) v = x;
    }
    return v;
  }

  function lossOver(g, k, step, hA, hC) {
    var v = worstV(g, k, step, hA, hC);
    return freeSpaceLoss(k * step) + (v > -Infinity ? knifeEdgeLoss(v) : 0);
  }

  // lossProfile walks one ray from (lat, lon) toward bearing (radians, 0 =
  // north, clockwise) and returns the path loss to a receiver at each step:
  // out[k] at k * STEP_M, out[0] = 0. sample(lat, lon) gives ground
  // elevation in metres, NaN where unknown; unknown ground adds no loss, and
  // an unknown receiver spot stands at the transmitter's ground height. The
  // receiver's antenna is rxM above its ground (ANTENNA_M when not given).
  // O(steps²): every receiver spot looks back over every point before it.
  function lossProfile(sample, lat, lon, bearing, maxM, antennaM, rxM) {
    var rx = rxM > 0 ? rxM : ANTENNA_M;
    var n = Math.floor(maxM / STEP_M), out = new Float32Array(n + 1);
    var dLat = Math.cos(bearing) / M_PER_DEG;
    var dLon = Math.sin(bearing) / (M_PER_DEG * Math.cos(lat * Math.PI / 180));
    var g = new Float64Array(n + 1);
    for (var k = 0; k <= n; k++) g[k] = sample(lat + k * STEP_M * dLat, lon + k * STEP_M * dLon);
    var g0 = isFinite(g[0]) ? g[0] : 0;
    var hA = g0 + (antennaM > 0 ? antennaM : ANTENNA_M);
    for (k = 1; k <= n; k++) out[k] = lossOver(g, k, STEP_M, hA, (isFinite(g[k]) ? g[k] : g0) + rx);
    return out;
  }

  // pathLoss of one link a → b ({ lat, lon }), the transmitter at a with
  // antennaM and the listener at b with rxM (each the default when not
  // given), on the same model. NaN when the ground at either end is unknown.
  function pathLoss(sample, a, b, antennaM, rxM) {
    var D = distM(a, b);
    var k = Math.max(1, Math.round(D / STEP_M)), step = D / k;
    var g = new Float64Array(k + 1);
    for (var m = 0; m <= k; m++) g[m] = sample(a.lat + (b.lat - a.lat) * m / k, a.lon + (b.lon - a.lon) * m / k);
    if (!isFinite(g[0]) || !isFinite(g[k]) || !(D > 0)) return NaN;
    return lossOver(g, k, step, g[0] + (antennaM > 0 ? antennaM : ANTENNA_M), g[k] + (rxM > 0 ? rxM : ANTENNA_M));
  }

  // budgetOf: how much loss a repeater's signal is known to survive, from
  // the nodes that heard it (links, [{ lat, lon, antennaM? }], within
  // LINK_MAX_M, each at its own antenna height when known): the pct
  // percentile (opts.pct, BUDGET_PCT by default) of the loss over their
  // paths, so one freak long link does not set it. A listener on a mast
  // modelled at 10 m would make its path look lossier than it was, and the
  // budget too big. With fewer than MIN_BUDGET_LINKS of them, opts.defaultDb
  // (DEFAULT_BUDGET_DB). { db, source: 'links' | 'default', links: how many
  // counted }.
  function budgetOf(sample, origin, antennaM, links, opts) {
    var pct = opts && opts.pct >= 0 && opts.pct <= 1 ? opts.pct : BUDGET_PCT;
    var dflt = opts && opts.defaultDb > 0 ? opts.defaultDb : DEFAULT_BUDGET_DB;
    var a = { lat: origin.lat, lon: origin.lon }, losses = [];
    (links || []).forEach(function (b) {
      if (!b || !(distM(a, b) <= LINK_MAX_M)) return;
      var l = pathLoss(sample, a, b, antennaM, b.antennaM);
      if (isFinite(l)) losses.push(l);
    });
    if (losses.length < MIN_BUDGET_LINKS) return { db: dflt, source: 'default', links: losses.length };
    losses.sort(function (x, y) { return x - y; });
    var f = pct * (losses.length - 1), i = Math.floor(f), t = f - i;
    var db = i + 1 < losses.length ? losses[i] + (losses[i + 1] - losses[i]) * t : losses[i];
    return { db: db, source: 'links', links: losses.length };
  }

  // reachOf: how far a loss profile stays within budget, in metres (0 for
  // none). rule 'farthest' (the default): the farthest step within budget,
  // the shadows short of it (behind a ridge before a hilltop) taken as
  // reached, since the contours draw one reach per bearing; it caught the
  // most real receptions on a live mesh. 'first': the last step before the
  // first one over budget, the hilltop beyond a shadow left out; more
  // conservative.
  function reachOf(profile, budget, rule) {
    var k;
    if (rule === 'first') {
      for (k = 1; k < profile.length && profile[k] <= budget; k++);
      return (k - 1) * STEP_M;
    }
    for (k = profile.length - 1; k > 0; k--) if (profile[k] <= budget) return k * STEP_M;
    return 0;
  }

  // terrainExtents: reachOf over RAYS rays; ray i points at bearing
  // i * 360/RAYS. opts: rxM (the receiver height the reach is drawn for),
  // rule (reachOf's).
  function terrainExtents(sample, lat, lon, maxM, antennaM, budget, opts) {
    var rxM = opts && opts.rxM, rule = opts && opts.rule;
    var out = new Float64Array(RAYS);
    for (var i = 0; i < RAYS; i++) out[i] = reachOf(lossProfile(sample, lat, lon, i * 2 * Math.PI / RAYS, maxM, antennaM, rxM), budget, rule);
    return out;
  }

  function distM(a, b) {
    var cos = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    var dx = (b.lon - a.lon) * M_PER_DEG * cos, dy = (b.lat - a.lat) * M_PER_DEG;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ── Tiles ────────────────────────────────────────────────────────────────

  // browserFetchTile decodes one Terrarium tile. colorSpaceConversion and
  // premultiplyAlpha off: the pixels are data, any colour management would
  // change the heights.
  // tileUrl fills in a Terrarium URL template ({z}, {x}, {y}); the default
  // source when there is none.
  function tileUrl(template, z, x, y) {
    return (template || TILE_URL).replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }

  function browserFetchTile(z, x, y, template) {
    return fetch(tileUrl(template, z, x, y), { mode: 'cors', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('tile ' + r.status); return r.blob(); })
      .then(function (b) { return createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); })
      .then(function (bmp) {
        var c;
        if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(TILE, TILE);
        else { c = document.createElement('canvas'); c.width = TILE; c.height = TILE; }
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        return decodeTerrarium(ctx.getImageData(0, 0, TILE, TILE).data);
      });
  }

  // ── Provider ─────────────────────────────────────────────────────────────

  // createTerrainProvider computes and caches reach for repeaters.
  // opts: fetchTile(z, x, y) → Promise<Float32Array(65536)> (the browser
  // fetcher by default), storage (localStorage), yieldFn (between
  // repeaters, so the page stays responsive), maxEntries.
  //   extentsFor([{ pk, lat, lon, R, antennaM?, links? }], onProgress)
  //       → Promise<Map pk → ext>; onProgress(pk, ext, { antennaM, source,
  //       budget, budgetSource })
  //       antennaM: the operator's height (source 'set'), else the 10 m
  //       default; links ([{ lat, lon }] of the nodes that heard it) set the
  //       loss budget (budgetSource 'links', else 'default'); R is the reach
  //       all round when terrain is missing
  //   status()  'ok' | 'unavailable' (a tile failed) | 'idle'
  function createTerrainProvider(opts) {
    opts = opts || {};
    var fetchTile = opts.fetchTile || browserFetchTile;
    var storage = opts.storage !== undefined ? opts.storage : (typeof localStorage !== 'undefined' ? localStorage : null);
    var yieldFn = opts.yieldFn || function () { return new Promise(function (r) { setTimeout(r, 0); }); };
    var maxEntries = opts.maxEntries || MAX_ENTRIES;
    var maxChars = opts.maxChars || MAX_CHARS;
    // The tile source: url (a template, null for the default) or off.
    var source = { off: false, url: null };
    // How optimistic the reach is (setParams, from mapDefaults.contours).
    var params = defaultParams();
    var paramsKey = '';
    // Both hold the current source's tiles only: setSource empties them,
    // and a fetch started under an earlier source is never stored.
    var tiles = new Map();     // 'x/y' → Float32Array; LRU order
    var inflight = new Map();  // 'x/y' → Promise
    var sourceGen = 0;         // bumped by every change of source
    var results = new Map();   // key → { ext: Float64Array, antennaM, source, budget, budgetSource }
    var order = [];            // persisted keys, oldest first
    var computed = 0, failures = 0, used = false;
    var queue = Promise.resolve();

    (function restore() {
      try {
        var raw = storage && storage.getItem(STORE_KEY);
        if (!raw) return;
        var saved = JSON.parse(raw);
        if (!saved || !saved.data) return;
        order = Array.isArray(saved.order) ? saved.order.filter(function (k) { return saved.data[k]; }) : Object.keys(saved.data);
        order.forEach(function (k) {
          var d = saved.data[k];
          results.set(k, { ext: Float64Array.from(d.e), antennaM: d.a, source: d.s, budget: d.b, budgetSource: d.bs });
        });
      } catch (e) { order = []; }
    })();

    // persist writes the newest entries that fit both limits. If the store
    // is still too full (other settings take the rest), it tries half as
    // many, and in the end removes its own entry rather than crowd out
    // anything else. The memory cache keeps working throughout.
    function persist() {
      if (!storage) return;
      while (order.length > maxEntries) results.delete(order.shift());
      var data = {}, keep = [], size = 30;
      for (var i = order.length - 1; i >= 0; i--) {
        var k = order[i], r = results.get(k);
        var d = { e: Array.prototype.map.call(r.ext, function (v) { return Math.round(v / 10) * 10; }), a: r.antennaM, s: r.source,
          b: Math.round(r.budget * 10) / 10, bs: r.budgetSource };
        var n = k.length * 2 + JSON.stringify(d).length + 8;
        if (size + n > maxChars) break;
        size += n; data[k] = d; keep.unshift(k);
      }
      for (var tries = 0; tries < 4; tries++) {
        try {
          var out = {};
          keep.forEach(function (k) { out[k] = data[k]; });
          storage.setItem(STORE_KEY, JSON.stringify({ order: keep, data: out }));
          return;
        } catch (e) {
          keep = keep.slice(Math.ceil(keep.length / 2));
          if (!keep.length) break;
        }
      }
      try { if (storage.removeItem) storage.removeItem(STORE_KEY); } catch (e) { /* denied */ }
    }

    // What the reach rests on besides position: the operator's height, if
    // set, and the links the budget is drawn from (a link added or lost
    // re-calibrates).
    function antennaKey(it) {
      return (it.antennaM > 0 ? 'a' + it.antennaM : '') + 'L' + (it.links || []).map(function (b) {
        return b.lat.toFixed(4) + ',' + b.lon.toFixed(4) + (b.antennaM > 0 ? '^' + b.antennaM : '');
      }).sort().join(';');
    }
    function keyOf(it) { return it.pk + '@' + it.lat + ',' + it.lon + '|' + Math.round(it.R) + '|' + antennaKey(it) + '|' + PARAMS + paramsKey + (source.url ? '|' + source.url : ''); }

    function loadTile(x, y) {
      var k = x + '/' + y;
      if (tiles.has(k)) { var t = tiles.get(k); tiles.delete(k); tiles.set(k, t); return Promise.resolve(t); }
      if (inflight.has(k)) return inflight.get(k);
      var gen = sourceGen, url = source.url;
      var p = Promise.resolve().then(function () { return fetchTile(ZOOM, x, y, url); })
        .then(function (arr) { return arr; }, function () { if (gen === sourceGen) failures++; return null; })
        .then(function (arr) {
          if (gen !== sourceGen) return arr;
          inflight.delete(k);
          // A failed tile is not kept, so the next visit asks for it again.
          if (arr) {
            tiles.set(k, arr);
            while (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
          }
          return arr;
        });
      inflight.set(k, p);
      return p;
    }

    // The tiles a repeater's rays can touch, the box of MAX_REACH_M round
    // it, and the paths to the nodes that heard it, for the budget.
    function tilesFor(it) {
      var dLat = params.maxReachM / M_PER_DEG, dLon = params.maxReachM / (M_PER_DEG * Math.cos(it.lat * Math.PI / 180));
      var n = it.lat + dLat, s = it.lat - dLat, w = it.lon - dLon, e = it.lon + dLon;
      (it.links || []).forEach(function (b) {
        if (!(distM(it, b) <= LINK_MAX_M)) return;
        if (b.lat > n) n = b.lat; if (b.lat < s) s = b.lat;
        if (b.lon < w) w = b.lon; if (b.lon > e) e = b.lon;
      });
      var a = tileOf(n, w, ZOOM), b = tileOf(s, e, ZOOM);
      var out = [];
      for (var y = Math.floor(a.fy); y <= Math.floor(b.fy); y++) {
        for (var x = Math.floor(a.fx); x <= Math.floor(b.fx); x++) out.push([x, y]);
      }
      return out;
    }

    // sampler over a fixed set of loaded tiles, bilinear between pixel
    // centres. A pixel on a tile not in the set is NaN (unknown).
    function sampler(set) {
      return function (lat, lon) {
        var t = tileOf(lat, lon, ZOOM);
        var gx = t.fx * TILE - 0.5, gy = t.fy * TILE - 0.5;
        var x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
        var a = px(set, x0, y0), b = px(set, x0 + 1, y0), c = px(set, x0, y0 + 1), d = px(set, x0 + 1, y0 + 1);
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      };
    }
    function px(set, gx, gy) {
      var tx = Math.floor(gx / TILE), ty = Math.floor(gy / TILE);
      var arr = set.get(tx + '/' + ty);
      if (!arr) return NaN;
      return arr[(gy - ty * TILE) * TILE + (gx - tx * TILE)];
    }

    function one(it) {
      var key = keyOf(it);
      var hit = results.get(key);
      if (hit) return Promise.resolve(hit);
      var need = tilesFor(it);
      return Promise.all(need.map(function (xy) { return loadTile(xy[0], xy[1]); })).then(function (arrs) {
        var set = new Map(), complete = true;
        need.forEach(function (xy, i) { if (arrs[i]) set.set(xy[0] + '/' + xy[1], arrs[i]); else complete = false; });
        computed++;
        var h = it.antennaM > 0 ? it.antennaM : ANTENNA_M, src = it.antennaM > 0 ? 'set' : 'default';
        if (!complete) {
          // Some terrain is missing: fall back to the radius all round, and
          // keep it out of the cache so a later visit tries the tiles again.
          var flat = new Float64Array(RAYS);
          flat.fill(it.R);
          return { ext: flat, antennaM: h, source: src, budget: NaN, budgetSource: 'none' };
        }
        var sample = sampler(set);
        var bud = budgetOf(sample, it, h, it.links, { pct: params.budgetPct, defaultDb: params.defaultBudgetDb });
        var ext = terrainExtents(sample, it.lat, it.lon, params.maxReachM, h, bud.db, { rxM: params.receiverM, rule: params.reachRule });
        var res = { ext: ext, antennaM: h, source: src, budget: bud.db, budgetSource: bud.source };
        // One entry per repeater: a newer one (it moved, its radius or its
        // links changed) replaces the older, which would only be dead weight.
        order = order.filter(function (k) {
          if (k.slice(0, k.indexOf('@')) !== it.pk) return true;
          results.delete(k);
          return false;
        });
        results.set(key, res);
        order.push(key);
        return res;
      });
    }

    return {
      extentsFor: function (items, onProgress) {
        var out = new Map();
        if (source.off) return Promise.resolve(out);
        used = true;
        // Serialised: one batch at a time, so concurrent callers share
        // tiles and results instead of racing for them.
        var run = queue.then(function () {
          var chain = Promise.resolve();
          (items || []).forEach(function (it) {
            chain = chain.then(function () { return one(it); }).then(function (res) {
              out.set(it.pk, res.ext);
              if (onProgress) onProgress(it.pk, res.ext, { antennaM: res.antennaM, source: res.source, budget: res.budget, budgetSource: res.budgetSource });
              return yieldFn();
            });
          });
          return chain.then(function () { persist(); return out; });
        });
        queue = run.then(function () {}, function () {});
        return run;
      },
      // setSource({ disabled }) turns terrain off; setSource({ url }) names a
      // Terrarium URL template; anything else is the default source. As
      // /api/config/map serves mapDefaults.terrainTiles.
      // setParams takes mapDefaults.contours as /api/config/map serves it:
      // budgetPercentile (50-100), defaultBudgetDb (90-150), maxReachKm
      // (1-50), reachRule ('farthest' | 'first'), receiverHeightM (0.5-100).
      // Anything missing or out of range keeps its default. Results are
      // cached under the settings, so a change computes afresh.
      setParams: function (c) {
        params = paramsFrom(c);
        var d = defaultParams();
        paramsKey = Object.keys(d).every(function (k) { return params[k] === d[k]; }) ? '' :
          '|p' + params.budgetPct + 'd' + params.defaultBudgetDb + 'm' + params.maxReachM + 'r' + params.reachRule + 'h' + params.receiverM;
      },
      params: function () { return Object.assign({}, params); },
      setSource: function (src) {
        var next = { off: !!(src && src.disabled), url: (src && typeof src.url === 'string' && src.url) || null };
        if (next.off !== source.off || next.url !== source.url) {
          tiles.clear(); inflight.clear(); sourceGen++;
        }
        source = next;
        failures = 0;
      },
      status: function () { return source.off ? 'off' : (failures ? 'unavailable' : (used ? 'ok' : 'idle')); },
      sourceUrl: function () { return source.url; },
      stats: function () { return { computed: computed, tiles: tiles.size, cached: results.size }; },
    };
  }

  function defaultParams() {
    return { budgetPct: BUDGET_PCT, defaultBudgetDb: DEFAULT_BUDGET_DB, maxReachM: MAX_REACH_M, reachRule: 'farthest', receiverM: ANTENNA_M };
  }
  // paramsFrom: mapDefaults.contours (the server has range-checked it; this
  // checks again, so a hand-made object cannot draw nonsense).
  function paramsFrom(c) {
    var p = defaultParams();
    if (!c) return p;
    var inR = function (v, lo, hi) { return typeof v === 'number' && v >= lo && v <= hi; };
    if (inR(c.budgetPercentile, 50, 100)) p.budgetPct = c.budgetPercentile / 100;
    if (inR(c.defaultBudgetDb, 90, 150)) p.defaultBudgetDb = c.defaultBudgetDb;
    if (inR(c.maxReachKm, 1, 50)) p.maxReachM = c.maxReachKm * 1000;
    if (c.reachRule === 'farthest' || c.reachRule === 'first') p.reachRule = c.reachRule;
    if (inR(c.receiverHeightM, 0.5, 100)) p.receiverM = c.receiverHeightM;
    return p;
  }

  var sharedProvider = null;
  // shared is the page's one provider, so tiles and results survive moving
  // between the map and live pages.
  function shared() {
    if (!sharedProvider) sharedProvider = createTerrainProvider();
    return sharedProvider;
  }

  window.TerrainReach = {
    rays: RAYS,
    tileOf: tileOf,
    decodeTerrarium: decodeTerrarium,
    knifeEdgeLoss: knifeEdgeLoss,
    freeSpaceLoss: freeSpaceLoss,
    lossProfile: lossProfile,
    pathLoss: pathLoss,
    budgetOf: budgetOf,
    reachOf: reachOf,
    maxReach: MAX_REACH_M,
    defaultAntenna: ANTENNA_M,
    terrainExtents: terrainExtents,
    createTerrainProvider: createTerrainProvider,
    shared: shared,
    tileUrl: tileUrl,
    limits: { maxEntries: MAX_ENTRIES, maxChars: MAX_CHARS },
  };
})();
