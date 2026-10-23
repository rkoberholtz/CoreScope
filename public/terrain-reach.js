/* Terrain line-of-sight reach for the region-scope contours (scope-contours.js).

   For a repeater, walk outward along 72 rays (every 5°) over an elevation
   model and stop where a receiver loses line of sight to the antenna and
   stays out of it for a while: the first ridge or valley that shadows the
   ground beyond it. The result is how far, in each direction, people can
   expect to reach the repeater continuously, before any radio range limit
   (the caller caps it, and stretches it to proven links).

   Elevation comes from AWS Terrain Tiles (Terrarium PNG, public, no key,
   CORS open), fetched only around the repeaters asked about, decoded once
   and kept in a small LRU. Results are cached in memory and in localStorage,
   keyed by repeater, position, radius and model parameters, so a reload
   costs nothing.

   Model, hardcoded for now (customizer is a follow-up):
     antenna 10 m above ground, receiver 2 m, earth curvature with k = 4/3,
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
  var ANTENNA_M = 10;
  var RX_M = 2;
  var TOLERANCE_M = 10;
  var SHADOW_M = 600;
  var K = 4 / 3;
  var EARTH_R = 6371008.8;
  var M_PER_DEG = 111320;
  var MAX_TILES = 64;       // decoded tiles held: 64 x 256 KB
  var MAX_ENTRIES = 3000;   // persisted results
  var STORE_KEY = 'meshcore-terrain-reach-v1';
  var PARAMS = 'z' + ZOOM + 'a' + ANTENNA_M + 'r' + RX_M + 't' + TOLERANCE_M + 's' + SHADOW_M;
  var TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';

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
  function rayCut(sample, lat, lon, bearing, maxM) {
    var h0 = sample(lat, lon);
    if (!isFinite(h0)) return maxM;
    var hA = h0 + ANTENNA_M;
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
  function terrainExtents(sample, lat, lon, maxM) {
    var out = new Float64Array(RAYS);
    for (var i = 0; i < RAYS; i++) out[i] = rayCut(sample, lat, lon, i * 2 * Math.PI / RAYS, maxM);
    return out;
  }

  // ── Tiles ────────────────────────────────────────────────────────────────

  // browserFetchTile decodes one Terrarium tile. colorSpaceConversion and
  // premultiplyAlpha off: the pixels are data, any colour management would
  // change the heights.
  function browserFetchTile(z, x, y) {
    return fetch(TILE_URL + z + '/' + x + '/' + y + '.png', { mode: 'cors', credentials: 'omit' })
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
  //   extentsFor([{ pk, lat, lon, R }], onProgress) → Promise<Map pk → ext>
  //   status()  'ok' | 'unavailable' (a tile failed) | 'idle'
  function createTerrainProvider(opts) {
    opts = opts || {};
    var fetchTile = opts.fetchTile || browserFetchTile;
    var storage = opts.storage !== undefined ? opts.storage : (typeof localStorage !== 'undefined' ? localStorage : null);
    var yieldFn = opts.yieldFn || function () { return new Promise(function (r) { setTimeout(r, 0); }); };
    var maxEntries = opts.maxEntries || MAX_ENTRIES;
    var tiles = new Map();     // 'x/y' → Float32Array; LRU order
    var inflight = new Map();  // 'x/y' → Promise
    var results = new Map();   // key → Float64Array
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
        order.forEach(function (k) { results.set(k, Float64Array.from(saved.data[k])); });
      } catch (e) { order = []; }
    })();

    function persist() {
      try {
        if (!storage) return;
        while (order.length > maxEntries) results.delete(order.shift());
        var data = {};
        order.forEach(function (k) { data[k] = Array.prototype.map.call(results.get(k), function (v) { return Math.round(v / 10) * 10; }); });
        storage.setItem(STORE_KEY, JSON.stringify({ order: order, data: data }));
      } catch (e) { /* full or denied: the memory cache still works */ }
    }

    function keyOf(it) { return it.pk + '@' + it.lat + ',' + it.lon + '|' + Math.round(it.R) + '|' + PARAMS; }

    function loadTile(x, y) {
      var k = x + '/' + y;
      if (tiles.has(k)) { var t = tiles.get(k); tiles.delete(k); tiles.set(k, t); return Promise.resolve(t); }
      if (inflight.has(k)) return inflight.get(k);
      var p = Promise.resolve().then(function () { return fetchTile(ZOOM, x, y); })
        .then(function (arr) { return arr; }, function () { failures++; return null; })
        .then(function (arr) {
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

    // The tiles a repeater's rays can touch: the box of its radius.
    function tilesFor(it) {
      var dLat = it.R / M_PER_DEG, dLon = it.R / (M_PER_DEG * Math.cos(it.lat * Math.PI / 180));
      var a = tileOf(it.lat + dLat, it.lon - dLon, ZOOM), b = tileOf(it.lat - dLat, it.lon + dLon, ZOOM);
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
        if (!complete) {
          // Some terrain is missing: fall back to the radius all round, and
          // keep it out of the cache so a later visit tries the tiles again.
          var flat = new Float64Array(RAYS);
          flat.fill(it.R);
          return flat;
        }
        var ext = terrainExtents(sampler(set), it.lat, it.lon, it.R);
        results.set(key, ext);
        order.push(key);
        return ext;
      });
    }

    return {
      extentsFor: function (items, onProgress) {
        used = true;
        var out = new Map();
        // Serialised: one batch at a time, so concurrent callers share
        // tiles and results instead of racing for them.
        var run = queue.then(function () {
          var chain = Promise.resolve();
          (items || []).forEach(function (it) {
            chain = chain.then(function () { return one(it); }).then(function (ext) {
              out.set(it.pk, ext);
              if (onProgress) onProgress(it.pk, ext);
              return yieldFn();
            });
          });
          return chain.then(function () { persist(); return out; });
        });
        queue = run.then(function () {}, function () {});
        return run;
      },
      status: function () { return failures ? 'unavailable' : (used ? 'ok' : 'idle'); },
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
    terrainExtents: terrainExtents,
    createTerrainProvider: createTerrainProvider,
    shared: shared,
  };
})();
