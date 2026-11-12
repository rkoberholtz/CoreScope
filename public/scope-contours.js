/* Region contours for the map and live pages: where each region scope is.

   For each MeshCore region scope, mark every node that is configured for it
   (configuredScopes: its default scope, or the newest region list it
   reported, through an observer or a companion's regions query) or whose
   full pubkey appears in the path of traffic for it (transported_scopes,
   #1751/#1902). A repeater
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
   configuration is unknown; once a repeater has reported a complete list,
   carrying counts only for regions on it (carriedScopes). The click box
   says which evidence each member has.

   The area is schematic, drawn from what is known and nothing more:
   - an octagon of a fixed radius round every member: one radius for the
     whole mesh (4 km unless mapDefaults.contours.radiusKm says otherwise),
     or the member's own from mapDefaults.contours.radii, set by an operator
     who knows the site;
   - a narrow band between two members that hear each other (a link in the
     neighbor graph heard in either direction, never an ambiguous one) when
     their octagons do not already meet. It is narrower than an octagon on
     purpose: a link proves the far end heard the near one, not that the
     ground between them is covered.
   How far a repeater really reaches is not modelled. Earlier versions
   estimated it from terrain, path loss and link distances; held against the
   receptions the mesh actually logged, that did little better than a
   circle of the same area and drew a precise-looking edge the data could
   not support.

   A scope's shapes are filled as one area and outlined once round the
   outside (scope-geometry.js). They are cached by what they are built from
   (members, positions, radii, links), so scopes with the same members share
   one, and nothing is rebuilt until one of those changes.

   Hover and click are hit-tested from the map's own events, not from the
   areas: the live map draws canvases above them, and overlapping scopes
   should all be named. Hover names the scopes under the cursor; a click
   lists the repeaters configured for or carrying each of them, and how many
   separate groups (linkedGroups: members no known link joins) a scope has.
   The areas take no pointer events, so they never block a click on
   anything else.

   The radius, the band width and the pulse duration are set in config.json
   or fixed for now; exposing them in the customizer is a follow-up. */
(function () {
  'use strict';

  // The octagon radius when the operator sets none, and the limits a
  // configured one is held to (the server applies the same).
  var DEFAULT_RADIUS_M = 4000;
  var MIN_RADIUS_M = 500;
  var MAX_RADIUS_M = 30000;
  // A link band's full width when the operator sets none: this fraction of
  // the radius, so it reads as a link, not as an area.
  var TUBE_RATIO = 1 / 3;
  var MIN_TUBE_M = 200;
  var MAX_TUBE_M = 10000;
  var DEFAULT_PULSE_MS = 1500;
  // From scope-geometry.js, loaded first.
  var G = window.ScopeGeometry;
  var PANE = 'mcScopeContoursPane';
  // Under overlayPane (400) and markerPane (600): areas never cover a
  // route line or a node marker.
  var PANE_Z = 350;
  var PALETTE_SIZE = 8;
  var HIDDEN_KEY = 'meshcore-scope-contours-hidden';

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

  // configuredScopes returns Map scope → { default, reported }: the region
  // scopes a node is configured for, and which evidence says so.
  //   default   default_scope, the scope its own adverts go out under (its
  //             firmware default, "region default"). Counted only for a
  //             repeater (or a node of unknown role) and, once it has
  //             reported a complete list, only if the list names it: only
  //             simple_repeater checks a scoped flood against its regions
  //             (allowPacketForward). A companion (isRepeatEn) or a room
  //             server (disable_fwd) forwards regardless, so its default
  //             says nothing about that.
  //   reported  on the newest region list it reported (reportedRegions);
  //             '*' is the flood wildcard, not a region.
  function configuredScopes(n) {
    var out = new Map();
    function add(r, key) {
      r = normRegion(String(r).trim());
      if (!r || r === '*') return;
      var e = out.get(r);
      if (!e) { e = { default: false, reported: false }; out.set(r, e); }
      e[key] = true;
    }
    if (!n) return out;
    var def = n.default_scope ? normRegion(String(n.default_scope).trim()) : '';
    if (def && (!n.role || String(n.role).toLowerCase() === 'repeater')) {
      var list = reportedList(n);
      if (!list || list.has(def)) add(def, 'default');
    }
    var rep = reportedRegions(n);
    if (rep) rep.regions.forEach(function (r) { add(r, 'reported'); });
    return out;
  }

  // reportedRegions returns the newest region list a node reported, as
  // { regions, partial }, or null when it has reported none. The server's
  // declared_regions is already the newest answer across both collectors
  // (configured_scope from observer /neighbors reports, and companions'
  // regions queries; AllCurrentDeclaredRegions), so configured_scope is read
  // only from a server that does not send declared_regions: adding the two
  // would bring back a region the newer answer dropped. partial: the answer
  // was cut off (declared_regions_truncated), so a region missing from it may
  // still be configured.
  function reportedRegions(n) {
    if (!n) return null;
    if (Array.isArray(n.declared_regions)) return { regions: n.declared_regions, partial: n.declared_regions_truncated === true };
    if (n.configured_scope != null) return { regions: String(n.configured_scope).split(','), partial: false };
    return null;
  }

  // reportedList returns the Set of regions on a node's newest complete
  // list, or null when it has reported none or only a partial one: a list
  // can rule a region out only when it is whole. An empty or '*'-only answer
  // is a list: it names nothing.
  function reportedList(n) {
    var rep = reportedRegions(n);
    if (!rep || rep.partial) return null;
    var out = new Set();
    rep.regions.forEach(function (r) {
      r = normRegion(String(r).trim());
      if (r && r !== '*') out.add(r);
    });
    return out;
  }

  // carriedScopes returns the scopes a node has been seen carrying. A node
  // that has reported a complete list keeps only the scopes on it: the firmware
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

  // colorsFor returns Map scope → one of the --mc-reach-N colours (1..8),
  // handed out in name order over the given scopes: up to PALETTE_SIZE
  // scopes all differ, and more share each colour as evenly as they can.
  // Scopes tend to overlap (a city inside its state inside its country), so
  // alike colours read as one area. A hash of the name kept each colour fixed
  // but bunched them: on one live instance 12 scopes, all overlapping, took
  // 6 of the 8 colours, with 8 pairs alike where 4 is the least possible.
  // The cost: a scope's colour can move when another scope joins or leaves.
  function colorsFor(scopes) {
    var out = new Map();
    Array.from(new Set(scopes)).sort(byScopeName).forEach(function (s, i) { out.set(s, (i % PALETTE_SIZE) + 1); });
    return out;
  }

  // ── Links ────────────────────────────────────────────────────────────────

  // memberLinks reads the neighbor graph as Map pk → [pk]: for each node,
  // the nodes it has a link with. A link counts when at least one direction
  // of it was heard (bidirectional alone proves nothing), both ends are
  // placed, and it is not ambiguous (a hop prefix that could be several
  // nodes). O(links).
  function memberLinks(nodes, edges) {
    var placed = new Set();
    (nodes || []).forEach(function (n) { if (n.public_key && position(n)) placed.add(n.public_key); });
    var peers = new Map();
    function peer(pk, other) { var l = peers.get(pk); if (l) l.push(other); else peers.set(pk, [other]); }
    (edges || []).forEach(function (e) {
      if (!e || e.ambiguous || e.source === e.target) return;
      if (!(e.heard_by_target > 0) && !(e.heard_by_source > 0)) return;
      if (!placed.has(e.source) || !placed.has(e.target)) return;
      peer(e.source, e.target); peer(e.target, e.source);
    });
    return peers;
  }

  // linkedGroups splits a scope's members into groups joined by links,
  // heard either way, between members (peers, from memberLinks; null: no links yet), in
  // member order. A scoped flood crosses from one group to another only
  // through a repeater that forwards the scope, so a link through a
  // non-member joins nothing. Nothing is drawn between two groups; the click
  // box says how many a scope has.
  // Union-find, O(members + their links).
  function linkedGroups(members, peers) {
    var idx = new Map();
    (members || []).forEach(function (n, i) { idx.set(n.public_key, i); });
    var parent = (members || []).map(function (_, i) { return i; });
    function root(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    if (peers) {
      (members || []).forEach(function (n, i) {
        (peers.get(n.public_key) || []).forEach(function (pk) {
          var j = idx.get(pk);
          if (j == null) return;
          var a = root(i), b = root(j);
          if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        });
      });
    }
    var byRoot = new Map(), out = [];
    (members || []).forEach(function (n, i) {
      var r = root(i), g = byRoot.get(r);
      if (!g) { g = []; byRoot.set(r, g); out.push(g); }
      g.push(n);
    });
    return out;
  }

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
  function tagTitled(text, title) {
    return '<span title="' + title + '">' + text + '</span>';
  }
  // The summary counts: a carrying member is configured for the scope too
  // (the firmware forwards only what its list allows), so the first count is
  // about what CoreScope knows, not what the repeater is.
  var KNOWN_TITLE = 'Its region list or default scope has been reported';
  var CARRY_TITLE = 'Seen relaying this scope\'s traffic, so it forwards it';
  var GROUPS_TITLE = 'No known link joins these groups of its repeaters, so nothing is drawn between them';

  // scopePopupHtml: one section per scope under the click, each listing its
  // repeaters with why they are listed, and how many separate areas the
  // scope is drawn as when more than one (groupsOf(scope), when given). Each
  // name's swatch is colourOf(scope), the overlay's colour for it; without
  // one, colours are handed out over the scopes given.
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
  function scopePopupHtml(scopes, nodes, groupsOf, colourOf) {
    if (!colourOf) { var own = colorsFor(scopes); colourOf = function (s) { return own.get(s); }; }
    var sections = [], byBody = new Map();
    scopes.slice().sort(byScopeName).forEach(function (scope) {
      var members = scopeMembers(scope, nodes);
      var nConf = members.filter(function (m) { return m.conf; }).length;
      var nCarry = members.filter(function (m) { return m.carrying; }).length;
      var rows = members.slice(0, POPUP_ROWS).map(function (m) {
        var n = m.node, pk = String(n.public_key || '');
        var tags = '';
        if (m.conf && m.conf.default) tags += tagHtml('default', 'Its own adverts go out scoped to this region');
        if (m.conf && m.conf.reported) tags += tagHtml('reported', 'Its newest reported region list names this region');
        if (m.carrying) tags += tagHtml('carrying', 'Seen relaying this region\'s traffic');
        if (!m.placed) tags += tagHtml('no position', 'Has no position, so it is not part of the outline');
        return '<li><a href="#/nodes/' + encodeURIComponent(pk) + '">' + escapeHtml(n.name || pk.slice(0, 8)) + '</a> ' + tags + '</li>';
      }).join('');
      var more = members.length > POPUP_ROWS ? '<li class="mc-scope-pop-more">+' + (members.length - POPUP_ROWS) + ' more</li>' : '';
      var nGroups = groupsOf ? groupsOf(scope) : 0;
      var split = nGroups > 1 ? ' · ' + tagTitled(nGroups + ' separate groups', GROUPS_TITLE) : '';
      var body = '<span class="mc-scope-pop-sum">' + tagTitled(nConf + ' with known config', KNOWN_TITLE) + ' · ' +
        tagTitled(nCarry + ' seen carrying', CARRY_TITLE) + split + '</span></div>' +
        '<ul class="mc-scope-pop-list">' + rows + more + '</ul></section>';
      var sec = byBody.get(body);
      if (!sec) { sec = { scopes: [], body: body }; byBody.set(body, sec); sections.push(sec); }
      sec.scopes.push(scope);
    });
    return '<div class="mc-scope-pop">' + sections.map(function (sec) {
      return '<section class="mc-scope-pop-scope"><div class="mc-scope-pop-head"><span class="mc-scope-pop-names">' +
        sec.scopes.map(function (scope) {
          return '<span class="mc-scope-pop-name"><span class="mc-scope-swatch mc-reach-c' + colourOf(scope) + '" aria-hidden="true"></span> ' +
            '<strong>#' + escapeHtml(scope) + '</strong></span>';
        }).join(' ') + '</span> ' + sec.body;
    }).join('') + '</div>';
  }

  // clampNum: v when it is a number within [lo, hi], else null.
  function clampNum(v, lo, hi) {
    return typeof v === 'number' && v >= lo && v <= hi ? v : null;
  }

  // createOverlay owns the layer, the cache, hover and the pulses for one
  // Leaflet map. opts: radiusM and tubeWidthM (fixed, for tests; otherwise
  // the defaults until the map config says), pulseMs, loadLinks (() =>
  // Promise of neighbor graph edges), loadMapConfig (() => Promise of
  // /api/config/map, whose contours holds radiusKm, tubeWidthKm and radii,
  // { pubkey or prefix: km }; nothing is drawn until it has answered, so an
  // area never jumps from the default radius to the configured one), and
  // setTimeout/clearTimeout/raf for tests.
  //   setNodes(nodes)   new node list; rebuilds changed scopes when visible
  //   setLinks(edges)   neighbor graph edges the bands follow
  //   setVisible(bool)  adds or removes the layer; computes lazily
  //   setOnly(scope)    draw one scope ('' = all)
  //   setHidden(names)  scopes not to draw
  //   scopes()          [{ scope, colour, nodes, carrying, hidden }]
  //   onChange(fn)      called after each render; returns an unsubscribe
  //   pulse(scope)      briefly highlight one scope (live page)
  //   destroy()         drop listeners and pending work
  function createOverlay(L, map, opts) {
    opts = opts || {};
    var radiusM = opts.radiusM || DEFAULT_RADIUS_M;
    var tubeWidthM = opts.tubeWidthM || 0; // 0: TUBE_RATIO of the radius
    var radii = {};        // operator radii, { key or prefix: metres }
    var radiiKeys = [];
    var configState = opts.loadMapConfig ? 'needed' : 'done'; // → 'asked' → 'done'
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
    var peers = null;      // memberLinks(nodes, links), rebuilt when either changes
    var destroyed = false; // destroy(): nothing is drawn or asked for after it
    var visible = false;
    var only = '';
    var hidden = new Set();
    // What an area is built from → { polys, multi, lines, boxes, bounds },
    // shared between scopes with the same members. Kept while a drawn scope
    // uses it.
    var cache = new Map();
    var used = new Set();
    var drawn = new Map();  // scope → [fill, line]
    var groups = new Map(); // scope → how many linked groups, for the click box
    var hits = [];          // [{ scope, layers, rings, boxes, bounds, text }] for hover
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

    // A node's radius: the operator's for its pubkey, or for the longest
    // configured prefix of it, else the mesh-wide one.
    function radiusOf(n) {
      if (!radiiKeys.length) return radiusM;
      var pk = String(n.public_key || '').toLowerCase(), best = '';
      for (var i = 0; i < radiiKeys.length; i++) {
        var k = radiiKeys[i];
        if (k.length > best.length && pk.indexOf(k) === 0) best = k;
      }
      return best ? radii[best] : radiusM;
    }
    function tubeHalfM() { return (tubeWidthM || radiusM * TUBE_RATIO) / 2; }

    function loadConfig() {
      if (configState !== 'needed') return;
      configState = 'asked';
      Promise.resolve(opts.loadMapConfig()).then(function (cfg) {
        var c = (cfg && cfg.contours) || {};
        var r = clampNum(c.radiusKm, MIN_RADIUS_M / 1000, MAX_RADIUS_M / 1000);
        if (r != null && !opts.radiusM) radiusM = r * 1000;
        var t = clampNum(c.tubeWidthKm, MIN_TUBE_M / 1000, MAX_TUBE_M / 1000);
        if (t != null && !opts.tubeWidthM) tubeWidthM = t * 1000;
        var own = c.radii || {};
        Object.keys(own).forEach(function (k) {
          var v = clampNum(own[k], MIN_RADIUS_M / 1000, MAX_RADIUS_M / 1000);
          if (v != null && k) radii[String(k).toLowerCase()] = v * 1000;
        });
        radiiKeys = Object.keys(radii);
      }, function () { /* the defaults stand */ }).then(function () {
        configState = 'done';
        if (!destroyed && visible) render();
      });
    }

    function groupsOf(scope) { return groups.get(scope) || 0; }
    var colours = new Map(); // scope → colour, set each render
    function colourOf(scope) { return colours.get(scope) || 1; }

    // area builds, or finds in the cache, the shapes of one scope's members:
    // an octagon each and a band for each link between two of them. The key
    // is order-free and cheap: how many members and links, and the sum and
    // xor of a hash of each member (key, position, radius) and each link.
    function area(members) {
      var idx = new Map(), items = [], pairs = [];
      var sum = 0, xor = 0, h;
      function mix(v) { h = Math.imul(h ^ (v | 0), 16777619); }
      function mixStr(s) { for (var c = 0; c < s.length; c++) mix(s.charCodeAt(c)); }
      function fold() { sum = (sum + (h >>> 0)) % 4294967296; xor ^= h; }
      members.forEach(function (n, i) {
        var p = position(n), r = radiusOf(n);
        idx.set(n.public_key, i);
        items.push({ lat: p[0], lon: p[1], r: r });
        h = 2166136261; mixStr(n.public_key); mix(Math.round(p[0] * 1e6)); mix(Math.round(p[1] * 1e6)); mix(Math.round(r));
        fold();
      });
      if (peers) {
        members.forEach(function (n, i) {
          (peers.get(n.public_key) || []).forEach(function (pk) {
            var j = idx.get(pk);
            if (j == null || j <= i) return;
            pairs.push([i, j]);
            h = 2166136261; mixStr(n.public_key); mix(124); mixStr(pk);
            fold();
          });
        });
      }
      var half = tubeHalfM();
      var key = items.length + '|' + pairs.length + '|' + sum + '|' + (xor >>> 0) + '|' + Math.round(half);
      used.add(key);
      var e = cache.get(key);
      if (e) return e;
      computed++;
      var polys = G.linkShapes(items, pairs, half);
      e = {
        polys: polys,
        // One polygon per shape, filled non-zero: overlaps neither darken
        // nor cancel.
        multi: polys.map(function (r) { return [r]; }),
        lines: G.outline(polys),
        boxes: polys.map(function (r) { return G.ringsBounds([r]); }),
        bounds: G.ringsBounds(polys),
      };
      cache.set(key, e);
      return e;
    }

    // draw adds a scope's fill and its outline, and returns both layers.
    // Hover and pulse light them together.
    function draw(scope, members, text) {
      var e = area(members);
      if (!e.polys.length) return [];
      var n = linkedGroups(members, peers).length;
      groups.set(scope, n);
      if (n > 1) text += ' · ' + n + ' separate groups';
      var cls = 'mc-scope-area mc-reach-c' + colourOf(scope);
      var fill = L.polygon(e.multi, { pane: PANE, renderer: renderer, interactive: false,
        stroke: false, fillRule: 'nonzero', className: cls + ' mc-scope-fill' });
      var line = L.polyline(e.lines, { pane: PANE, renderer: renderer, interactive: false,
        fill: false, className: cls + ' mc-scope-line' });
      var layers = [fill, line];
      layers.forEach(function (l) {
        layer.addLayer(l);
        var el = l.getElement && l.getElement();
        if (el && el.setAttribute) el.setAttribute('data-scope', scope);
      });
      hits.push({ scope: scope, layers: layers, rings: e.polys, boxes: e.boxes, bounds: e.bounds, text: text });
      return layers;
    }

    function render() {
      if (destroyed) return;
      clearHover();
      layer.clearLayers();
      drawn = new Map();
      groups = new Map();
      hits = [];
      used = new Set();
      var byScope = visible ? groupNodesByScope(nodes) : new Map();
      if (visible && configState === 'needed') loadConfig();
      var ready = configState === 'done';
      if (visible && ready && !peers) peers = memberLinks(nodes, links);
      var want = normRegion(only);
      list = [];
      // Over every scope in the node list, so hiding or narrowing to one
      // never recolours the rest.
      colours = colorsFor(Array.from(byScope.keys()));
      byScope.forEach(function (g, scope) {
        var all = g.observed.concat(g.configuredOnly);
        list.push({ scope: scope, colour: colourOf(scope), nodes: all.length, carrying: g.observed.length, hidden: hidden.has(scope) });
        if (!ready || (want && scope !== want) || hidden.has(scope)) return;
        var layers = draw(scope, all, '#' + escapeHtml(scope) + ' · ' + plural(all.length));
        if (layers.length) drawn.set(scope, layers);
      });
      list.sort(function (a, b) { return a.scope < b.scope ? -1 : (a.scope > b.scope ? 1 : 0); });
      // Bounded by the scopes drawn now: an area nothing uses leaves the
      // cache (a hidden scope rebuilds its own when shown again).
      if (visible && ready) Array.from(cache.keys()).forEach(function (k) { if (!used.has(k)) cache.delete(k); });
      var info = { radiusM: radiusM };
      listeners.forEach(function (fn) { fn(list, visible, info); });
    }

    function refreshLinks() {
      if (!visible || !opts.loadLinks || destroyed) return;
      var seq = ++linksSeq;
      Promise.resolve(opts.loadLinks()).then(function (edges) {
        if (seq !== linksSeq || destroyed) return;
        links = Array.isArray(edges) ? edges : [];
        peers = null;
        render();
      }, function () { /* octagons alone; the next reload retries */ });
    }

    // ── hover and click ──
    function hitsAt(ll) {
      var lat = ll.lat, lon = ll.lng;
      var found = [];
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i], b = h.bounds;
        if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
        if (G.inAny(h.rings, lat, lon, h.boxes)) found.push(h);
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
      found.forEach(function (h) { hovered = hovered.concat(h.layers); });
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
      raf(function () { moveQueued = false; if (moveAt && visible && !destroyed && !popupOpen()) hoverAt(moveAt); });
    }
    function onOut() { moveAt = null; clearHover(); }
    // A click inside areas lists each scope's repeaters. A click that
    // started on another layer (a live node, a packet path) bubbles here with
    // that layer as sourceTarget: it belongs to that layer, not to us.
    function onClick(e) {
      if (!visible || !hits.length) return;
      if (e.sourceTarget && e.sourceTarget !== map) return;
      var scopes = hitsAt(e.latlng).map(function (h) { return h.scope; });
      if (!scopes.length) return;
      clearHover();
      popup.setLatLng(e.latlng);
      popup.setContent(scopePopupHtml(scopes, nodes, groupsOf, colourOf));
      popup.openOn(map);
    }
    map.on('mousemove', onMove);
    map.on('mouseout', onOut);
    map.on('click', onClick);

    return {
      layer: layer,
      setNodes: function (l) { nodes = l || []; peers = null; render(); refreshLinks(); },
      setLinks: function (edges) { linksSeq++; links = edges || []; peers = null; render(); },
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
      scopes: function () { return list.slice(); },
      isVisible: function () { return visible; },
      onChange: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      },
      pulse: function (scope) { if (visible && drawn.has(normRegion(scope))) pulser.pulse(scope); },
      destroy: function () {
        destroyed = true;
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

  // areaNote says what an area is, with the radius it is drawn with.
  function areaNote(radiusM) {
    var km = Math.round((radiusM || DEFAULT_RADIUS_M) / 100) / 10;
    return 'Schematic, not measured coverage: each area is an octagon ' + km + ' km round every repeater of the scope ' +
      '(or the radius its operator set), with a thin band joining two that hear each other.';
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
      '<div class="mc-scope-hint">' + areaNote(info && info.radiusM) + ' Click an area to list its repeaters.</div>';
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

  window.ScopeContours = {
    hashFlag: hashFlag,
    hiddenFromHash: hiddenFromHash,
    writeHashFlag: writeHashFlag,
    normRegion: normRegion,
    nodeRegionEvidence: nodeRegionEvidence,
    groupNodesByScope: groupNodesByScope,
    configuredScopes: configuredScopes,
    carriedScopes: carriedScopes,
    scopePopupHtml: scopePopupHtml,
    memberLinks: memberLinks,
    linkedGroups: linkedGroups,
    areaNote: areaNote,
    defaultRadiusM: DEFAULT_RADIUS_M,
    colorsFor: colorsFor,
    createPulser: createPulser,
    createOverlay: createOverlay,
    mountScopeList: mountScopeList,
  };
})();
