/* ------------------------------------------------------------------
   The commit tree: an optional side pane that draws the history the way
   learngitbranching.js.org does. Commits are circles named C0, C1, …
   in the order they came into being (plus a short hash, since this is a
   real repository), the first commit sits at the top, branches are
   labels pointing at their tips, and `main*` marks the branch HEAD is on.

   Every change animates: a new commit grows out of its parent and slides
   into place, branch labels glide to their new tips, and commits that
   are no longer reachable shrink away. That motion is the point of the
   pane; it lets learners see what a command did rather than diff two
   pictures in their head.

   createTreeView(svg) returns { update(graph, instant), reset(),
   redraw(), snapshot(), restore(snap), labelOf(oid) }. update takes the
   graph from sandbox.graphModel() and returns the layout it drew: commit
   positions by oid, and the scale the tree was drawn at.
   ------------------------------------------------------------------ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GitSandboxTree = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  // Same palette as the History graph, so a branch keeps its colour across
  // panels. Labels and commits use a pale tint with dark text: white text
  // on the teal and green would miss WCAG AA at these sizes.
  var COLORS = ['#447099', '#419599', '#72994E', '#9A4665', '#EE6331', '#3276B5'];
  var DETACHED = '#717171';

  var R = 18;          // commit radius
  var ROW_H = 72;      // vertical distance between generations
  var PAD_TOP = 34;
  var PAD_X = 24;
  var REF_GAP = 22;    // node edge to label, room for the arrow
  var REF_H = 22;
  var REF_STEP = 26;   // vertical distance between stacked labels
  var CHAR_W = 7.3;    // 12px Source Code Pro
  var DURATION = 600;

  function tint(hex, amount) {
    var n = parseInt(hex.slice(1), 16);
    var mix = function (c) { return Math.round(c + (255 - c) * amount); };
    var r = mix(n >> 16), g = mix((n >> 8) & 255), b = mix(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function ease(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function refWidth(text) { return Math.round(text.length * CHAR_W + 16); }

  function createTreeView(svg) {
    var doc = svg.ownerDocument;
    var win = doc.defaultView || {};

    function make(tag, attrs, parent) {
      var n = doc.createElementNS(NS, tag);
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      if (parent) parent.appendChild(n);
      return n;
    }

    /* ---------------------------- naming ---------------------------- */

    // oid -> { n, color }. Names are handed out once and kept, so C3 stays
    // C3 however the tree is rearranged; undo and reset rewind them along
    // with the repository through snapshot()/restore().
    var names = {};
    var nextN = 0;
    var branchColors = {};
    var nextColor = 0;

    function colorFor(branch) {
      if (branch == null) return DETACHED;
      if (!(branch in branchColors)) branchColors[branch] = nextColor++ % COLORS.length;
      return COLORS[branchColors[branch]];
    }

    // A commit takes the colour of the branch it was made on. For commits
    // that arrive in bulk (the seed, a fetch) that is the first ref that can
    // reach them, trying the checked-out branch first.
    function nameNewCommits(graph) {
      var fresh = graph.commits.filter(function (c) { return !(c.oid in names); });
      if (!fresh.length) return;
      var byOid = {};
      graph.commits.forEach(function (c) { byOid[c.oid] = c; });

      var tips = [];
      if (graph.head) tips.push({ branch: graph.head, oid: graph.headOid });
      else if (graph.headOid) tips.push({ branch: null, oid: graph.headOid });
      var others = [];
      graph.commits.forEach(function (c) {
        (c.refs || []).forEach(function (r) { if (r.name !== graph.head) others.push({ name: r.name, oid: c.oid, remote: r.remote }); });
      });
      others.sort(function (a, b) {
        if (a.remote !== b.remote) return a.remote ? 1 : -1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
      others.forEach(function (r) {
        tips.push({ branch: r.remote ? r.name.replace(/^origin\//, '') : r.name, oid: r.oid });
      });

      var owner = {};
      tips.forEach(function (t) {
        var stack = [t.oid], seen = {};
        while (stack.length) {
          var oid = stack.pop();
          if (!oid || seen[oid] || !byOid[oid]) continue;
          seen[oid] = true;
          if (!(oid in owner)) owner[oid] = t.branch;
          byOid[oid].parents.forEach(function (p) { stack.push(p); });
        }
      });

      // graph.commits is children first; name oldest first so C0 is the root
      for (var i = graph.commits.length - 1; i >= 0; i--) {
        var c = graph.commits[i];
        if (c.oid in names) continue;
        names[c.oid] = { n: nextN++, color: colorFor(c.oid in owner ? owner[c.oid] : graph.head) };
      }
    }

    /* ---------------------------- layout ---------------------------- */

    // learngitbranching's layout: each commit hangs under its first parent,
    // one generation per row, and a commit's children share out the width
    // beneath it. A merge commit sits below the lower of its parents.
    function layout(graph, width) {
      var commits = graph.commits;
      var present = {};
      commits.forEach(function (c) { present[c.oid] = c; });
      var depth = {};
      var kids = {};
      var roots = [];
      for (var i = commits.length - 1; i >= 0; i--) {
        var c = commits[i];
        var d = 0;
        c.parents.forEach(function (p) { if (p in depth) d = Math.max(d, depth[p] + 1); });
        depth[c.oid] = d;
        kids[c.oid] = [];
        var first = c.parents.filter(function (p) { return p in present; })[0];
        if (first) kids[first].push(c.oid); else roots.push(c.oid);
      }
      var byN = function (a, b) { return names[a].n - names[b].n; };
      roots.sort(byN);
      Object.keys(kids).forEach(function (k) { kids[k].sort(byN); });

      var span = {};
      function measure(oid) {
        var w = 0;
        kids[oid].forEach(function (k) { w += measure(k); });
        span[oid] = Math.max(1, w);
        return span[oid];
      }
      var units = 0;
      roots.forEach(function (r) { units += measure(r); });

      // Column width leaves room for the widest label beside a commit, so a
      // branch name never runs into the next column.
      var refs = refLayout(graph);
      var widest = 0;
      Object.keys(refs).forEach(function (k) { widest = Math.max(widest, refs[k].w); });
      var colW = Math.max(72, R + REF_GAP + widest + 30);
      // from the leftmost commit's rim to the end of the rightmost label
      var treeW = (units - 1) * colW + 2 * R + (widest ? REF_GAP + widest : 0);
      var fullW = Math.max(width, treeW + PAD_X * 2);
      var offset = (fullW - treeW) / 2;

      var pos = {};
      function place(oid, start) {
        pos[oid] = { x: offset + (start + span[oid] / 2) * colW - colW / 2 + R, y: PAD_TOP + depth[oid] * ROW_H };
        var s = start;
        kids[oid].forEach(function (k) { place(k, s); s += span[k]; });
      }
      var s0 = 0;
      roots.forEach(function (r) { place(r, s0); s0 += span[r]; });

      var maxDepth = 0;
      Object.keys(depth).forEach(function (k) { maxDepth = Math.max(maxDepth, depth[k]); });
      return { pos: pos, refs: refs, width: Math.ceil(fullW), height: PAD_TOP + maxDepth * ROW_H + R + 34 };
    }

    // Labels per commit, local branches first, the checked-out one on top.
    function refLayout(graph) {
      var out = {};
      graph.commits.forEach(function (c) {
        var list = (c.refs || []).map(function (r) {
          return { key: r.name, text: r.name + (r.isHead ? '*' : ''), head: !!r.isHead, remote: !!r.remote };
        });
        if (graph.detached && c.oid === graph.headOid) list.unshift({ key: 'HEAD', text: 'HEAD', head: true, detached: true });
        list.sort(function (a, b) {
          if (a.head !== b.head) return a.head ? -1 : 1;
          if (a.remote !== b.remote) return a.remote ? 1 : -1;
          return 0;
        });
        list.forEach(function (r, i) {
          r.oid = c.oid;
          r.dy = (i - (list.length - 1) / 2) * REF_STEP;
          r.w = refWidth(r.text);
          out[r.key] = r;
        });
      });
      return out;
    }

    /* ---------------------------- drawing --------------------------- */

    var edgeLayer = make('g', { 'class': 'gs-tree-edges' }, svg);
    var nodeLayer = make('g', { 'class': 'gs-tree-nodes' }, svg);
    var refLayer = make('g', { 'class': 'gs-tree-refs' }, svg);
    var emptyText = null;

    // Everything on screen is an item with a current state ({x, y, s, o},
    // plus dy for labels) that tweens towards a target.
    var nodes = {};   // oid -> item
    var edges = {};   // 'child parent' -> item
    var labels = {};  // ref key -> item
    var raf = null;

    function applyNode(it) {
      it.g.setAttribute('transform', 'translate(' + it.cur.x.toFixed(1) + ',' + it.cur.y.toFixed(1) + ') scale(' + it.cur.s.toFixed(3) + ')');
      it.g.setAttribute('opacity', it.cur.o.toFixed(3));
    }

    function applyLabel(it) {
      var c = it.cur;
      it.g.setAttribute('transform', 'translate(' + c.x.toFixed(1) + ',' + c.y.toFixed(1) + ')');
      it.g.setAttribute('opacity', c.o.toFixed(3));
      it.box.setAttribute('y', (c.dy - REF_H / 2).toFixed(1));
      it.text.setAttribute('y', (c.dy + 4).toFixed(1));
      // arrow from the label's left edge to the commit's rim
      var tx = R + 3, ty = 0, fx = R + REF_GAP, fy = c.dy;
      var ang = Math.atan2(fy - ty, fx - tx);
      var a1 = ang + 0.45, a2 = ang - 0.45, L = 7;
      it.arrow.setAttribute('d',
        'M' + fx.toFixed(1) + ',' + fy.toFixed(1) + ' L' + tx.toFixed(1) + ',' + ty.toFixed(1) +
        ' M' + (tx + L * Math.cos(a1)).toFixed(1) + ',' + (ty + L * Math.sin(a1)).toFixed(1) +
        ' L' + tx.toFixed(1) + ',' + ty.toFixed(1) +
        ' L' + (tx + L * Math.cos(a2)).toFixed(1) + ',' + (ty + L * Math.sin(a2)).toFixed(1));
    }

    function applyEdge(it) {
      var a = nodes[it.child], b = nodes[it.parent];
      if (!a || !b) return;
      var x1 = a.cur.x, y1 = a.cur.y, x2 = b.cur.x, y2 = b.cur.y;
      var my = (y1 + y2) / 2;
      it.path.setAttribute('d', 'M' + x1.toFixed(1) + ',' + y1.toFixed(1) +
        ' C' + x1.toFixed(1) + ',' + my.toFixed(1) + ' ' + x2.toFixed(1) + ',' + my.toFixed(1) +
        ' ' + x2.toFixed(1) + ',' + y2.toFixed(1));
      it.path.setAttribute('opacity', (Math.min(a.cur.o, b.cur.o) * 0.9).toFixed(3));
    }

    function newNode(oid, c) {
      var nm = names[oid];
      var g = make('g', { 'class': 'gs-tree-node', 'data-oid': oid }, nodeLayer);
      var title = make('title', {}, g);
      title.textContent = 'C' + nm.n + ' ' + c.short + ': ' + c.message;
      var circle = make('circle', { r: R, fill: tint(nm.color, 0.8), stroke: nm.color, 'stroke-width': 2.5 }, g);
      var label = make('text', { 'class': 'gs-tree-c', 'text-anchor': 'middle', y: 5 }, g);
      label.textContent = 'C' + nm.n;
      var sha = make('text', { 'class': 'gs-tree-sha', 'text-anchor': 'middle', y: R + 14 }, g);
      sha.textContent = c.short;
      return { g: g, circle: circle, cur: null, from: null, to: null };
    }

    function newLabel(r) {
      var g = make('g', { 'class': 'gs-tree-ref', 'data-ref': r.key }, refLayer);
      var color = r.detached ? '#111C26' : r.remote ? '#717171' : colorFor(r.key);
      var arrow = make('path', { fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      var box = make('rect', { x: R + REF_GAP, height: REF_H, rx: 5 }, g);
      var text = make('text', { x: R + REF_GAP + 8 }, g);
      return { g: g, arrow: arrow, box: box, text: text, color: color, cur: null };
    }

    function styleLabel(it, r) {
      it.text.textContent = r.text;
      it.box.setAttribute('width', r.w);
      var cls = 'gs-tree-ref-text' + (r.head ? ' is-head' : '') + (r.remote ? ' is-remote' : '');
      it.text.setAttribute('class', cls);
      if (r.detached) {
        it.box.setAttribute('fill', '#111C26');
        it.box.setAttribute('stroke', '#111C26');
        it.text.setAttribute('class', cls + ' is-detached');
      } else if (r.remote) {
        it.box.setAttribute('fill', '#FFFFFF');
        it.box.setAttribute('stroke', '#717171');
        it.box.setAttribute('stroke-dasharray', '3 2');
      } else {
        it.box.setAttribute('fill', tint(it.color, r.head ? 0.62 : 0.85));
        it.box.setAttribute('stroke', it.color);
      }
      it.box.setAttribute('stroke-width', r.head ? 2 : 1.2);
    }

    function frame() {
      raf = null;
      var now = Date.now();
      var busy = false;
      function step(it, apply) {
        if (!it.to) return;
        var t = it.t0 == null ? 1 : Math.min(1, (now - it.t0) / DURATION);
        var e = ease(t);
        Object.keys(it.to).forEach(function (k) { it.cur[k] = lerp(it.from[k], it.to[k], e); });
        apply(it);
        if (t < 1) busy = true;
        else it.to = null;
      }
      Object.keys(nodes).forEach(function (k) { step(nodes[k], applyNode); });
      Object.keys(labels).forEach(function (k) { step(labels[k], applyLabel); });
      Object.keys(edges).forEach(function (k) { applyEdge(edges[k]); });
      if (busy) { schedule(); return; }
      // the tween is over: drop what faded out
      [nodes, labels, edges].forEach(function (set) {
        Object.keys(set).forEach(function (k) {
          if (set[k].dying) {
            var n = set[k].g || set[k].path;
            if (n.parentNode) n.parentNode.removeChild(n);
            delete set[k];
          }
        });
      });
    }

    function animated() {
      if (typeof win.requestAnimationFrame !== 'function') return false;
      try {
        if (win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
      } catch (e) { /* no matchMedia */ }
      return true;
    }

    function schedule() {
      if (raf == null) raf = win.requestAnimationFrame(frame);
    }

    function go(it, to, instant) {
      it.from = {};
      Object.keys(to).forEach(function (k) { it.from[k] = it.cur[k]; });
      it.to = to;
      it.t0 = instant ? null : Date.now();
    }

    var lastGraph = null;

    function update(graph, instant) {
      lastGraph = graph;
      instant = instant || !animated();
      nameNewCommits(graph);
      // the scroll box's width: the svg's own is whatever it was last drawn at
      var width = (svg.parentNode && svg.parentNode.clientWidth) || 300;
      var lay = layout(graph, width);
      // A tree wider than the pane shrinks to fit, as learngitbranching's
      // does, but only so far: past that, small text is worse than a
      // sideways scroll.
      lay.scale = Math.max(0.7, Math.min(1, width / lay.width));
      svg.setAttribute('viewBox', '0 0 ' + lay.width + ' ' + lay.height);
      svg.setAttribute('width', String(Math.floor(lay.width * lay.scale)));
      svg.setAttribute('height', String(Math.ceil(lay.height * lay.scale)));

      if (!graph.commits.length) {
        if (!emptyText) {
          emptyText = make('text', { 'class': 'gs-empty-text', 'text-anchor': 'middle', y: 40 }, svg);
          emptyText.textContent = 'No commits yet.';
        }
        emptyText.setAttribute('x', String(width / 2));
      } else if (emptyText) {
        svg.removeChild(emptyText);
        emptyText = null;
      }

      var byOid = {};
      graph.commits.forEach(function (c) { byOid[c.oid] = c; });

      // Nodes: new ones start on their first parent, small, and grow out of
      // it. Oldest first, so a run of new commits unrolls from one point.
      graph.commits.slice().reverse().forEach(function (c) {
        var p = lay.pos[c.oid];
        var it = nodes[c.oid];
        if (!it || it.dying) {
          if (it) { it.g.parentNode.removeChild(it.g); }
          it = nodes[c.oid] = newNode(c.oid, c);
          var parent = nodes[c.parents[0]];
          var start = parent && !parent.dying ? parent.cur : p;
          it.cur = { x: start.x, y: start.y, s: 0.2, o: 0 };
        }
        it.dying = false;
        go(it, { x: p.x, y: p.y, s: 1, o: 1 }, instant);
      });
      Object.keys(nodes).forEach(function (oid) {
        if (byOid[oid]) return;
        var it = nodes[oid];
        it.dying = true;
        go(it, { s: 0.2, o: 0 }, instant);
      });

      // edges follow their nodes every frame
      var wanted = {};
      graph.commits.forEach(function (c) {
        c.parents.forEach(function (p) {
          if (!byOid[p]) return;
          var key = c.oid + ' ' + p;
          wanted[key] = true;
          if (!edges[key] || edges[key].dying) {
            if (edges[key]) edgeLayer.removeChild(edges[key].path);
            edges[key] = { child: c.oid, parent: p, path: make('path', { 'class': 'gs-tree-edge', fill: 'none' }, edgeLayer) };
          }
          edges[key].dying = false;
          edges[key].path.setAttribute('stroke', names[c.oid].color);
        });
      });
      Object.keys(edges).forEach(function (k) { if (!wanted[k]) edges[k].dying = true; });

      // labels glide from tip to tip; a brand-new label fades in where it lands
      Object.keys(lay.refs).forEach(function (key) {
        var r = lay.refs[key];
        var p = lay.pos[r.oid];
        var it = labels[key];
        if (!it || it.dying) {
          if (it) refLayer.removeChild(it.g);
          it = labels[key] = newLabel(r);
          var n = nodes[r.oid];
          var from = n && n.cur ? n.cur : p;
          it.cur = { x: from.x, y: from.y, dy: r.dy, o: 0 };
        }
        it.dying = false;
        styleLabel(it, r);
        go(it, { x: p.x, y: p.y, dy: r.dy, o: 1 }, instant);
      });
      Object.keys(labels).forEach(function (key) {
        if (lay.refs[key]) return;
        labels[key].dying = true;
        go(labels[key], { o: 0 }, instant);
      });

      // Screen readers get the tree in words: what each branch points at.
      var heads = Object.keys(lay.refs).map(function (k) {
        var r = lay.refs[k];
        return r.text + ' at C' + names[r.oid].n;
      });
      svg.setAttribute('aria-label', graph.commits.length
        ? 'Commit tree, ' + graph.commits.length + ' commit' + (graph.commits.length === 1 ? '' : 's') +
          (heads.length ? ': ' + heads.join(', ') : '')
        : 'Commit tree, no commits yet');

      if (instant) frame(); else schedule();
      return lay;
    }

    function clear() {
      [nodes, labels, edges].forEach(function (set) {
        Object.keys(set).forEach(function (k) {
          var n = set[k].g || set[k].path;
          if (n.parentNode) n.parentNode.removeChild(n);
          delete set[k];
        });
      });
    }

    return {
      update: update,
      // forget every name, as a fresh repository would
      reset: function () {
        names = {}; nextN = 0; branchColors = {}; nextColor = 0;
        clear();
      },
      // redraw the last graph at the pane's current width, without motion
      redraw: function () { if (lastGraph) update(lastGraph, true); },
      snapshot: function () {
        return { names: Object.assign({}, names), nextN: nextN,
                 branchColors: Object.assign({}, branchColors), nextColor: nextColor };
      },
      restore: function (s) {
        names = Object.assign({}, s.names); nextN = s.nextN;
        branchColors = Object.assign({}, s.branchColors); nextColor = s.nextColor;
      },
      labelOf: function (oid) { return names[oid] ? 'C' + names[oid].n : null; }
    };
  }

  // tint is shared with the History graph, so both panels draw alike
  return { createTreeView: createTreeView, tint: tint, COLORS: COLORS };
});
