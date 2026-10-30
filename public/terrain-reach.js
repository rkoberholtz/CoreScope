/* Terrain line-of-sight reach for the region-scope contours (scope-contours.js).

   For a repeater, walk outward along 72 rays (every 5°) over an elevation
   model and stop where a receiver loses line of sight to the antenna and
   stays out of it for a while: the first ridge or valley that shadows the
   ground beyond it. The result is how far, in each direction, people can
   expect to reach the repeater continuously, before any radio range limit
   (the caller caps it, and stretches it to proven links).

   Elevation comes from AWS Terrain Tiles (Terrarium PNG, public, no key,
   CORS open) unless the operator names another Terrarium source or turns
   terrain off (mapDefaults.terrainTiles, setSource). Tiles are fetched only
   around the repeaters asked about, decoded once and kept in a small LRU.
   Results are cached in memory and in localStorage, keyed by repeater,
   position, radius, source and model parameters, so a reload costs nothing.
   The persisted cache is capped by size as well as count: localStorage is
   about 5 MB per site, shared with every other CoreScope setting.

   Antenna height above ground is the input that matters most, and adverts
   do not carry it. In order of preference:
     set:     the operator's figure (mapDefaults.antennaHeights in config)
     links:   raised from the repeaters known to hear it: for each, the
              lowest antenna that gives the link line of sight over the terrain
              between them (far end at 10 m); the 75th percentile of those,
              when that is more than 10 m, up to 60 m. Links only prove a
              lower bound, so they never lower it below the default.
     default: 10 m, for a repeater whose links need no more, or has none

   Model, hardcoded for now (customizer is a follow-up):
     receiver 2 m, earth curvature with k = 4/3,
     an obstruction up to 10 m above the line of sight is tolerated (LoRa
     diffracts round small ones), and a shadow must last 600 m to end a ray,
     so the brief shadow just behind a small bump does not.
   The terrain is bare earth: buildings and trees are not in it. */
(function () {
  'use strict';

  var ZOOM = 11;            // ~59 m per pixel at 40°N; matches the ray step
  var TILE = 256;
  var RAYS = 72;
  var STEP_M = 60;
  var ANTENNA_M = 10;        // default, and the far end of a link
  var EST_MAX_M = 60;
  var EST_PCT = 0.75;
  var LINK_MAX_M = 40000;    // longer links are not profiled (tiles)
  var RX_M = 2;
  var TOLERANCE_M = 10;
  var SHADOW_M = 600;
  var K = 4 / 3;
  var EARTH_R = 6371008.8;
  var M_PER_DEG = 111320;
  var MAX_TILES = 64;       // decoded tiles held: 64 x 256 KB
  var MAX_ENTRIES = 500;    // persisted results, at most
  var MAX_CHARS = 600000;   // and at most this much of localStorage (~1 KB each)
  var STORE_KEY = 'meshcore-terrain-reach-v2';
  var PARAMS = 'z' + ZOOM + 'a' + ANTENNA_M + 'r' + RX_M + 't' + TOLERANCE_M + 's' + SHADOW_M + 'e' + EST_MAX_M + 'p' + EST_PCT;
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

  // rayCut walks one ray from (lat, lon) toward bearing (radians, 0 = north,
  // clockwise) and returns how far a receiver keeps line of sight to the
  // antenna, up to maxM. sample(lat, lon) gives ground elevation in metres,
  // NaN where unknown; unknown terrain ends nothing, so the ray runs to maxM.
  function rayCut(sample, lat, lon, bearing, maxM, antennaM) {
    var h0 = sample(lat, lon);
    if (!isFinite(h0)) return maxM;
    var hA = h0 + (antennaM > 0 ? antennaM : ANTENNA_M);
    var kR2 = 2 * K * EARTH_R;
    var dLat = Math.cos(bearing) / M_PER_DEG;
    var dLon = Math.sin(bearing) / (M_PER_DEG * Math.cos(lat * Math.PI / 180));
    // Ground so far as points (d, t): t is height relative to the antenna,
    // dropped by the curve. How far the worst of them pokes above the line
    // to a receiver, max(t_i - s * d_i) for the line's slope s, is attained
    // on their upper convex hull. Points arrive in order of d, so the hull
    // grows like a monotone chain, and each query is a binary search.
    var hd = [], ht = [];
    var lastSeen = 0, shadowFrom = -1;
    for (var d = STEP_M; d <= maxM; d += STEP_M) {
      var h = sample(lat + d * dLat, lon + d * dLon);
      if (!isFinite(h)) return maxM;
      var t = h - d * d / kR2 - hA;
      var s = (t + RX_M) / d;
      var seen = hd.length === 0 || hullPoke(hd, ht, s) <= TOLERANCE_M;
      if (seen) { lastSeen = d; shadowFrom = -1; }
      else {
        if (shadowFrom < 0) shadowFrom = d;
        if (d - shadowFrom >= SHADOW_M) return Math.max(lastSeen, STEP_M);
      }
      // Add this ground point to the upper hull.
      var n = hd.length;
      while (n >= 2 && (hd[n - 1] - hd[n - 2]) * (t - ht[n - 2]) - (ht[n - 1] - ht[n - 2]) * (d - hd[n - 2]) >= 0) {
        hd.pop(); ht.pop(); n--;
      }
      hd.push(d); ht.push(t);
    }
    return maxM;
  }

  // hullPoke returns max over the hull points of t - s * d. Along an upper
  // hull the edge slopes fall, and the maximum sits at the first vertex
  // whose outgoing edge is no steeper than s.
  function hullPoke(hd, ht, s) {
    var lo = 0, hi = hd.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if ((ht[mid + 1] - ht[mid]) / (hd[mid + 1] - hd[mid]) <= s) hi = mid; else lo = mid + 1;
    }
    return ht[lo] - s * hd[lo];
  }

  // terrainExtents walks RAYS rays; ray i points at bearing i * 360/RAYS.
  function terrainExtents(sample, lat, lon, maxM, antennaM) {
    var out = new Float64Array(RAYS);
    for (var i = 0; i < RAYS; i++) out[i] = rayCut(sample, lat, lon, i * 2 * Math.PI / RAYS, maxM, antennaM);
    return out;
  }

  function distM(a, b) {
    var cos = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    var dx = (b.lon - a.lon) * M_PER_DEG * cos, dy = (b.lat - a.lat) * M_PER_DEG;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // requiredHeight: the lowest antenna height above ground at a that gives
  // the link a-b line of sight, with b's antenna hB above its ground. The
  // line from a's antenna to b's must pass within TOLERANCE_M of every
  // ground point between them, where the ground is raised by the earth's
  // bulge, d(D-d)/2kR. For a point at d that needs
  //   A >= (g - tol - B * d/D) / (1 - d/D)
  // in absolute heights; the most any point needs, minus a's ground.
  // Negative when a is already clear at ground level; NaN when terrain is
  // missing.
  function requiredHeight(sample, a, b, hB) {
    var D = distM(a, b);
    var gA = sample(a.lat, a.lon), gB = sample(b.lat, b.lon);
    if (!isFinite(gA) || !isFinite(gB) || !(D > STEP_M)) return NaN;
    var B = gB + hB, kR2 = 2 * K * EARTH_R, need = -Infinity;
    for (var d = STEP_M; d < D - STEP_M / 2; d += STEP_M) {
      var f = d / D;
      var g = sample(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f);
      if (!isFinite(g)) return NaN;
      g += d * (D - d) / kR2;
      var A = (g - TOLERANCE_M - B * f) / (1 - f);
      if (A > need) need = A;
    }
    return need === -Infinity ? -Infinity : need - gA;
  }

  // estimateAntenna: the 75th percentile of what its links require, so most
  // of its proven links have line of sight; one freak long link, or a
  // reflection the terrain cannot explain, does not set it. A link that works
  // from a low mast says nothing against a taller one, so the estimate only
  // ever raises the default 10 m, up to 60 m.
  // { m, source: 'links' (raised) | 'default', links: how many counted }.
  function estimateAntenna(sample, lat, lon, links) {
    var a = { lat: lat, lon: lon }, req = [];
    (links || []).forEach(function (b) {
      if (!b || !(distM(a, b) <= LINK_MAX_M)) return;
      var h = requiredHeight(sample, a, b, ANTENNA_M);
      if (h === -Infinity || isFinite(h)) req.push(h === -Infinity ? 0 : h);
    });
    if (!req.length) return { m: ANTENNA_M, source: 'default', links: 0 };
    req.sort(function (x, y) { return x - y; });
    var f = EST_PCT * (req.length - 1), i = Math.floor(f), t = f - i;
    var p = i + 1 < req.length ? req[i] + (req[i + 1] - req[i]) * t : req[i];
    if (!(p > ANTENNA_M)) return { m: ANTENNA_M, source: 'default', links: req.length };
    return { m: Math.round(Math.min(EST_MAX_M, p)), source: 'links', links: req.length };
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
  //       → Promise<Map pk → ext>; onProgress(pk, ext, { antennaM, source })
  //       antennaM: the operator's height (source 'set'); otherwise it is
  //       estimated from links ([{ lat, lon }] of the nodes that heard it)
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
    // Both hold the current source's tiles only: setSource empties them,
    // and a fetch started under an earlier source is never stored.
    var tiles = new Map();     // 'x/y' → Float32Array; LRU order
    var inflight = new Map();  // 'x/y' → Promise
    var sourceGen = 0;         // bumped by every change of source
    var results = new Map();   // key → { ext: Float64Array, antennaM, source }
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
          results.set(k, { ext: Float64Array.from(d.e), antennaM: d.a, source: d.s });
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
        var d = { e: Array.prototype.map.call(r.ext, function (v) { return Math.round(v / 10) * 10; }), a: r.antennaM, s: r.source };
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

    // The antenna part: the operator's height, or the links an estimate
    // would be drawn from (a link added or lost re-estimates).
    function antennaKey(it) {
      if (it.antennaM > 0) return 'a' + it.antennaM;
      return 'L' + (it.links || []).map(function (b) { return b.lat.toFixed(4) + ',' + b.lon.toFixed(4); }).sort().join(';');
    }
    function keyOf(it) { return it.pk + '@' + it.lat + ',' + it.lon + '|' + Math.round(it.R) + '|' + antennaKey(it) + '|' + PARAMS + (source.url ? '|' + source.url : ''); }

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

    // The tiles a repeater's rays can touch, the box of its radius, and,
    // when its height is to be estimated, the paths to its partners.
    function tilesFor(it) {
      var dLat = it.R / M_PER_DEG, dLon = it.R / (M_PER_DEG * Math.cos(it.lat * Math.PI / 180));
      var n = it.lat + dLat, s = it.lat - dLat, w = it.lon - dLon, e = it.lon + dLon;
      if (!(it.antennaM > 0)) {
        (it.links || []).forEach(function (b) {
          if (!(distM(it, b) <= LINK_MAX_M)) return;
          if (b.lat > n) n = b.lat; if (b.lat < s) s = b.lat;
          if (b.lon < w) w = b.lon; if (b.lon > e) e = b.lon;
        });
      }
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
        var set_ = it.antennaM > 0;
        if (!complete) {
          // Some terrain is missing: fall back to the radius all round, and
          // keep it out of the cache so a later visit tries the tiles again.
          var flat = new Float64Array(RAYS);
          flat.fill(it.R);
          return { ext: flat, antennaM: set_ ? it.antennaM : ANTENNA_M, source: set_ ? 'set' : 'default' };
        }
        var sample = sampler(set);
        var est = set_ ? { m: it.antennaM, source: 'set' } : estimateAntenna(sample, it.lat, it.lon, it.links);
        var res = { ext: terrainExtents(sample, it.lat, it.lon, it.R, est.m), antennaM: est.m, source: est.source };
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
              if (onProgress) onProgress(it.pk, res.ext, { antennaM: res.antennaM, source: res.source });
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
    rayCut: rayCut,
    requiredHeight: requiredHeight,
    estimateAntenna: estimateAntenna,
    defaultAntenna: ANTENNA_M,
    terrainExtents: terrainExtents,
    createTerrainProvider: createTerrainProvider,
    shared: shared,
    tileUrl: tileUrl,
    limits: { maxEntries: MAX_ENTRIES, maxChars: MAX_CHARS },
  };
})();
