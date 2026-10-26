/* Region contours for the map and live pages: where each region scope reaches.

   For each MeshCore region scope, outline the general area its nodes reach:
   one area per scope, from every node that is configured for it
   (configuredScopes: its default scope, the regions an observer reported
   it allows, or its own declared list) or whose full pubkey appears in the
   path of traffic for it (transported_scopes, #1751/#1902). A repeater
   forwards a scoped flood when the scope is in its region map without the
   deny-flood flag (firmware simple_repeater: onRecvPacket's
   region_map.findMatch(pkt, REGION_DENY_FLOOD), allowPacketForward). Its
   declared list and the regions an observer reports it allows are exactly
   those (exportNamesTo(..., REGION_DENY_FLOOD)), so it extends the scope's
   reach wherever it hears it, whether or not an observer has happened to
   see it do so. The default scope is weaker evidence: it is the scope the
   repeater's own adverts go out under, and the firmware does not require
   it to allow floods (the auto-created default does), so it counts only
   for a repeater, and only while its reported list, if any, names it.
   Being seen carrying a scope is the only way in for a repeater whose
   configuration is unknown; once a repeater has reported its list,
   carrying counts only for regions on it (carriedScopes). The click box
   says which evidence each member has.

   A node's reach, in 72 directions (reachFor):
     max( min(R, terrain cut), link lobe, 1 km floor )
   - R, how far it regularly reaches, comes from its proven two-way links in
     the neighbor graph (linkReach): the 75th percentile of their distances
     × 1.1, 1-20 km; 1 km for a node with no links.
   - The terrain cut is where line of sight over elevation data ends in that
     direction (terrain-reach.js). Real radios reach roughly a circle, trimmed
     where a ridge or valley shadows the ground.
   - Each proven link to a repeater in the same area still stretches its own
     bearing out past it: full length within 5° (one ray) of it, so the
     partner is inside even between two rays, tapering to nothing at
     ±11.25°. Evidence always beats the model. A link to a repeater outside
     the area (a hilltop site 60 km off) stretches nothing: it proves the two
     ends hear each other, not that the ground between them is covered.
   Interpolating between the 72 directions keeps the shape smooth.

   A scope's outline is drawn in one of two views (setView), each built from
   its members' reach shapes and each containing every member's whole shape,
   then grown by a 2 km margin with rounded corners, so no member is closer
   to the border than 3 km (the 1 km floor and the margin), and a linked
   repeater at a corner is never on the line:
   - hull: the convex hull (scopeHull), everything between their farthest
     edges included. The default.
   - detailed: shrink-wrapped (wrapShapes): their combined reach with every
     gap, bay and notch narrower than 15 km filled, between repeaters and
     between one repeater's spokes alike; groups further apart stay separate
     areas.
   Outlines are cached per view and scope, and recomputed only when its
   members, their positions or their reach change.

   Hover and click are hit-tested from the map's own events, not from the
   outlines: the live map draws canvases above them, and overlapping scopes
   should all be named. Hover names the scopes under the cursor; a click
   lists the repeaters configured for or carrying each of them. The outlines
   take no pointer events, so they never block a click on anything else.

   The radius rule, floor, margin, terrain model, wrap gap, default view and
   pulse duration are fixed for now; exposing them in the customizer is a
   follow-up. */
(function () {
  'use strict';

  // No reach is ever drawn closer than this, whatever the terrain says: a
  // repeater that carries a scope always has at least this much of the
  // region round it, edge repeaters included. Within ~1 km a LoRa signal
  // from a mast mostly gets round nearby terrain anyway.
  var DEFAULT_FLOOR_M = 1000;
  // Radius rule (linkReach): 75th percentile of two-way link distances,
  // × LINK_MARGIN, clamped; a node with no links gets NO_LINK_RADIUS_M.
  var RADIUS_PCT = 0.75;
  var MIN_RADIUS_M = 1000;
  var MAX_RADIUS_M = 20000;
  var NO_LINK_RADIUS_M = 1000;
  var DEFAULT_PULSE_MS = 1500;
  // Every area is drawn this much past its members' reach, round its
  // corners too: a little generous, so a repeater at a corner or just past
  // a lobe's tip is not left on the line. With the floor, every member has
  // at least 3 km of area round it.
  var AREA_MARGIN_M = 2000;
  // From scope-geometry.js, loaded first: 72 rays of 5°, the same as
  // terrain-reach.js walks.
  var G = window.ScopeGeometry;
  if (!G) throw new Error('scope-contours.js needs scope-geometry.js loaded first');
  var SECTORS = G.sectors;
  var SECTOR_RAD = G.sectorRad;
  // A proven link's lobe is at full length within one ray of its bearing,
  // so both rays either side of it reach the partner, and tapers to nothing
  // this far either side of it.
  var LOBE_HALF_RAD = 11.25 * Math.PI / 180;
  // A link proves the far node hears this one; the outline is drawn a little
  // past it so the linked node sits inside rather than on the edge.
  var LINK_MARGIN = 1.1;
  var PANE = 'mcScopeContoursPane';
  // Under overlayPane (400) and markerPane (600): outlines never cover a
  // route line or a node marker.
  var PANE_Z = 350;
  var PALETTE_SIZE = 8;
  var M_PER_DEG = G.mPerDeg;
  var HIDDEN_KEY = 'meshcore-scope-contours-hidden';
  var VIEW_KEY = 'meshcore-scope-contours-view';
  // Area views, the default first.
  var VIEWS = ['hull', 'detailed'];
  // The widest gap the wrap view fills (scope-geometry.js).
  var WRAP_GAP_M = G.wrapGapM;

  // normRegion mirrors the server's normScope (scope_audit.go): strip one
  // leading '#', nothing else, so the map, the audit and the live feed spell
  // a region alike. transported_scopes and scope_name keep the '#';
  // declared_regions has it stripped by the server.
  function normRegion(s) {
    s = s == null ? '' : String(s);
    return s.charAt(0) === '#' ? s.slice(1) : s;
  }

  function nodeRegionEvidence(n, region) {
    var want = normRegion(region);
    var ev = { declared: false, observed: false };
    if (!want || !n) return ev;
    var d = Array.isArray(n.declared_regions) ? n.declared_regions : [];
    for (var i = 0; i < d.length; i++) { if (normRegion(d[i]) === want) { ev.declared = true; break; } }
    var t = Array.isArray(n.transported_scopes) ? n.transported_scopes : [];
    for (var j = 0; j < t.length; j++) { if (normRegion(t[j]) === want) { ev.observed = true; break; } }
    return ev;
  }

  // position returns [lat, lon] for a node that can be placed, else null.
  // 0,0 is the "no position" placeholder, as on the live page.
  function position(n) {
    if (!n || n.lat == null || n.lon == null) return null;
    var lat = Number(n.lat), lon = Number(n.lon);
    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lat, lon];
  }

  // configuredScopes returns Map scope → { default, allowed, declared }: the
  // region scopes a node is configured for, from the three sources the API
  // carries, and which of them say so.
  //   default_scope     the scope its own adverts go out under (its
  //                     firmware default, "region default"). Counted only
  //                     for a repeater (or a node of unknown role) and, once
  //                     it has reported a list, only if the list names it:
  //                     only simple_repeater checks a scoped flood against
  //                     its regions (allowPacketForward). A companion
  //                     (isRepeatEn) or a room server (disable_fwd) forwards
  //                     regardless, so its default says nothing about that.
  //   configured_scope  the comma-separated regions an observer reported it
  //                     allows (#1865); '*' is the flood wildcard, not a region
  //   declared_regions  its own answer to a companion's regions query (#1862)
  function configuredScopes(n) {
    var out = new Map();
    function add(r, key) {
      r = normRegion(String(r).trim());
      if (!r || r === '*') return;
      var e = out.get(r);
      if (!e) { e = { default: false, allowed: false, declared: false }; out.set(r, e); }
      e[key] = true;
    }
    if (!n) return out;
    var def = n.default_scope ? normRegion(String(n.default_scope).trim()) : '';
    if (def && (!n.role || String(n.role).toLowerCase() === 'repeater')) {
      var list = reportedList(n);
      if (!list || list.has(def)) add(def, 'default');
    }
    if (n.configured_scope) String(n.configured_scope).split(',').forEach(function (r) { add(r, 'allowed'); });
    (Array.isArray(n.declared_regions) ? n.declared_regions : []).forEach(function (r) { add(r, 'declared'); });
    return out;
  }

  // reportedList returns the Set of regions a node has reported it allows
  // (configured_scope and declared_regions together), or null when it has
  // reported neither. An empty or '*'-only answer is a list: it names nothing.
  function reportedList(n) {
    if (!n || (n.configured_scope == null && !Array.isArray(n.declared_regions))) return null;
    var out = new Set();
    function add(r) {
      r = normRegion(String(r).trim());
      if (r && r !== '*') out.add(r);
    }
    if (n.configured_scope != null) String(n.configured_scope).split(',').forEach(add);
    (Array.isArray(n.declared_regions) ? n.declared_regions : []).forEach(add);
    return out;
  }

  // carriedScopes returns the scopes a node has been seen carrying. A node
  // that has reported its list keeps only the scopes on it: the firmware
  // forwards a scoped flood only for a region on that list
  // (RegionMap::findMatch returns NULL for any other transport code), so
  // carrying anything else was seen before the list changed. transported_scopes
  // has no age, so without this a removed region would stay forever.
  function carriedScopes(n) {
    var out = new Set();
    if (!n || !Array.isArray(n.transported_scopes) || !n.transported_scopes.length) return out;
    var list = reportedList(n);
    n.transported_scopes.forEach(function (r) {
      r = normRegion(r);
      if (r && (!list || list.has(r))) out.add(r);
    });
    return out;
  }

  // groupNodesByScope returns Map scope → { observed: [], configuredOnly: [] }.
  // A node seen carrying a scope is observed even if it is also configured
  // for it. Unplaced nodes are left out: they cannot contribute to an outline.
  function groupNodesByScope(nodes) {
    var groups = new Map();
    function group(s) {
      var g = groups.get(s);
      if (!g) { g = { observed: [], configuredOnly: [] }; groups.set(s, g); }
      return g;
    }
    (nodes || []).forEach(function (n) {
      if (!position(n)) return;
      var observed = carriedScopes(n);
      observed.forEach(function (r) { group(r).observed.push(n); });
      configuredScopes(n).forEach(function (_, r) { if (!observed.has(r)) group(r).configuredOnly.push(n); });
    });
    return groups;
  }

  // colorIndex picks one of the --mc-reach-N colours from the scope name, so
  // a scope keeps its colour across reloads, pages and the region picker.
  function colorIndex(scope) {
    var s = normRegion(scope), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return (h % PALETTE_SIZE) + 1;
  }

  // ── Reach ────────────────────────────────────────────────────────────────

  function angleDiff(a, b) {
    var d = (a - b) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  }

  // percentile of an ascending array, interpolating between ranks.
  function percentile(sorted, p) {
    var f = p * (sorted.length - 1), i = Math.floor(f), t = f - i;
    return i + 1 < sorted.length ? sorted[i] + (sorted[i + 1] - sorted[i]) * t : sorted[i];
  }

  // linkReach reads what the neighbor graph proves about each node's reach.
  // Only two-way links between two placed nodes count (each end has heard
  // the other), never an ambiguous one (a hop prefix that could be several
  // nodes). O(links × SECTORS).
  //   radius: Map pk → R, how far the node regularly reaches: the 75th
  //           percentile of its link distances × 1.1, clamped to 1-20 km.
  //           It ignores one exceptional long link and a crowd of close
  //           neighbours alike.
  //   links:  Map pk → [{ pk, bearing, len }], each link's partner, its
  //           bearing and its distance × 1.1, for lobeOf.
  //   partners: Map pk → [{ lat, lon }] of the other ends, from which the
  //           terrain provider estimates the node's antenna height.
  function linkReach(nodes, edges) {
    var pos = new Map();
    (nodes || []).forEach(function (n) { var p = position(n); if (p && n.public_key) pos.set(n.public_key, p); });
    var dists = new Map(), links = new Map(), partners = new Map();
    function partner(pk, p) { var l = partners.get(pk); if (l) l.push({ lat: p[0], lon: p[1] }); else partners.set(pk, [{ lat: p[0], lon: p[1] }]); }
    function link(pk, other, bearing, len) {
      var l = links.get(pk), k = { pk: other, bearing: bearing, len: len };
      if (l) l.push(k); else links.set(pk, [k]);
    }
    function dist(pk, d) { var l = dists.get(pk); if (l) l.push(d); else dists.set(pk, [d]); }
    (edges || []).forEach(function (e) {
      if (!e || e.bidirectional !== true || e.ambiguous || e.source === e.target) return;
      var a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) return;
      var cos = Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
      var dx = (b[1] - a[1]) * M_PER_DEG * cos, dy = (b[0] - a[0]) * M_PER_DEG;
      var d = Math.sqrt(dx * dx + dy * dy);
      dist(e.source, d); dist(e.target, d);
      partner(e.source, b); partner(e.target, a);
      if (!(d > 0)) return;
      var fwd = Math.atan2(dx, dy);
      link(e.source, e.target, fwd, d * LINK_MARGIN);
      link(e.target, e.source, fwd + Math.PI, d * LINK_MARGIN);
    });
    var radius = new Map();
    dists.forEach(function (l, pk) {
      l.sort(function (x, y) { return x - y; });
      var r = percentile(l, RADIUS_PCT) * LINK_MARGIN;
      radius.set(pk, Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, r)));
    });
    return { radius: radius, links: links, partners: partners };
  }

  // lobeOf stretches each of a node's links (from linkReach) along its own
  // bearing out to its distance × 1.1: at full length on the rays within 5°
  // of it, so interpolating between them still reaches past the partner,
  // then tapering to nothing at ±11.25°. Float64Array(SECTORS), or null
  // with no links. The overlay passes only the links to partners in the
  // same area: a link proves the two ends hear each other, not that the
  // ground between them is covered, so a lobe toward a hilltop repeater in
  // another area would only inflate this one.
  function lobeOf(links) {
    if (!links || !links.length) return null;
    var e = new Float64Array(SECTORS);
    links.forEach(function (k) {
      for (var i = 0; i < SECTORS; i++) {
        var off = angleDiff(i * SECTOR_RAD, k.bearing);
        if (off >= LOBE_HALF_RAD) continue;
        var v = off <= SECTOR_RAD ? k.len : k.len * (1 - (off - SECTOR_RAD) / (LOBE_HALF_RAD - SECTOR_RAD));
        if (v > e[i]) e[i] = v;
      }
    });
    return e;
  }

  // reachFor combines the three into per-sector reach:
  //   max( min(R, terrain cut), link lobe, floor )
  // terrain is null when there is none (yet, or the tiles failed): the
  // radius then stands unclipped.
  function reachFor(R, terrain, lobe, floorM) {
    var out = new Float64Array(SECTORS);
    for (var i = 0; i < SECTORS; i++) {
      var v = terrain ? Math.min(R, terrain[i]) : R;
      if (lobe && lobe[i] > v) v = lobe[i];
      out[i] = v > floorM ? v : floorM;
    }
    return out;
  }

  // shapeFor builds the reach shape of one node: its position plus
  // per-sector reach (ext; null for a plain circle of floorM).
  function shapeFor(n, ext, floorM) {
    var p = position(n);
    var e = new Float64Array(SECTORS);
    var max = floorM, min = Infinity;
    for (var i = 0; i < SECTORS; i++) {
      e[i] = ext && ext[i] > floorM ? ext[i] : floorM;
      if (e[i] > max) max = e[i];
      if (e[i] < min) min = e[i];
    }
    return { lat: p[0], lon: p[1], ext: e, maxExt: max, minExt: min, uniform: max === min };
  }

  // Hulls, the margin, the distance field and hit testing live in
  // scope-geometry.js (window.ScopeGeometry): pure geometry on reach shapes.
  var shapeEdge = G.shapeEdge, hullOfEdges = G.hullOfEdges, convexHull = G.convexHull, scopeHull = G.scopeHull,
    roundOut = G.roundOut, contourShapes = G.contourShapes, wrapShapes = G.wrapShapes, ringsBounds = G.ringsBounds, inRings = G.inRings;

  // ── Pulse ────────────────────────────────────────────────────────────────

  // createPulser runs one timer per scope. A packet for a scope that is
  // already pulsing only pushes its end back, so a burst of packets costs one
  // onStart and one onEnd, never a pile of DOM work.
  function createPulser(opts) {
    var setT = opts.setTimeout || setTimeout, clearT = opts.clearTimeout || clearTimeout;
    var ms = opts.durationMs || DEFAULT_PULSE_MS;
    var timers = new Map();
    function end(s) { timers.delete(s); if (opts.onEnd) opts.onEnd(s); }
    return {
      pulse: function (scope) {
        var s = normRegion(scope);
        if (!s) return;
        var t = timers.get(s);
        if (t != null) clearT(t);
        else if (opts.onStart) opts.onStart(s);
        timers.set(s, setT(function () { end(s); }, ms));
      },
      isActive: function (scope) { return timers.has(normRegion(scope)); },
      cancelAll: function () {
        Array.from(timers.keys()).forEach(function (s) { clearT(timers.get(s)); end(s); });
      },
    };
  }

  // ── Overlay ──────────────────────────────────────────────────────────────

  // shapeKey identifies a member's shape: its pubkey and a 32-bit FNV-1a
  // hash of its position and its reach rounded to the metre. A string of 72
  // numbers per member was a measured 8% of a rebuild.
  function shapeKey(n, s) {
    var h = 2166136261;
    function mix(v) { h = Math.imul(h ^ (v | 0), 16777619); }
    mix(Math.round(s.lat * 1e6)); mix(Math.round(s.lon * 1e6));
    if (s.uniform) mix(Math.round(s.ext[0]));
    else for (var i = 0; i < SECTORS; i++) mix(Math.round(s.ext[i]));
    return n.public_key + ':' + (h >>> 0).toString(36) + (s.uniform ? 'u' : '');
  }

  function plural(n) { return n + (n === 1 ? ' node' : ' nodes'); }

  function setClass(polys, cls, on) {
    polys.forEach(function (p) {
      var el = p.getElement && p.getElement();
      if (el) el.classList[on ? 'add' : 'remove'](cls);
    });
  }

  // ── Click popup ──────────────────────────────────────────────────────────

  var POPUP_ROWS = 50;

  // scopeMembers lists every node configured for or carrying a scope, placed
  // or not (an unplaced repeater is still configured for it), configured ones
  // first, then by name. Runs on a click, over the page's node list: O(n).
  function scopeMembers(scope, nodes) {
    var out = [];
    (nodes || []).forEach(function (n) {
      var conf = configuredScopes(n).get(scope);
      var carrying = carriedScopes(n).has(scope);
      if (!conf && !carrying) return;
      out.push({ node: n, conf: conf || null, carrying: carrying, placed: !!position(n) });
    });
    var label = function (m) { return String(m.node.name || m.node.public_key || '').toLowerCase(); };
    out.sort(function (a, b) {
      if (!!a.conf !== !!b.conf) return a.conf ? -1 : 1;
      var la = label(a), lb = label(b);
      return la < lb ? -1 : (la > lb ? 1 : 0);
    });
    return out;
  }

  function tagHtml(text, title) {
    return '<span class="mc-scope-tag" title="' + title + '">' + text + '</span>';
  }

  // scopePopupHtml: one section per scope under the click, each listing its
  // repeaters with why they are listed. The terrain model's antenna height
  // is an estimate, not a fact about the operator's mast, so it is left out.
  // Scopes whose lists are the same (the same repeaters, listed for the same
  // reasons) share one section: a few repeaters that each carry many scopes
  // would otherwise list themselves once per scope. Sorted by name, case
  // aside, so the order does not follow how the areas happened to be drawn;
  // a section sits where its first name does. Every name is escaped.
  function byScopeName(a, b) {
    var la = a.toLowerCase(), lb = b.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    return a < b ? -1 : (a > b ? 1 : 0);
  }
  function scopePopupHtml(scopes, nodes) {
    var sections = [], byBody = new Map();
    scopes.slice().sort(byScopeName).forEach(function (scope) {
      var members = scopeMembers(scope, nodes);
      var nConf = members.filter(function (m) { return m.conf; }).length;
      var nCarry = members.filter(function (m) { return m.carrying; }).length;
      var rows = members.slice(0, POPUP_ROWS).map(function (m) {
        var n = m.node, pk = String(n.public_key || '');
        var tags = '';
        if (m.conf && m.conf.default) tags += tagHtml('default', 'Its own adverts go out scoped to this region');
        if (m.conf && m.conf.allowed) tags += tagHtml('allowed', 'An observer reported it allows this region');
        if (m.conf && m.conf.declared) tags += tagHtml('declared', 'It lists this region when asked');
        if (m.carrying) tags += tagHtml('carrying', 'Seen relaying this region\'s traffic');
        if (!m.placed) tags += tagHtml('no position', 'Has no position, so it is not part of the outline');
        return '<li><a href="#/nodes/' + encodeURIComponent(pk) + '">' + escapeHtml(n.name || pk.slice(0, 8)) + '</a> ' + tags + '</li>';
      }).join('');
      var more = members.length > POPUP_ROWS ? '<li class="mc-scope-pop-more">+' + (members.length - POPUP_ROWS) + ' more</li>' : '';
      var body = '<span class="mc-scope-pop-sum">' + nConf + ' configured · ' + nCarry + ' carrying</span></div>' +
        '<ul class="mc-scope-pop-list">' + rows + more + '</ul></section>';
      var sec = byBody.get(body);
      if (!sec) { sec = { scopes: [], body: body }; byBody.set(body, sec); sections.push(sec); }
      sec.scopes.push(scope);
    });
    return '<div class="mc-scope-pop">' + sections.map(function (sec) {
      return '<section class="mc-scope-pop-scope"><div class="mc-scope-pop-head"><span class="mc-scope-pop-names">' +
        sec.scopes.map(function (scope) {
          return '<span class="mc-scope-pop-name"><span class="mc-scope-swatch mc-reach-c' + colorIndex(scope) + '" aria-hidden="true"></span> ' +
            '<strong>#' + escapeHtml(scope) + '</strong></span>';
        }).join(' ') + '</span> ' + sec.body;
    }).join('') + '</div>';
  }

  // createOverlay owns the layer, the cache, hover and the pulses for one
  // Leaflet map. opts: floorM, marginM (AREA_MARGIN_M), pulseMs, loadLinks (() => Promise of neighbor
  // graph edges), terrain (a terrain-reach.js provider: extentsFor and
  // status, setSource), loadMapConfig (() => Promise of /api/config/map:
  // antennaHeights, { pubkey or prefix: metres } the operator set, and
  // terrainTiles, the elevation source), and setTimeout/clearTimeout/raf
  // for tests.
  //   setNodes(nodes)   new node list; recomputes changed scopes when visible
  //   setLinks(edges)   neighbor graph edges the reach shapes follow
  //   setVisible(bool)  adds or removes the layer; computes lazily
  //   setOnly(scope)    draw one scope ('' = all)
  //   setHidden(names)  scopes not to draw
  //   setView(view)     'hull' or 'detailed' (opts.view: the first)
  //   view()            the current view
  //   scopes()          [{ scope, colour, observed, configured, hidden }]
  //   onChange(fn)      called after each render; returns an unsubscribe
  //   pulse(scope)      briefly highlight one scope (live page)
  //   destroy()         drop listeners and pending work
  function createOverlay(L, map, opts) {
    opts = opts || {};
    var floorM = opts.floorM || DEFAULT_FLOOR_M;
    var marginM = opts.marginM != null ? opts.marginM : AREA_MARGIN_M;
    var raf = opts.raf || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); });
    if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = String(PANE_Z);
    // Its own SVG renderer: the live map prefers canvas, which would ignore
    // the className the colours, hover and pulse are styled through.
    var renderer = L.svg({ pane: PANE });
    var layer = L.layerGroup();
    var tip = L.tooltip({ direction: 'top', offset: [0, -10], className: 'mc-scope-tip', opacity: 1 });
    var popup = L.popup({ className: 'mc-scope-popup', maxWidth: 340, autoPanPadding: [24, 24] });
    var nodes = [];
    var links = null;
    var reach = null;       // linkReach(nodes, links), rebuilt when either changes
    var shapes = new Map(); // pubkey → Map(area partners → { shape, key, edge }), rebuilt with reach
    var edgeCache = new Map(); // shape key → sampled edge, kept across rebuilds while used
    var terrain = new Map(); // pubkey → { key, ext } from the terrain provider
    var heights = null;      // operator antenna heights, { key: metres }; null until loaded
    var terrainAsked = new Set(); // pk|key requested and not yet answered
    var renderQueued = false;
    var visible = false;
    var only = '';
    var hidden = new Set();
    var view = VIEWS.indexOf(opts.view) >= 0 ? opts.view : VIEWS[0];
    var cache = new Map(); // view|scope → { sig, rings }; every view kept, so switching back is free
    var drawn = new Map(); // scope → [polygon]
    var hits = [];         // [{ scope, polys, rings, boxes, bounds, text }] for hover
    var list = [];
    var listeners = [];
    var computed = 0;
    var linksSeq = 0;
    var hovered = [];
    var moveAt = null, moveQueued = false;
    var pulser = createPulser({
      durationMs: opts.pulseMs, setTimeout: opts.setTimeout, clearTimeout: opts.clearTimeout,
      onStart: function (s) { setClass(drawn.get(s) || [], 'is-pulsing', true); },
      onEnd: function (s) { setClass(drawn.get(s) || [], 'is-pulsing', false); },
    });

    function radiusOf(n) { return (reach && reach.radius.get(n.public_key)) || NO_LINK_RADIUS_M; }
    // The operator's antenna height for a node: its pubkey, or the longest
    // configured prefix of it.
    function heightOf(n) {
      if (!heights) return 0;
      var pk = String(n.public_key || '').toLowerCase(), best = '', m = 0;
      Object.keys(heights).forEach(function (k) {
        if (k.length > best.length && pk.indexOf(k) === 0) { best = k; m = heights[k]; }
      });
      return m;
    }
    function partnersOf(n) { return (reach && reach.partners.get(n.public_key)) || []; }
    // The terrain request for a node: its position, radius, and what its
    // antenna height comes from. A result is only used while it still
    // matches, so one computed for a node list that has since moved on is
    // ignored.
    function terrainKey(n) {
      var p = position(n), h = heightOf(n);
      return p[0] + ',' + p[1] + '|' + Math.round(radiusOf(n)) + '|' +
        (h ? 'a' + h : 'L' + partnersOf(n).map(function (b) { return b.lat.toFixed(4) + ',' + b.lon.toFixed(4); }).sort().join(';'));
    }

    // A node's shape in one area (area: Set of its members' pubkeys): lobes
    // only toward its partners in that area. Shaped once per set of such
    // partners, so a node in several areas with the same partners in each
    // is shaped once.
    function shaped(n, area) {
      var own = (reach && reach.links.get(n.public_key)) || [];
      var inArea = own.filter(function (k) { return area.has(k.pk); });
      var sub = inArea.map(function (k) { return k.pk; }).sort().join(',');
      var byArea = shapes.get(n.public_key);
      if (!byArea) { byArea = new Map(); shapes.set(n.public_key, byArea); }
      var e = byArea.get(sub);
      if (!e) {
        var t = terrain.get(n.public_key);
        var cut = t && t.key === terrainKey(n) ? t.ext : null;
        var s = shapeFor(n, reachFor(radiusOf(n), cut, lobeOf(inArea), floorM), floorM);
        var key = shapeKey(n, s), edge = edgeCache.get(key);
        if (!edge) { edge = shapeEdge(s); edgeCache.set(key, edge); }
        e = { shape: s, key: key, edge: edge };
        byArea.set(sub, e);
      }
      return e;
    }

    // Ask the terrain provider for the members it has not answered yet. Each
    // answer reshapes that one node and queues a render, at most one a frame.
    function requestTerrain(members) {
      if (!opts.terrain) return;
      // Wait for the map config: the operator's heights, so a set height is
      // never first computed as an estimate, and the terrain source.
      if (opts.loadMapConfig && heights === null) { loadHeights(); return; }
      var items = [];
      members.forEach(function (n) {
        var k = terrainKey(n), t = terrain.get(n.public_key), ask = n.public_key + '|' + k;
        if ((t && t.key === k) || terrainAsked.has(ask)) return;
        terrainAsked.add(ask);
        var p = position(n), h = heightOf(n);
        var it = { pk: n.public_key, lat: p[0], lon: p[1], R: radiusOf(n), key: k };
        if (h) it.antennaM = h; else it.links = partnersOf(n);
        items.push(it);
      });
      if (!items.length) return;
      var keyOf = new Map(items.map(function (it) { return [it.pk, it.key]; }));
      Promise.resolve(opts.terrain.extentsFor(items, function (pk, ext) {
        terrain.set(pk, { key: keyOf.get(pk), ext: ext });
        shapes.delete(pk);
        queueRender();
      })).then(done, done);
      function done() { items.forEach(function (it) { terrainAsked.delete(it.pk + '|' + it.key); }); queueRender(); }
    }

    var heightsAsked = false;
    function loadHeights() {
      if (heightsAsked) return;
      heightsAsked = true;
      Promise.resolve(opts.loadMapConfig()).then(function (cfg) {
        var h = (cfg && cfg.antennaHeights) || {}, clean = {};
        Object.keys(h).forEach(function (k) { if (h[k] > 0) clean[String(k).toLowerCase()] = Number(h[k]); });
        if (opts.terrain && opts.terrain.setSource) opts.terrain.setSource((cfg && cfg.terrainTiles) || null);
        heights = clean;
      }, function () { heights = {}; }).then(queueRender);
    }

    function queueRender() {
      if (renderQueued) return;
      renderQueued = true;
      raf(function () { renderQueued = false; if (visible) render(); });
    }

    function rings(scope, members) {
      var area = new Set(members.map(function (n) { return n.public_key; }));
      var entries = members.map(function (n) { return shaped(n, area); });
      var key = view + '|' + scope;
      // Order-free and cheap: how many members, and the sum and xor of a hash
      // of each member's key.
      var sum = 0, xor = 0;
      entries.forEach(function (e) {
        var h = 2166136261, k = e.key;
        for (var i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
        sum = (sum + (h >>> 0)) % 4294967296; xor ^= h;
      });
      var sig = entries.length + '|' + sum + '|' + (xor >>> 0);
      var hit = cache.get(key);
      if (hit && hit.sig === sig) return hit.rings;
      computed++;
      var r;
      if (view === 'detailed') r = wrapShapes(entries.map(function (e) { return e.shape; }), WRAP_GAP_M, marginM);
      else {
        var ring = roundOut(hullOfEdges(entries.map(function (e) { return e.edge; })), marginM);
        r = ring.length ? [ring] : [];
      }
      cache.set(key, { sig: sig, rings: r });
      return r;
    }

    function draw(scope, members, text) {
      var r = rings(scope, members);
      if (!r.length) return null;
      var poly = L.polygon(r, { pane: PANE, renderer: renderer, interactive: false,
        className: 'mc-scope-area mc-reach-c' + colorIndex(scope) });
      layer.addLayer(poly);
      var el = poly.getElement && poly.getElement();
      if (el && el.setAttribute) el.setAttribute('data-scope', scope);
      var boxes = r.map(function (ring) { return ringsBounds([ring]); });
      hits.push({ scope: scope, polys: [poly], rings: r, boxes: boxes, bounds: ringsBounds(r), text: text });
      return poly;
    }

    function render() {
      clearHover();
      layer.clearLayers();
      drawn = new Map();
      hits = [];
      var groups = visible ? groupNodesByScope(nodes) : new Map();
      if (visible && !reach) { reach = linkReach(nodes, links); shapes = new Map(); }
      var members = new Set();
      var live = new Set();
      var want = normRegion(only);
      list = [];
      groups.forEach(function (g, scope) {
        var all = g.observed.concat(g.configuredOnly);
        list.push({ scope: scope, colour: colorIndex(scope), nodes: all.length, carrying: g.observed.length, hidden: hidden.has(scope) });
        VIEWS.forEach(function (v) { live.add(v + '|' + scope); });
        if ((want && scope !== want) || hidden.has(scope)) return;
        all.forEach(function (n) { members.add(n); });
        var poly = draw(scope, all, '#' + escapeHtml(scope) + ' · ' + plural(all.length));
        if (poly) drawn.set(scope, [poly]);
      });
      list.sort(function (a, b) { return a.scope < b.scope ? -1 : (a.scope > b.scope ? 1 : 0); });
      // Bounded by the scopes in the current node list: a scope that left it
      // leaves the cache too.
      if (visible) Array.from(cache.keys()).forEach(function (k) { if (!live.has(k)) cache.delete(k); });
      // Bounded the same way: only the edges this render used survive.
      if (visible) {
        var used = new Set();
        shapes.forEach(function (byArea) { byArea.forEach(function (e) { used.add(e.key); }); });
        Array.from(edgeCache.keys()).forEach(function (k) { if (!used.has(k)) edgeCache.delete(k); });
      }
      if (visible) requestTerrain(members);
      var info = { terrain: opts.terrain ? opts.terrain.status() : 'off', terrainUrl: opts.terrain && opts.terrain.sourceUrl ? opts.terrain.sourceUrl() : null, view: view };
      listeners.forEach(function (fn) { fn(list, visible, info); });
    }

    function refreshLinks() {
      if (!visible || !opts.loadLinks) return;
      var seq = ++linksSeq;
      Promise.resolve(opts.loadLinks()).then(function (edges) {
        if (seq !== linksSeq) return;
        links = Array.isArray(edges) ? edges : [];
        reach = null;
        render();
      }, function () { /* keep the floor shapes; the next reload retries */ });
    }

    // ── hover and click ──
    function hitsAt(ll) {
      var lat = ll.lat, lon = ll.lng;
      var found = [];
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i], b = h.bounds;
        if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
        if (inRings(h.rings, lat, lon, h.boxes)) found.push(h);
      }
      return found;
    }
    function popupOpen() { return !!(map.hasLayer && map.hasLayer(popup)); }
    function clearHover() {
      setClass(hovered, 'is-hovered', false);
      hovered = [];
      if (map.hasLayer && map.hasLayer(tip)) map.closeTooltip(tip);
    }
    function hoverAt(ll) {
      var found = hitsAt(ll);
      clearHover();
      if (!found.length) return;
      found.forEach(function (h) { hovered = hovered.concat(h.polys); });
      setClass(hovered, 'is-hovered', true);
      tip.setLatLng(ll);
      tip.setContent(found.map(function (h) { return h.text; }).join('<br>'));
      map.openTooltip(tip);
    }
    function onMove(e) {
      if (!visible || !hits.length || popupOpen()) return;
      moveAt = e.latlng;
      if (moveQueued) return;
      moveQueued = true;
      // Rechecked when the frame runs: a click is a move then a click, and
      // the popup it opens must not get a tooltip drawn over it.
      raf(function () { moveQueued = false; if (moveAt && visible && !popupOpen()) hoverAt(moveAt); });
    }
    function onOut() { moveAt = null; clearHover(); }
    // A click inside outlines lists each scope's repeaters. A click that
    // started on another layer (a live node, a packet path) bubbles here with
    // that layer as sourceTarget: it belongs to that layer, not to us.
    function onClick(e) {
      if (!visible || !hits.length) return;
      if (e.sourceTarget && e.sourceTarget !== map) return;
      var scopes = [];
      hitsAt(e.latlng).forEach(function (h) { if (scopes.indexOf(h.scope) < 0) scopes.push(h.scope); });
      if (!scopes.length) return;
      clearHover();
      popup.setLatLng(e.latlng);
      popup.setContent(scopePopupHtml(scopes, nodes));
      popup.openOn(map);
    }
    map.on('mousemove', onMove);
    map.on('mouseout', onOut);
    map.on('click', onClick);

    return {
      layer: layer,
      setNodes: function (l) { nodes = l || []; reach = null; render(); refreshLinks(); },
      setLinks: function (edges) { linksSeq++; links = edges || []; reach = null; render(); },
      setVisible: function (v) {
        visible = !!v;
        if (visible) { if (!map.hasLayer(layer)) layer.addTo(map); }
        else { pulser.cancelAll(); if (popupOpen()) map.closePopup(popup); if (map.hasLayer(layer)) map.removeLayer(layer); }
        render();
        if (visible && links === null) refreshLinks();
      },
      setOnly: function (scope) { only = scope || ''; render(); },
      setHidden: function (names) {
        hidden = new Set(Array.from(names || []).map(normRegion).filter(Boolean));
        render();
      },
      hidden: function () { return Array.from(hidden); },
      setView: function (v) {
        if (VIEWS.indexOf(v) < 0 || v === view) return;
        view = v;
        // The popup lists the scopes under a click on the old outlines.
        if (popupOpen()) map.closePopup(popup);
        render();
      },
      view: function () { return view; },
      scopes: function () { return list.slice(); },
      isVisible: function () { return visible; },
      onChange: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      },
      pulse: function (scope) { if (visible && drawn.has(normRegion(scope))) pulser.pulse(scope); },
      destroy: function () {
        pulser.cancelAll(); clearHover(); listeners = [];
        if (popupOpen()) map.closePopup(popup);
        map.off('mousemove', onMove); map.off('mouseout', onOut); map.off('click', onClick);
      },
      stats: function () { return { computed: computed, cached: cache.size }; },
    };
  }

  // ── Deep link and stored choice ──────────────────────────────────────────

  function hashParam(hash, key) {
    var qs = String(hash || '').split('?')[1] || '';
    return new URLSearchParams(qs).get(key);
  }

  // hashFlag reads ?contours= from a hash: true for '1', false for '0', null
  // when absent, so the caller falls back to its stored preference.
  function hashFlag(hash) {
    var v = hashParam(hash, 'contours');
    return v === '1' ? true : (v === '0' ? false : null);
  }

  // viewFromHash reads ?contoursView=; null when absent or not a view.
  function viewFromHash(hash) {
    var v = hashParam(hash, 'contoursView');
    return VIEWS.indexOf(v) >= 0 ? v : null;
  }

  // hiddenFromHash reads ?contoursHide=a,b; null when absent.
  function hiddenFromHash(hash) {
    var v = hashParam(hash, 'contoursHide');
    if (v == null) return null;
    return v.split(',').map(normRegion).filter(Boolean);
  }

  // writeHash merges updates into the URL without adding a history entry, so
  // a shared link opens with the overlay as the sender had it. '' or null
  // removes a key.
  function writeHash(updates) {
    if (!window.URLState) return;
    var h = window.URLState.updateHashParams(updates, location.hash);
    if (h !== location.hash) history.replaceState(null, '', h);
  }

  function writeHashFlag(on) { writeHash({ contours: on ? '1' : null }); }

  // initialHidden: the URL wins, then the stored choice, shared by the map
  // and live pages.
  function initialHidden(store) {
    var fromHash = hiddenFromHash(location.hash);
    if (fromHash) return fromHash;
    try {
      var v = JSON.parse(store.getItem(HIDDEN_KEY) || '[]');
      return Array.isArray(v) ? v.map(normRegion).filter(Boolean) : [];
    } catch (e) { return []; }
  }

  // ── Scope list ───────────────────────────────────────────────────────────

  // What an area is, per view.
  var AREA_NOTE = {
    hull: 'Each area spans the farthest reach of its repeaters, at least ' + ((DEFAULT_FLOOR_M + AREA_MARGIN_M) / 1000) + ' km round each.',
    detailed: 'Each area wraps its repeaters\' reach, filling gaps narrower than ' + (WRAP_GAP_M / 1000) + ' km and leaving wider ones, at least ' + ((DEFAULT_FLOOR_M + AREA_MARGIN_M) / 1000) + ' km round each.',
  };
  var TERRAIN_NOTE = 'A repeater\'s range comes from its two-way links, trimmed by line of sight over terrain and stretched to proven links within its area. ' +
    'Antenna heights are the operator\'s where set; otherwise 10 m, raised where a repeater\'s links need more (click an outline to see them). ';
  var TERRAIN_SOURCE = 'Terrain: AWS Terrain Tiles (Mapzen; SRTM, USGS 3DEP and others), bare earth: buildings and trees are not in it.';
  var NO_TERRAIN_NOTE = 'Terrain unavailable: a repeater\'s range comes from its two-way links, stretched to proven links within its area, with no terrain trimming.';
  var TERRAIN_OFF_NOTE = 'Terrain is off on this instance: a repeater\'s range comes from its two-way links, stretched to proven links within its area, with no terrain trimming.';

  // terrainNote says how ranges were drawn, and from which elevation source.
  function terrainNote(info) {
    var state = info && info.terrain;
    if (state === 'unavailable') return NO_TERRAIN_NOTE;
    if (state === 'off') return TERRAIN_OFF_NOTE;
    var url = info && info.terrainUrl;
    if (!url) return TERRAIN_NOTE + TERRAIN_SOURCE;
    var host = url.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    return TERRAIN_NOTE + 'Terrain: ' + escapeHtml(host) + ' (the operator\'s source), bare earth: buildings and trees are not in it.';
  }

  function listHtml(items, opts, info) {
    var rows = items.map(function (it) {
      var name = escapeHtml(it.scope);
      var title = '#' + name + ': ' + plural(it.nodes) + ', ' + (it.carrying ? it.carrying + ' seen carrying it' : 'none seen carrying it yet');
      return '<label class="mc-scope-row" title="' + title + '">' +
        '<input type="checkbox" data-scope="' + name + '"' + (it.hidden ? '' : ' checked') + '> ' +
        '<span class="mc-scope-swatch mc-reach-c' + it.colour + '" aria-hidden="true"></span> ' +
        '#' + name + ' <span class="mc-scope-count">' + it.nodes + '</span></label>';
    }).join('');
    return (opts.titleHtml || '') +
      '<div class="filter-group mc-scope-list-actions"><button type="button" class="btn" data-scope-all>All</button> ' +
      '<button type="button" class="btn" data-scope-none>None</button></div>' +
      rows +
      '<div class="mc-scope-hint">' + AREA_NOTE[(info && info.view) || VIEWS[0]] + ' ' +
      terrainNote(info) + ' Click an outline to list its repeaters.</div>';
  }

  // mountScopeList renders a show/hide row per scope into el and keeps it in
  // step with the overlay. The choice is stored and written to the URL.
  // opts: titleHtml (heading above the rows), storage (defaults to
  // localStorage). Returns an unsubscribe.
  function mountScopeList(el, overlay, opts) {
    opts = opts || {};
    var store = opts.storage || localStorage;
    overlay.setHidden(initialHidden(store));
    function save(names) {
      overlay.setHidden(names);
      try { store.setItem(HIDDEN_KEY, JSON.stringify(overlay.hidden())); } catch (e) { /* private mode */ }
      writeHash({ contoursHide: overlay.hidden().join(',') || null });
    }
    function paint(items, visible, info) {
      el.hidden = !(visible && items.length);
      el.innerHTML = el.hidden ? '' : listHtml(items, opts, info);
    }
    el.addEventListener('change', function (e) {
      var t = e.target, s = t && t.getAttribute && t.getAttribute('data-scope');
      if (s == null) return;
      var h = new Set(overlay.hidden());
      if (t.checked) h.delete(normRegion(s)); else h.add(normRegion(s));
      save(h);
    });
    el.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.hasAttribute) return;
      if (t.hasAttribute('data-scope-all')) save([]);
      else if (t.hasAttribute('data-scope-none')) save(overlay.scopes().map(function (it) { return it.scope; }));
    });
    var off = overlay.onChange(paint);
    paint(overlay.scopes(), overlay.isVisible());
    return off;
  }

  // ── View picker ──────────────────────────────────────────────────────────

  var VIEW_LABEL = { hull: 'Convex Hull', detailed: 'Detailed' };
  var VIEW_TITLE = {
    hull: 'One rubber band round each scope\'s outermost reach: roughly where the region is',
    detailed: 'Hugs each scope\'s reach, filling bays and gaps narrower than ' + (WRAP_GAP_M / 1000) + ' km; separate groups stay separate',
  };

  // mountViewPicker renders the area view buttons into el, shown while the
  // overlay is. The URL wins, then the stored choice; a change is stored and
  // written to the URL (the default view leaves the URL clean). The map and
  // live pages share the stored choice and the URL key. opts: storage
  // (defaults to localStorage), titleHtml (a heading shown above it, with
  // it). Returns an unsubscribe.
  function mountViewPicker(el, overlay, opts) {
    opts = opts || {};
    var store = opts.storage || localStorage;
    var start = viewFromHash(location.hash);
    if (!start) { try { start = store.getItem(VIEW_KEY); } catch (e) { start = null; } }
    overlay.setView(VIEWS.indexOf(start) >= 0 ? start : VIEWS[0]);
    var shown = null;
    function paint(_, visible) {
      el.hidden = !visible;
      var key = visible ? overlay.view() : '';
      if (key === shown) return;
      shown = key;
      el.innerHTML = !visible ? '' : (opts.titleHtml || '') +
        '<span class="mc-scope-view-label" id="mcScopeViewLabel">Area shape</span>' +
        '<div class="filter-group" role="group" aria-labelledby="mcScopeViewLabel">' + VIEWS.map(function (v) {
          var on = v === overlay.view();
          return '<button type="button" class="btn' + (on ? ' active' : '') + '" data-view="' + v + '" aria-pressed="' + on + '" title="' + VIEW_TITLE[v] + '">' + VIEW_LABEL[v] + '</button>';
        }).join('') + '</div>';
    }
    el.addEventListener('click', function (e) {
      var t = e.target, v = t && t.getAttribute && t.getAttribute('data-view');
      if (VIEWS.indexOf(v) < 0) return;
      overlay.setView(v);
      try { store.setItem(VIEW_KEY, v); } catch (err) { /* private mode */ }
      writeHash({ contoursView: v === VIEWS[0] ? null : v });
      paint(null, overlay.isVisible());
    });
    var off = overlay.onChange(paint);
    paint(null, overlay.isVisible());
    return off;
  }

  window.ScopeContours = {
    hashFlag: hashFlag,
    hiddenFromHash: hiddenFromHash,
    viewFromHash: viewFromHash,
    views: VIEWS.slice(),
    wrapGapM: WRAP_GAP_M,
    areaMarginM: AREA_MARGIN_M,
    contourShapes: contourShapes,
    wrapShapes: wrapShapes,
    mountViewPicker: mountViewPicker,
    writeHashFlag: writeHashFlag,
    normRegion: normRegion,
    nodeRegionEvidence: nodeRegionEvidence,
    groupNodesByScope: groupNodesByScope,
    configuredScopes: configuredScopes,
    carriedScopes: carriedScopes,
    scopePopupHtml: scopePopupHtml,
    linkReach: linkReach,
    lobeOf: lobeOf,
    reachFor: reachFor,
    noLinkRadius: NO_LINK_RADIUS_M,
    shapeFor: shapeFor,
    convexHull: convexHull,
    scopeHull: scopeHull,
    inRings: inRings,
    colorIndex: colorIndex,
    createPulser: createPulser,
    createOverlay: createOverlay,
    sectors: SECTORS,
    mountScopeList: mountScopeList,
  };
})();
