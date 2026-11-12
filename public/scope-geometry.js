/* Geometry for the region contours (scope-contours.js): pure functions on
   plain shapes, with no nodes, map or DOM in them.

   A region is drawn schematically, from what is known and nothing more:
   - roundedOctagon: a fixed radius round each member repeater. Eight
     sides, so it reads as "roughly here", not as a measured edge; the
     corners rounded off.
   - tube: a narrow band between two members that hear each other.
   - linkShapes: both, for one linked group of members.
   - outline: the outer edge of a set of shapes, the lines between
     overlapping ones left out.
   - inAny / ringsBounds: point-in-area tests for hover and click.
   Every shape is a convex ring of [lat, lon], anticlockwise seen north-up.
   Metres are projected locally (east/north of a reference point), so a
   degree of longitude is not taken for a degree of latitude. */
(function () {
  'use strict';

  var M_PER_DEG = 111320;
  var RAD = Math.PI / 180;
  // An octagon's flat sides are this fraction of its radius from the centre.
  var APOTHEM = Math.cos(Math.PI / 8);
  // Corner k is at 22.5° + 45°·k from east: flat sides face the compass points.
  var OCT_X = [], OCT_Y = [];
  for (var k = 0; k < 8; k++) {
    OCT_X.push(Math.cos((22.5 + 45 * k) * RAD));
    OCT_Y.push(Math.sin((22.5 + 45 * k) * RAD));
  }
  // A member's octagon has its corners rounded off with arcs of this
  // fraction of its radius, each drawn in this many steps (15° a step).
  var CORNER_RATIO = 0.25;
  var CORNER_STEPS = 3;
  // Clipping tolerances: a point this near an edge (metres) is on it, and a
  // piece this short (fraction of its edge) is nothing.
  var EPS_M = 1e-6;
  var EPS_T = 1e-9;

  // octagon is the ring of a regular octagon with its corners rM metres
  // from (lat, lon).
  function octagon(lat, lon, rM) {
    var dLat = rM / M_PER_DEG, dLon = rM / (M_PER_DEG * Math.cos(lat * RAD));
    var ring = [];
    for (var i = 0; i < 8; i++) ring.push([lat + OCT_Y[i] * dLat, lon + OCT_X[i] * dLon]);
    return ring;
  }

  // roundedOctagon is the octagon of radius rM with each corner replaced by
  // an arc: the flat sides stay where they are (so a tube meets them as it
  // meets a plain octagon's), and the corners are pulled in a little. Still
  // convex and anticlockwise.
  function roundedOctagon(lat, lon, rM) {
    var c = rM * CORNER_RATIO;
    // The octagon the arcs' centres sit on: its sides c inside the outer's.
    var inner = (rM * APOTHEM - c) / APOTHEM;
    var kLat = 1 / M_PER_DEG, kLon = 1 / (M_PER_DEG * Math.cos(lat * RAD));
    var ring = [];
    for (var i = 0; i < 8; i++) {
      var mid = (22.5 + 45 * i) * RAD;
      var cx = inner * Math.cos(mid), cy = inner * Math.sin(mid);
      for (var s = 0; s <= CORNER_STEPS; s++) {
        var a = mid + (s / CORNER_STEPS - 0.5) * 45 * RAD;
        ring.push([lat + (cy + c * Math.sin(a)) * kLat, lon + (cx + c * Math.cos(a)) * kLon]);
      }
    }
    return ring;
  }

  // convexHull of [lat, lon] points as one anticlockwise ring (Andrew's
  // monotone chain); [] for fewer than three points off one line.
  function convexHull(points) {
    var pts = (points || []).slice().sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
    if (pts.length < 3) return [];
    function turn(o, a, b) { return (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]); }
    var h = [], i, lower;
    for (i = 0; i < pts.length; i++) {
      while (h.length >= 2 && turn(h[h.length - 2], h[h.length - 1], pts[i]) <= 0) h.pop();
      h.push(pts[i]);
    }
    lower = h.length + 1;
    for (i = pts.length - 2; i >= 0; i--) {
      while (h.length >= lower && turn(h[h.length - 2], h[h.length - 1], pts[i]) <= 0) h.pop();
      h.push(pts[i]);
    }
    h.pop();
    return h.length >= 3 ? h : [];
  }

  // tube is the band between a and b ({ lat, lon }): the hull of an octagon
  // of halfWidthM at each end, so it is between 92% and 100% of that either
  // side of the line.
  function tube(a, b, halfWidthM) {
    return convexHull(octagon(a.lat, a.lon, halfWidthM).concat(octagon(b.lat, b.lon, halfWidthM)));
  }

  function metresBetween(a, b) {
    var dy = (b.lat - a.lat) * M_PER_DEG;
    var dx = (b.lon - a.lon) * M_PER_DEG * Math.cos((a.lat + b.lat) / 2 * RAD);
    return Math.sqrt(dx * dx + dy * dy);
  }

  // linkShapes builds one group's shapes: a round-cornered octagon of its
  // own radius for each item ({ lat, lon, r } in metres), then a tube for
  // each pair ([i, j] into items) whose octagons do not already meet flat
  // side to flat side. A tube is halfWidthM either side, and never wider
  // than the smaller octagon it joins; its ends lie inside the octagons, so
  // they are left plain.
  function linkShapes(items, pairs, halfWidthM) {
    var polys = [];
    (items || []).forEach(function (it) { if (it.r > 0) polys.push(roundedOctagon(it.lat, it.lon, it.r)); });
    (pairs || []).forEach(function (p) {
      var a = items[p[0]], b = items[p[1]];
      if (!a || !b || !(a.r > 0) || !(b.r > 0)) return;
      if (metresBetween(a, b) <= (a.r + b.r) * APOTHEM) return;
      var hw = Math.min(halfWidthM, a.r, b.r);
      if (!(hw > 0)) return;
      var t = tube(a, b, hw);
      if (t.length) polys.push(t);
    });
    return polys;
  }

  // edgeLines precomputes a convex anticlockwise polygon's edges as lines:
  // for edge k, a·x + b·y − c is the distance (metres) of a point to its
  // left, positive inside. Float64Array [a0, b0, c0, a1, ...].
  function edgeLines(xs, ys) {
    var n = xs.length, out = new Float64Array(3 * n), k = 0;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var ex = xs[i] - xs[j], ey = ys[i] - ys[j];
      var len = Math.sqrt(ex * ex + ey * ey);
      if (!len) continue;
      var a = -ey / len, b = ex / len;
      out[k++] = a; out[k++] = b; out[k++] = a * xs[j] + b * ys[j];
    }
    return k === out.length ? out : out.subarray(0, k);
  }

  // insideSpan is the part of the segment P→Q strictly inside a convex
  // polygon (its edgeLines), as [t0, t1] along it, or null. A segment
  // lying along one of the polygon's edges is not inside it.
  function insideSpan(lines, px, py, qx, qy) {
    var t0 = 0, t1 = 1;
    for (var k = 0; k < lines.length; k += 3) {
      var a = lines[k], b = lines[k + 1], c = lines[k + 2];
      var dP = a * px + b * py - c, dQ = a * qx + b * qy - c;
      if (dP <= EPS_M) {
        if (dQ <= EPS_M) return null;
        var tin = dP / (dP - dQ); if (tin > t0) t0 = tin;
      } else if (dQ <= EPS_M) {
        var tout = dP / (dP - dQ); if (tout < t1) t1 = tout;
      } else continue;
      if (t1 - t0 <= EPS_T) return null;
    }
    return [t0, t1];
  }

  // outline is the outer edge of a set of convex anticlockwise rings: every
  // stretch of every ring's edge that is not inside another ring, as lines
  // of [lat, lon] (a ring nothing overlaps comes back closed). Stretches
  // that follow on from each other along a ring are one line, so corners
  // are joined. Two rings sharing an edge both keep it.
  //
  // Each ring is clipped only against the rings whose boxes overlap its own
  // (found by a sweep along x), and each edge only against those whose box
  // it enters: O(n log n + overlapping pairs × corners²) at worst.
  function outline(polys) {
    var n = (polys || []).length;
    if (!n) return [];
    var lat0 = polys[0][0][0], lon0 = polys[0][0][1], kx = M_PER_DEG * Math.cos(lat0 * RAD);
    var X = [], Y = [], LN = [], box = [], order = [], near = [], i, j;
    for (i = 0; i < n; i++) {
      var ring = polys[i], xs = new Float64Array(ring.length), ys = new Float64Array(ring.length);
      var b = [Infinity, -Infinity, Infinity, -Infinity];
      for (j = 0; j < ring.length; j++) {
        var x = (ring[j][1] - lon0) * kx, y = (ring[j][0] - lat0) * M_PER_DEG;
        xs[j] = x; ys[j] = y;
        if (x < b[0]) b[0] = x; if (x > b[1]) b[1] = x;
        if (y < b[2]) b[2] = y; if (y > b[3]) b[3] = y;
      }
      X.push(xs); Y.push(ys); LN.push(edgeLines(xs, ys)); box.push(b); order.push(i); near.push([]);
    }
    order.sort(function (p, q) { return box[p][0] - box[q][0]; });
    for (i = 0; i < n; i++) {
      var a = order[i];
      for (j = i + 1; j < n && box[order[j]][0] <= box[a][1]; j++) {
        var c = order[j];
        if (box[c][2] <= box[a][3] && box[c][3] >= box[a][2]) { near[a].push(c); near[c].push(a); }
      }
    }

    var lines = [];
    for (i = 0; i < n; i++) {
      var ringI = polys[i], xi = X[i], yi = Y[i], m = ringI.length, others = near[i];
      var runs = [], cur = null, firstFromStart = false;
      for (var e = 0; e < m; e++) {
        var f = (e + 1) % m, spans = [];
        var px = xi[e], py = yi[e], qx = xi[f], qy = yi[f];
        var loX = px < qx ? px : qx, hiX = px < qx ? qx : px, loY = py < qy ? py : qy, hiY = py < qy ? qy : py;
        for (j = 0; j < others.length; j++) {
          var o = others[j], ob = box[o];
          // An edge wholly to one side of the other shape's box is not in it.
          if (hiX <= ob[0] || loX >= ob[1] || hiY <= ob[2] || loY >= ob[3]) continue;
          var s = insideSpan(LN[o], px, py, qx, qy);
          if (s) spans.push(s);
        }
        if (spans.length > 1) spans.sort(function (p, q) { return p[0] - q[0]; });
        // The kept stretches of this edge: the gaps between the spans.
        var at = 0;
        for (j = 0; j <= spans.length; j++) {
          var end = j < spans.length ? spans[j][0] : 1;
          if (end - at > EPS_T) {
            var from = pointAt(ringI, e, f, at), to = pointAt(ringI, e, f, end);
            if (cur && at <= EPS_T) cur.push(to);
            else {
              cur = [from, to]; runs.push(cur);
              if (e === 0 && at <= EPS_T) firstFromStart = true;
            }
            if (end < 1 - EPS_T) cur = null;
          } else if (at <= EPS_T && end <= EPS_T) cur = null;
          if (j < spans.length && spans[j][1] > at) at = spans[j][1];
        }
      }
      // The last stretch runs into the ring's first corner: one line with
      // the stretch that starts there (itself, when nothing was cut).
      if (cur && firstFromStart && runs.length > 1) {
        var first = runs.shift();
        for (j = 1; j < first.length; j++) cur.push(first[j]);
      }
      for (j = 0; j < runs.length; j++) lines.push(runs[j]);
    }
    return lines;
  }

  // pointAt is the point a fraction t along the ring's edge e→f; the corner
  // itself at either end, so joined lines meet exactly.
  function pointAt(ring, e, f, t) {
    if (t <= EPS_T) return ring[e];
    if (t >= 1 - EPS_T) return ring[f];
    return [ring[e][0] + (ring[f][0] - ring[e][0]) * t, ring[e][1] + (ring[f][1] - ring[e][1]) * t];
  }

  // ── Hit testing ──────────────────────────────────────────────────────────

  function ringsBounds(rings) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    rings.forEach(function (r) {
      r.forEach(function (p) {
        if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1];
        if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1];
      });
    });
    return b;
  }

  // inAny: is the point inside any of the rings? Each is tested on its own,
  // so where two overlap the point is still inside, as the area is filled.
  // boxes, when given, holds each ring's ringsBounds([ring]), to skip the
  // rings that cannot hold the point.
  function inAny(rings, lat, lon, boxes) {
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      if (boxes) {
        var b = boxes[r];
        if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
      }
      var inside = false;
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var p = ring[i], q = ring[j];
        if ((p[0] > lat) !== (q[0] > lat) && lon < (q[1] - p[1]) * (lat - p[0]) / (q[0] - p[0]) + p[1]) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  window.ScopeGeometry = {
    mPerDeg: M_PER_DEG,
    apothem: APOTHEM,
    octagon: octagon,
    roundedOctagon: roundedOctagon,
    tube: tube,
    convexHull: convexHull,
    linkShapes: linkShapes,
    outline: outline,
    inAny: inAny,
    ringsBounds: ringsBounds,
  };
})();
