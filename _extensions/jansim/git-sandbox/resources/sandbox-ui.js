/* ------------------------------------------------------------------
   git sandbox UI: terminal + file editor + staging diagram + commit graph.
   Depends on window.GitSandboxCore and window.git (isomorphic-git UMD).
   ------------------------------------------------------------------ */
(function (root) {
  'use strict';

  // Small stroke icons for the file browser; currentColor keeps them on theme.
  function icon(d) {
    return '<svg class="gs-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  var ICON_CHEVRON = icon('M6 4l4 4-4 4');
  var ICON_UP = icon('M8 13V3M4 7l4-4 4 4');
  var ICON_HOME = icon('M3 8l5-4.5L13 8M4.5 7v6h7V7');
  var ICON_PLUS = icon('M8 3v10M3 8h10');
  // a small commit graph: two branches off a trunk
  var ICON_TREE = '<svg class="gs-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
    '<path d="M5 5.3v5.4M5 10c0-2.5 6-2 6-4.7"/>' +
    '<circle cx="5" cy="3.5" r="1.8"/><circle cx="5" cy="12.5" r="1.8"/><circle cx="11" cy="3.5" r="1.8"/></g></svg>';

  var PANEL_NAMES = ['files', 'changes', 'history', 'remote'];

  // `tree-view` and `panels` take true (always shown), false (left out
  // entirely) or 'toggle' (shown, with a button to fold it away). Anything
  // else falls back to the default.
  function showMode(v, dflt) {
    if (v === true || v === false || v === 'toggle') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return dflt;
  }

  // the commit tree's palette, so a branch keeps its colour across panels
  var LANE_COLORS = root.GitSandboxTree.COLORS;
  var tint = root.GitSandboxTree.tint;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // {g} green {r} red {y} yellow {b} blue {w} bold {/} reset
  function markup(s) {
    var map = { g: 'tg', r: 'tr', y: 'ty', b: 'tb', w: 'tw' };
    var out = esc(s);
    out = out.replace(/\{([grybw])\}/g, function (_m, k) { return '<span class="' + map[k] + '">'; });
    out = out.replace(/\{\/\}/g, '</span>');
    return out;
  }

  /* --------------------- config normalisation ------------------------ */

  // Authors can describe a task three ways:
  //   check: async (c) => ...     a JavaScript predicate (hand-written qmd)
  //   when:  'commits >= 2'       the declarative mini-language (extension)
  //   js:    'c.isRepo'           an escape hatch for the extension
  // Normalise all three to a `check` function, recording any compile error so
  // it can be shown in place instead of failing silently.
  function normaliseTasks(tasks) {
    var W = root.GitSandboxWhen;
    return (tasks || []).map(function (t) {
      var task = { text: t.text, _done: false, _error: null, _files: [] };
      if (typeof t.check === 'function') {
        task.check = t.check;
        return task;
      }
      if (!W) {
        task._error = 'the `when:` compiler is not loaded';
        task.check = function () { return false; };
        return task;
      }
      try {
        if (typeof t.when === 'string' && t.when.trim() !== '') {
          task._files = W.filesNeeded(t.when);
          task.check = W.compileWhen(t.when);
        } else if (typeof t.js === 'string' && t.js.trim() !== '') {
          task.check = W.compileJs(t.js);
        } else {
          throw new Error('a task needs one of `when:`, `js:` or a `check` function');
        }
      } catch (e) {
        task._error = e.message;
        task.check = function () { return false; };
      }
      return task;
    });
  }

  // Commands as a list, or as a block with one per line. Blank lines and
  // # comments are dropped.
  function commandLines(v) {
    if (!v) return [];
    return (Array.isArray(v) ? v : String(v).split('\n'))
      .map(function (l) { return String(l).trim(); })
      .filter(function (l) { return l !== '' && l.charAt(0) !== '#'; });
  }

  // `seed` may be a function or a block of commands from YAML.
  function normaliseSeed(seed) {
    if (typeof seed === 'function') return seed;
    var lines = commandLines(seed);
    if (!lines.length) return null;
    return async function (sb) {
      for (var i = 0; i < lines.length; i++) {
        var r = await sb.run(lines[i]);
        if (r.editor) {
          throw new Error('seed command opened an editor: ' + lines[i] + ' — give git commit a message with -m');
        }
        // a seed may leave a merge stopped on conflicts for the learner to resolve
        if (!r.ok && !r.conflict) {
          // A broken seed is an authoring bug, so make it loud rather than
          // leaving the learner in a half-built repository.
          throw new Error('seed command failed: ' + lines[i] + ' — ' + String(r.out).split('\n')[0]);
        }
      }
    };
  }

  function normaliseIntro(intro) {
    if (!intro) return [];
    if (Array.isArray(intro)) return intro;
    return String(intro).replace(/\n$/, '').split('\n');
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* --------------------------- commit graph -------------------------- */

  function svgEl(tag, attrs, parent, text) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function laneColor(lane) { return LANE_COLORS[lane % LANE_COLORS.length]; }

  function maxLane(model) {
    return model.commits.reduce(function (m, c) { return Math.max(m, c.lane); }, 0);
  }

  // x where a commit row's text (refs, sha, message) starts
  function graphTextX(model) { return 22 + maxLane(model) * 24 + 22 + 6; }

  // Clear the SVG; with no commits, say so and return true.
  function startGraph(svg, model, W, h) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (model.commits.length) return false;
    sizeGraph(svg, W, h);
    svgEl('text', { x: W / 2, y: h / 2 + 4, 'text-anchor': 'middle', 'class': 'gs-empty-text' }, svg, 'No commits yet.');
    return true;
  }

  function sizeGraph(svg, W, h) {
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + h);
    svg.setAttribute('height', String(h));
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  }

  // `extra`, for the local history only: { onToggle(oid), open: { oid: px } }.
  // Each row then gets a chevron that opens the commit's contents, and an
  // open row grows by its px so the details (an HTML layer the caller
  // places) fit beneath it with the lanes running on past them. Returns
  // { detailTop: { oid: y } } for that placement.
  function renderGraph(svg, model, extra) {
    extra = extra || {};
    var open = extra.open || {};
    var layout = { detailTop: {} };
    // Draw at the SVG's real pixel width so nothing overflows sideways; the
    // graph never needs a horizontal scrollbar.
    var W = svg.clientWidth || 640;
    if (startGraph(svg, model, W, 60)) return layout;

    var rowH = 44, laneW = 24, padTop = 26, padLeft = 22, lineH = 17;
    var graphW = graphTextX(model) - 6;
    var toggleW = extra.onToggle ? 28 : 0;

    // Wrap a commit message to a character budget, breaking on spaces and
    // hard-breaking any single word longer than the line.
    function wrapWords(text, maxChars) {
      var lines = [], cur = '';
      String(text).split(/\s+/).forEach(function (w) {
        if (!cur) cur = w;
        else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
        else { lines.push(cur); cur = w; }
      });
      if (cur) lines.push(cur);
      var out = [];
      lines.forEach(function (l) {
        while (l.length > maxChars) { out.push(l.slice(0, maxChars)); l = l.slice(maxChars); }
        out.push(l);
      });
      return out.length ? out : [''];
    }

    // First pass: place refs/sha/message per row and measure the wrapped height.
    var rows = model.commits.map(function (c) {
      var tx = graphW + 6;
      var refLayouts = (c.refs || []).map(function (r) {
        var label = (r.isHead ? 'HEAD → ' : '') + r.name;
        var w = label.length * (r.isHead ? 7.1 : 6.6) + 14;  // the HEAD label is bold
        var lay = { label: label, x: tx, w: w, isHead: r.isHead, remote: r.remote };
        tx += w + 6;
        return lay;
      });
      var msgX = tx + 62;
      var lines = wrapWords(c.message, Math.max(8, Math.floor((W - msgX - 12 - toggleW) / 6.8)));
      var baseH = Math.max(rowH, lines.length * lineH + 20);
      return { refLayouts: refLayouts, shaX: tx, msgX: msgX, lines: lines,
               baseH: baseH, h: baseH + (open[c.oid] || 0) };
    });

    // Second pass: stack rows so a wrapped message never overlaps the next.
    var tops = [], acc = padTop;
    rows.forEach(function (r) { tops.push(acc); acc += r.h; });
    sizeGraph(svg, W, acc + 6);

    var x = function (lane) { return padLeft + lane * laneW; };
    var cyOf = function (i) { return tops[i] + 16; };
    drawEdges(svg, model, x, cyOf);

    model.commits.forEach(function (c, i) {
      var cy = cyOf(i), row = rows[i];
      drawNode(svg, c, x(c.lane), cy, 7);
      row.refLayouts.forEach(function (rl) { drawRef(svg, rl, cy, 20, 7, laneColor(c.lane)); });
      svgEl('text', { x: row.shaX, y: cy + 4, 'class': 'gs-sha' }, svg, c.short);
      var msg = svgEl('text', { y: cy + 4, 'class': 'gs-msg' }, svg);
      row.lines.forEach(function (line, li) {
        svgEl('tspan', { x: row.msgX, dy: li === 0 ? 0 : lineH }, msg, line);
      });
      if (extra.onToggle) {
        svg.appendChild(commitToggle(c, W - 22, cy, !!open[c.oid], extra.onToggle));
        if (open[c.oid]) layout.detailTop[c.oid] = tops[i] + row.baseH - 6;
      }
    });
    return layout;
  }

  // parent links, drawn before the nodes so the nodes sit on top
  function drawEdges(svg, model, x, cyOf) {
    var index = {};
    model.commits.forEach(function (c, i) { index[c.oid] = i; });
    model.commits.forEach(function (c, i) {
      (c.parents || []).forEach(function (p, pi) {
        if (!(p in index)) return;
        var j = index[p];
        var x1 = x(c.lane), y1 = cyOf(i), x2 = x(model.commits[j].lane), y2 = cyOf(j);
        var d = x1 === x2
          ? 'M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2
          : 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + (y1 + (y2 - y1) * 0.55) + ' ' +
            x2 + ',' + (y2 - (y2 - y1) * 0.45) + ' ' + x2 + ',' + y2;
        svgEl('path', {
          d: d, fill: 'none', 'stroke-width': 2, opacity: 0.55,
          stroke: laneColor(pi === 0 ? c.lane : model.commits[j].lane)
        }, svg);
      });
    });
  }

  // Outlined in the lane colour over a pale tint of it, as in the commit
  // tree; merge commits stay hollow.
  function drawNode(svg, c, cx, cy, r) {
    var color = laneColor(c.lane);
    svgEl('circle', {
      cx: cx, cy: cy, r: r, stroke: color, 'stroke-width': r > 5 ? 2.5 : 2,
      fill: (c.parents || []).length > 1 ? '#FFFFFF' : tint(color, 0.8)
    }, svg);
  }

  // A ref label centred on y, styled like the commit tree's: a tinted box
  // outlined in the branch colour, bolder for HEAD, grey for remote refs:
  // dashed for the local repo's remote-tracking copies, solid for the
  // remote's own branches. `rl` is { label, x, w, isHead, remote, onRemote }.
  function drawRef(svg, rl, y, h, padX, color) {
    var rect = svgEl('rect', {
      x: rl.x, y: y - h / 2, width: rl.w, height: h, rx: h / 4, 'stroke-width': rl.isHead ? 2 : 1.2,
      fill: rl.remote ? '#FFFFFF' : tint(color, rl.isHead ? 0.62 : 0.85),
      stroke: rl.remote ? '#717171' : color
    }, svg);
    if (rl.remote && !rl.onRemote) rect.setAttribute('stroke-dasharray', '3 2');
    svgEl('text', {
      x: rl.x + padX, y: y + h / 5,
      'class': rl.isHead ? 'gs-ref gs-ref-head' : (rl.remote ? 'gs-ref gs-ref-remote' : 'gs-ref')
    }, svg, rl.label);
  }

  // The commit graph squeezed into half a panel, for the side-by-side
  // local/remote view. Narrower lanes and smaller type; ref labels get a
  // line of their own above the sha and message (wrapping onto more lines
  // when they don't fit), and the message is cut to one line, with the
  // full text on hover. `onRemote` marks the remote's own graph, whose
  // labels are its branches rather than tracking copies of them.
  function renderCompactGraph(svg, model, onRemote) {
    var W = svg.clientWidth || 320;
    if (startGraph(svg, model, W, 44)) return;

    var laneW = 14, padLeft = 12, padTop = 10, refH = 16, refGap = 4, textH = 18, rowGap = 8;
    var textX = padLeft + maxLane(model) * laneW + 14;
    var msgX = textX + 52;
    var maxChars = Math.max(4, Math.floor((W - msgX - 6) / 6.3));

    var rows = model.commits.map(function (c) {
      // ref labels flow left to right, onto a new line when one won't fit
      var refLines = [], line = [], lx = textX;
      (c.refs || []).forEach(function (r) {
        var label = (r.isHead ? 'HEAD → ' : '') + r.name;
        var w = label.length * (r.isHead ? 6.5 : 6.1) + 10;
        if (line.length && lx + w > W - 6) { refLines.push(line); line = []; lx = textX; }
        line.push({ label: label, x: lx, w: w, isHead: r.isHead, remote: r.remote, onRemote: !!onRemote });
        lx += w + 4;
      });
      if (line.length) refLines.push(line);
      var msg = String(c.message).split('\n')[0];
      var cut = msg.length > maxChars;
      return {
        refLines: refLines, msg: cut ? msg.slice(0, maxChars - 1) + '…' : msg, cut: cut,
        h: refLines.length * (refH + refGap) + textH + rowGap
      };
    });

    var tops = [], acc = padTop;
    rows.forEach(function (r) { tops.push(acc); acc += r.h; });
    sizeGraph(svg, W, acc - rowGap + padTop);

    var x = function (lane) { return padLeft + lane * laneW; };
    // the node sits level with the first line of its row
    var cyOf = function (i) { return tops[i] + (rows[i].refLines.length ? refH / 2 : textH / 2); };
    drawEdges(svg, model, x, cyOf);

    model.commits.forEach(function (c, i) {
      var row = rows[i], top = tops[i];
      drawNode(svg, c, x(c.lane), cyOf(i), 5);
      row.refLines.forEach(function (l, li) {
        var cy = top + li * (refH + refGap) + refH / 2;
        l.forEach(function (rl) { drawRef(svg, rl, cy, refH, 5, laneColor(c.lane)); });
      });
      var ty = top + row.refLines.length * (refH + refGap) + textH / 2 + 4;
      svgEl('text', { x: textX, y: ty, 'class': 'gs-sha' }, svg, c.short);
      var msg = svgEl('text', { x: msgX, y: ty, 'class': 'gs-msg' }, svg, row.msg);
      if (row.cut) svgEl('title', {}, msg, c.message);
    });
  }

  // The chevron at the end of a history row: a keyboard-reachable SVG
  // button that opens or closes the commit's contents.
  function commitToggle(c, x, cy, isOpen, onToggle) {
    var g = svgEl('g', {
      'class': 'gs-cd-toggle' + (isOpen ? ' is-open' : ''), role: 'button', tabindex: 0,
      'data-oid': c.oid, 'aria-expanded': isOpen ? 'true' : 'false',
      'aria-label': (isOpen ? 'Hide' : 'Show') + ' the contents of commit ' + c.short
    });
    svgEl('title', {}, g, isOpen ? 'Hide contents' : 'Show contents');
    svgEl('rect', { x: x - 11, y: cy - 11, width: 22, height: 22, rx: 5, 'class': 'gs-cd-toggle-bg' }, g);
    // points right when closed and down when open, like the file browser's
    svgEl('path', {
      'class': 'gs-cd-chev',
      d: isOpen ? 'M' + (x - 4) + ',' + (cy - 2) + ' l4,4 l4,-4' : 'M' + (x - 2) + ',' + (cy - 4) + ' l4,4 l-4,4'
    }, g);
    g.addEventListener('click', function () { onToggle(c.oid); });
    g.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(c.oid); }
    });
    return g;
  }

  /* ------------------------------ diff panel ------------------------- */

  function renderDiff(node, model) {
    if (!model) {
      node.innerHTML = '<div class="gs-diff-empty">Nothing is tracked yet — run <code>git init</code> to start.</div>';
      return;
    }
    if (!model.files.length) {
      node.innerHTML = '<div class="gs-diff-empty">Working directory clean — no changes since the last commit.</div>';
      return;
    }
    node.innerHTML = model.files.map(diffFileHtml).join('');
  }

  // one file's block in a diff view (the Changes panel, a commit's contents)
  function diffFileHtml(f) {
    var rows = f.binary
      ? '<div class="gs-diff-line"><span class="gs-diff-text">Binary file, not shown.</span></div>'
      : f.lines.map(function (l) {
          var cls = l.t === '+' ? ' gs-diff-add' : (l.t === '-' ? ' gs-diff-del' : '');
          return '<div class="gs-diff-line' + cls + '">' +
            '<span class="gs-diff-num">' + (l.a || '') + '</span>' +
            '<span class="gs-diff-num">' + (l.b || '') + '</span>' +
            '<span class="gs-diff-sign">' + (l.t === ' ' ? '' : l.t) + '</span>' +
            '<span class="gs-diff-text">' + esc(l.text) + '</span>' +
          '</div>';
        }).join('');
    return '<div class="gs-diff-file">' +
      '<div class="gs-diff-filehead">' +
        '<span class="gs-diff-name">' + esc(f.file) + '</span>' +
        '<span class="gs-diff-kind gs-diff-kind-' + f.kind + '">' + f.kind + '</span>' +
      '</div>' + rows +
    '</div>';
  }

  // The contents of one commit, shown under its row in the History graph.
  function commitDetailsHtml(d) {
    var when = new Date(d.timestamp * 1000);
    var whenText = isNaN(when.getTime()) ? '' : when.toLocaleString();
    var note = d.parents.length > 1
      ? '<div class="gs-cd-note">A merge of ' + d.parents.map(function (p) { return '<code>' + p.slice(0, 7) + '</code>'; }).join(' and ') +
        '. Changes are shown against the first parent, so they are what the merge brought in.</div>'
      : (!d.parents.length ? '<div class="gs-cd-note">The first commit: everything in it is new.</div>' : '');
    var files = d.files.length
      ? d.files.map(diffFileHtml).join('')
      : '<div class="gs-diff-empty">No file changes.</div>';
    return '<div class="gs-cd-meta"><code class="gs-cd-oid">' + esc(d.oid) + '</code>' +
        '<span>' + esc(d.author) + ' &lt;' + esc(d.email) + '&gt;</span>' +
        (whenText ? '<span>' + esc(whenText) + '</span>' : '') + '</div>' +
      '<div class="gs-cd-msg">' + esc(d.message) + '</div>' + note +
      '<div class="gs-cd-files" aria-label="Files changed">' + files + '</div>';
  }

  /* -------------------------- staging diagram ------------------------ */

  function renderStages(node, status, graph, files, isRepo) {
    var needAdd = (status.conflicted || []).map(function (c) { return { f: c.file, k: 'conflict: ' + c.kind, conflict: true }; })
      .concat(status.untracked.map(function (f) { return { f: f, k: 'untracked' }; }))
      .concat(status.modified.map(function (f) { return { f: f, k: 'modified' }; }))
      .concat(status.deleted.map(function (f) { return { f: f, k: 'deleted' }; }));
    var staged = status.staged.map(function (s) { return { f: s.file, k: s.kind }; })
      .concat(status.stagedDeleted.map(function (f) { return { f: f, k: 'deleted' }; }));

    // The working directory lists only what has changed since the last
    // commit; committed-and-clean files would crowd the changes out. Before
    // `git init` there is no git status at all, so every file shows, as a
    // quiet grey chip: calling them "untracked" would use a git-status word
    // while no git status exists yet.
    var accounted = {};
    needAdd.concat(staged).forEach(function (it) { accounted[it.f] = true; });
    var clean = isRepo ? [] : (files || [])
      .filter(function (f) { return !accounted[f]; })
      .map(function (f) { return { f: f, k: 'not in git yet' }; });
    // Files .gitignore matches are there on disk but invisible to git, so
    // they show as quiet chips: proof that the ignore rule works.
    var ignored = isRepo ? (status.ignored || []).map(function (f) { return { f: f, k: 'ignored', quiet: true }; }) : [];

    function col(title, note, items, kind) {
      var chips = items.length
        ? items.map(function (it) {
            var quiet = it.k === 'not in git yet' || it.quiet;
            var cls = 'gs-chip gs-chip-' + kind + (quiet ? ' gs-chip-clean' : '') +
              (it.conflict ? ' gs-chip-conflict' : '');
            return '<span class="' + cls + '" data-col="' + kind + '" data-file="' + esc(it.f) + '">' + esc(it.f) +
                   '<span class="gs-chip-k">' + esc(it.k) + '</span></span>';
          }).join('')
        : '<span class="gs-chip gs-chip-empty">empty</span>';
      return '<div class="gs-col">' +
             '<div class="gs-col-h">' + esc(title) + '</div>' +
             '<div class="gs-col-n">' + esc(note) + '</div>' +
             '<div class="gs-chips">' + chips + '</div></div>';
    }

    var nCommits = graph.commits.length;
    var repoItems = nCommits
      ? [{ f: nCommits + ' commit' + (nCommits === 1 ? '' : 's'), k: graph.head || 'detached' }]
      : [];

    node.innerHTML =
      col('Working directory', 'what you edit', needAdd.concat(clean, ignored), 'work') +
      '<div class="gs-arrow"><span>git add</span><i class="gs-arrow-g">→</i></div>' +
      col('Staging area', 'what goes in next commit', staged, 'stage') +
      '<div class="gs-arrow"><span>git commit</span><i class="gs-arrow-g">→</i></div>' +
      col('Repository', 'permanent history', repoItems, 'repo');
  }

  // Where each file chip sits, keyed by column and file ("stage:a.txt"): a
  // file can be in two columns at once (staged, then edited again).
  function chipRects(node) {
    var out = {};
    node.querySelectorAll('.gs-chip[data-file]').forEach(function (c) {
      var r = chipBox(node, c);
      if (!r.w) return;
      r.el = c;
      out[c.getAttribute('data-col') + ':' + c.getAttribute('data-file')] = r;
    });
    return out;
  }

  // How much the page is scaled between `node`'s CSS pixels and the screen.
  // reveal.js scales each slide to fit the window, so on a slide the
  // on-screen rectangles are larger or smaller than the lengths the
  // animations set; without this the chips fly off past their targets.
  function layoutScale(node) {
    var r = node.getBoundingClientRect();
    return node.offsetWidth && r.width ? r.width / node.offsetWidth : 1;
  }

  // The browser's zoom level (1 at 100%). reveal.js scales each slide to
  // fit the window, which cancels out zooming in or out, so a box on a
  // slide sizes its text by this instead (--gs-zoom in the CSS). There is
  // no API for it: Chrome reports it as outerWidth / innerWidth, and every
  // browser folds it into devicePixelRatio, on top of the screen's own
  // density. The first reading fixes that density; later ones divide by it.
  var ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  var SCREEN_DPRS = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 4];
  var screenDpr = null;
  function nearest(list, x, tol) {
    for (var i = 0; i < list.length; i++) if (Math.abs(list[i] - x) <= tol * list[i]) return list[i];
    return null;
  }
  function browserZoom() {
    var dpr = root.devicePixelRatio || 1;
    // A docked devtools pane or a sidebar also widens outerWidth, so only
    // trust the ratio when it is one of the browser's zoom steps and leaves
    // a screen density that exists. A ratio of 1 says nothing: browsers
    // that report outerWidth in zoomed pixels always give 1.
    var ratio = root.outerWidth && root.innerWidth ? root.outerWidth / root.innerWidth : 1;
    var step = nearest(ZOOM_STEPS, ratio, 0.02);
    var fromRatio = step && step !== 1 && nearest(SCREEN_DPRS, dpr / step, 0.02) ? step : null;
    if (screenDpr === null) screenDpr = dpr / (fromRatio || 1);
    var z = fromRatio || dpr / screenDpr;
    return Math.min(4, Math.max(0.5, Math.round(z * 100) / 100));
  }

  // Show files travelling between the columns after a re-render, so
  // `git add` visibly carries a file from the working directory to the
  // staging area and `git commit` turns the staged files into a commit in
  // the repository. `before` is chipRects() from just before the render.
  // Chips that changed column glide across one after another (FLIP), chips
  // that only shifted within a column settle into place, and new ones fade
  // in once the travellers have left. On a commit (`commitColor` is the new
  // commit's lane colour) the staged chips morph together into one commit
  // node, drawn like the nodes in the graph, which then glides into the
  // repository. A no-op where the Web Animations API is missing, the panel
  // is hidden, or the reader asked for reduced motion.
  function animateStages(node, before, commitColor) {
    if (!before || typeof node.animate !== 'function') return;
    if (root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!node.getBoundingClientRect().width || !Object.keys(before).length) return;
    var now = chipRects(node);
    var repo = node.querySelector('.gs-chip-repo');
    var repoBox = repo ? chipBox(node, repo) : null;
    var STAGGER = 40, MAX_STAGGER = 200;
    var claimed = {}, travellers = 0, committing = [];

    function stagger(n) { return Math.min(n * STAGGER, MAX_STAGGER); }

    // across columns: slow enough to follow
    function glide(el, from, to) {
      var dx = from.x - to.x, dy = from.y - to.y;
      if (!dx && !dy) return;
      el.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }],
        { duration: 520, delay: stagger(travellers++), easing: 'cubic-bezier(0.45, 0, 0.25, 1)', fill: 'backwards' });
    }

    // within a column: closing the gap a departing chip left behind
    function settle(el, from, to) {
      var dx = from.x - to.x, dy = from.y - to.y;
      if (!dx && !dy) return;
      el.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }],
        { duration: 380, delay: 120, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'backwards' });
    }

    Object.keys(before).forEach(function (key) {
      var old = before[key];
      var colName = key.slice(0, key.indexOf(':'));
      var file = key.slice(key.indexOf(':') + 1);
      if (now[key]) { settle(now[key].el, old, now[key]); claimed[key] = true; return; }
      if (colName === 'stage' && commitColor && repoBox) { committing.push(old); return; }
      // across to the other column: `git add` (work -> stage) or back
      var other = (colName === 'work' ? 'stage' : 'work') + ':' + file;
      if (now[other] && !before[other]) { glide(now[other].el, old, now[other]); claimed[other] = true; }
    });

    var landed = committing.length ? commitIntoRepo(node, committing, repo, repoBox, commitColor) : 0;

    // newcomers wait until the travellers are under way
    var lastStart = stagger(Math.max(travellers - 1, 0));
    Object.keys(now).forEach(function (key) {
      // the repository chip is relabelled ("3 commits"), not new
      if (claimed[key] || before[key] || key.indexOf('repo:') === 0) return;
      now[key].el.animate([{ opacity: 0 }, { opacity: 1 }],
        { duration: 360, delay: (committing.length ? 300 : 120) + lastStart, easing: 'ease-out', fill: 'backwards' });
    });
    if (landed) {
      // the new count fades in as the commit lands
      var ink = (root.getComputedStyle && root.getComputedStyle(repo).color) || '#22384C';
      repo.animate([{ color: 'rgba(0,0,0,0)' }, { color: 'rgba(0,0,0,0)', offset: landed / (landed + 240) }, { color: ink }],
        { duration: landed + 240 });
    }
  }

  // The commit half of animateStages: the staged chips (`olds`, chipRects()
  // entries from before the render) become one shape that morphs into a
  // commit node, a circle drawn like the graph's, and glides into the
  // repository chip. Returns when, in ms, the node lands.
  var NODE = 16, MORPH = 480, MOVE = 520;
  function commitIntoRepo(node, olds, repo, repoBox, color) {
    // one box around all the staged chips, holding copies of them
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    olds.forEach(function (o) {
      x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y);
      x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + o.h);
    });
    var shape = document.createElement('span');
    shape.className = 'gs-chip-ghost gs-commit-node';
    node.appendChild(shape);
    var parts = olds.map(function (old) {
      var part = old.el.cloneNode(true);
      // not a real chip: keep it out of the next chipRects()
      part.removeAttribute('data-col');
      part.removeAttribute('data-file');
      part.classList.add('gs-chip-part');
      part.style.left = old.x - x0 + 'px';
      part.style.top = old.y - y0 + 'px';
      part.style.width = old.w + 'px';
      shape.appendChild(part);
      return part;
    });
    // the copies are attached now, so they have the staged chips' colour
    var cs = root.getComputedStyle ? root.getComputedStyle(parts[0]) : null;
    var green = (cs && cs.backgroundColor) || '#DBE6D3';

    var total = MORPH + MOVE, formed = MORPH / total, landed = (MORPH + MOVE * 0.85) / total;
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    var tx = repoBox.x + repoBox.w / 2, ty = repoBox.y + repoBox.h / 2;
    var ease = 'cubic-bezier(0.45, 0, 0.25, 1)';
    function frame(x, y, w, h, offset, look) {
      return {
        left: x - w / 2 + 'px', top: y - h / 2 + 'px', width: w + 'px', height: h + 'px',
        borderRadius: look.r, backgroundColor: look.bg, boxShadow: 'inset 0 0 0 ' + look.ring + 'px ' + color,
        opacity: look.op, offset: offset, easing: ease
      };
    }
    var commit = { r: '50%', bg: tint(color, 0.8), ring: 2.5, op: 1 };
    shape.animate([
      frame(cx, cy, x1 - x0, y1 - y0, 0, { r: '4px', bg: 'rgba(0,0,0,0)', ring: 0, op: 1 }),
      // the chips have merged into one block
      frame(cx, cy, (x1 - x0) * 0.8, (y1 - y0) * 0.8, formed * 0.35, { r: '6px', bg: green, ring: 0, op: 1 }),
      frame(cx, cy, NODE, NODE, formed, commit),
      frame(tx, ty, NODE, NODE, landed, commit),
      frame(tx, ty, NODE, NODE, 1, { r: '50%', bg: tint(color, 0.8), ring: 2.5, op: 0 })
    ], { duration: total, fill: 'forwards' }).onfinish = function () {
      if (shape.parentNode) shape.parentNode.removeChild(shape);
    };
    // the files' own labels and colours give way to the one block
    parts.forEach(function (part) {
      part.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MORPH * 0.35, easing: 'ease-in', fill: 'forwards' });
    });
    return Math.round(MORPH + MOVE * 0.85);
  }

  // The lane colour of the commit HEAD points at, as the graph draws it.
  function commitColor(graph) {
    var head = graph.commits.filter(function (c) { return c.oid === graph.headOid; })[0];
    return laneColor(head ? head.lane : 0);
  }

  // `el`'s box relative to `node`, in node's own (unscaled) CSS pixels.
  function chipBox(node, el) {
    var base = node.getBoundingClientRect(), r = el.getBoundingClientRect();
    var k = layoutScale(node);
    return { x: (r.left - base.left) / k, y: (r.top - base.top) / k, w: r.width / k, h: r.height / k };
  }

  /* ------------------------------- mount ----------------------------- */

  // Exercises that share one repository (`share: <id>`), by that id. The
  // exercise with the id is the origin and seeds it; every view of it gets
  // the same sandbox, and they keep each other up to date. The undo stack
  // belongs to the group: it holds the repository's history, whichever
  // view a change was made in.
  var groups = {};

  function groupFor(key, config) {
    var g = key ? groups[key] : null;
    if (g) return g;
    g = {
      sb: root.GitSandboxCore.createSandbox({
        git: root.git,
        displayDir: (config.prompt || '~/project').replace(/\s*\$\s*$/, '')
      }),
      seed: null,
      ready: Promise.resolve(),
      undo: [],
      members: []
    };
    if (key) groups[key] = g;
    return g;
  }

  function mount(selector, config) {
    config = config || {};
    var host = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!host) return null;

    // isomorphic-git's index code calls a global Buffer. The bundle shipped
    // with this lesson provides one; a bare CDN copy of isomorphic-git does not.
    var missing = !root.git || typeof root.git.init !== 'function'
      ? 'the git library did not load. Check that isomorphic-git.bundle.js is reachable from this page.'
      : typeof root.Buffer === 'undefined'
        ? 'no Buffer polyfill is present. Load isomorphic-git.bundle.js (which includes one) ' +
          'rather than isomorphic-git on its own.'
        : null;
    if (missing) {
      host.classList.add('gs');
      host.innerHTML = '<div class="gs-loading">This exercise could not start: ' + missing + '</div>';
      return null;
    }

    // `share: <id>` makes this box another view of exercise <id>'s
    // repository: its own title, tasks, terminal and layout, the same files
    // and history.
    var shareKey = config.share ? String(config.share) : null;
    var group = groupFor(shareKey || host.id || null, config);
    var isOrigin = !shareKey;
    var sb = group.sb;
    var self = {};
    group.members.push(self);
    var history = [];
    var histIdx = -1;
    var busy = false;
    function setBusy(on) { busy = on; input.disabled = on; }
    var tasks = normaliseTasks(config.tasks);
    var seed = normaliseSeed(config.seed);
    // only the origin seeds a shared repository; a view that mounts before
    // its origin starts empty and catches up when the origin arrives
    if (isOrigin) group.seed = seed;
    var intro = normaliseIntro(config.intro);
    // commands to play back one at a time
    var script = commandLines(config.script);
    // The learngitbranching-style pane: `tree-view: true` shows it beside
    // the box, 'toggle' (the default) puts a button in the header that
    // opens it, and false leaves it out.
    var treeMode = root.GitSandboxTree ? showMode(config.treeView, 'toggle') : false;
    var treeOn = treeMode !== false;
    var treeShown = treeMode === true;
    // The editor tab (and with it the tab strip) can be turned off.
    var editorOn = config.editor !== false && config.editor !== 'false';
    // The panels below the terminal: the same three modes, here 'toggle'
    // starts open with a chevron to fold them. `panelTabs` picks which
    // panels there are at all.
    var panelTabs = Array.isArray(config.panelTabs)
      ? PANEL_NAMES.filter(function (n) { return config.panelTabs.indexOf(n) !== -1; })
      : PANEL_NAMES.slice();
    var panelMode = panelTabs.length ? showMode(config.panels, 'toggle') : false;
    var panelsOpen = panelMode !== false;

    host.classList.add('gs');
    host.classList.toggle('gs-has-tree', treeShown);
    host.innerHTML =
      '<div class="gs-head">' +
        // The workspace tabs live in the title bar and open onto the dark
        // pane below it: the terminal and the file editor share that pane,
        // one at a time, like tabs in a code editor.
        (editorOn
          ? '<div class="gs-titlebar" role="tablist" aria-label="Workspace">' +
              '<button type="button" class="gs-wtab is-active" role="tab" aria-selected="true" data-view="terminal">' +
                '<span class="gs-wtab-icon" aria-hidden="true">&gt;_</span>Terminal</button>' +
              '<button type="button" class="gs-wtab" role="tab" aria-selected="false" data-view="editor">' +
                '<span class="gs-wtab-icon" aria-hidden="true">{ }</span>Editor' +
                '<span class="gs-wtab-dirty" title="Unsaved changes" hidden>●<span class="gs-sr"> (unsaved changes)</span></span></button>' +
            '</div>'
          : '') +
        '<span class="gs-eyebrow">' + esc(config.title || 'Git sandbox') + '</span>' +
        '<span class="gs-state"></span>' +
        '<button type="button" class="gs-undo" disabled>Undo</button>' +
        '<button type="button" class="gs-reset">Reset</button>' +
        (treeMode === 'toggle'
          ? '<button type="button" class="gs-tree-btn" aria-pressed="false" aria-label="Commit tree"' +
            ' title="Show the commit tree">' + ICON_TREE + '</button>'
          : '') +
      '</div>' +
      '<div class="gs-body">' +
        '<div class="gs-term-wrap">' +
          '<div class="gs-view" role="tabpanel" data-view="terminal">' +
            '<div class="gs-out" role="log" aria-live="polite" aria-label="Terminal output"></div>' +
            '<form class="gs-input-row" autocomplete="off">' +
              '<label class="gs-prompt" for="' + (host.id || 'gs') + '-in">' + esc(config.prompt || '~/project $') + '</label>' +
              '<input class="gs-input" id="' + (host.id || 'gs') + '-in" type="text" spellcheck="false"' +
              ' autocapitalize="off" autocorrect="off" aria-label="Type a git command"' +
              ' placeholder="type a command and press Enter">' +
              (script.length
                // the counter for scripted commands; hovering it opens the list
                ? '<span class="gs-type-caret" aria-hidden="true" hidden></span>' +
                  '<span class="gs-type-measure" aria-hidden="true"></span>' +
                  '<div class="gs-script">' +
                    '<button type="button" class="gs-script-count" aria-expanded="false"' +
                    ' aria-label="Scripted commands"></button>' +
                    '<div class="gs-script-pop" role="group" aria-label="Scripted commands">' +
                      '<div class="gs-script-head">' +
                        '<span class="gs-script-title">Commands</span>' +
                        '<button type="button" class="gs-script-btn gs-script-skip">Skip</button>' +
                        '<button type="button" class="gs-script-btn gs-script-next" hidden>Next</button>' +
                      '</div>' +
                      '<ol class="gs-script-list"></ol>' +
                    '</div>' +
                  '</div>'
                : '') +
            '</form>' +
            // `git commit` without -m opens this, as real git opens vim
            '<div class="gs-vim" hidden>' +
              '<textarea class="gs-vim-text" spellcheck="false" autocapitalize="off" autocorrect="off"' +
              ' aria-label="vim, editing the commit message"></textarea>' +
              '<div class="gs-vim-status" role="status"></div>' +
            '</div>' +
            '<div class="gs-hints"></div>' +
          '</div>' +
          '<div class="gs-view gs-view-editor" role="tabpanel" data-view="editor" hidden>' +
            '<div class="gs-fb">' +
              '<div class="gs-fb-head">' +
                '<button type="button" class="gs-fb-btn gs-fb-up" aria-label="Up one folder" title="Up one folder">' + ICON_UP + '</button>' +
                '<span class="gs-fb-title"></span>' +
                '<button type="button" class="gs-fb-btn gs-fb-home" aria-label="Back to the working directory" title="Back to the working directory" hidden>' + ICON_HOME + '</button>' +
                '<button type="button" class="gs-fb-btn gs-fb-new" aria-label="New file" title="New file">' + ICON_PLUS + '</button>' +
              '</div>' +
              '<form class="gs-fb-create" autocomplete="off" hidden>' +
                '<input class="gs-fb-name" type="text" spellcheck="false" autocapitalize="off" autocorrect="off"' +
                ' aria-label="New file name" placeholder="name, e.g. notes.md">' +
                '<div class="gs-fb-err" role="alert"></div>' +
              '</form>' +
              '<ul class="gs-fb-list" aria-label="Files"></ul>' +
              '<label class="gs-fb-foot">' +
                '<input type="checkbox" class="gs-fb-hidden" role="switch">' +
                '<span class="gs-switch" aria-hidden="true"></span>Show hidden files' +
              '</label>' +
            '</div>' +
            '<div class="gs-ed">' +
              '<div class="gs-ed-head">' +
                '<span class="gs-ed-name"></span>' +
                '<span class="gs-ed-status" role="status"></span>' +
                '<button type="button" class="gs-ed-btn gs-ed-revert" disabled>Revert</button>' +
                '<button type="button" class="gs-ed-btn gs-ed-save" disabled>Save</button>' +
              '</div>' +
              '<textarea class="gs-ed-text" spellcheck="false" autocapitalize="off" autocorrect="off"' +
              ' aria-label="File contents" hidden></textarea>' +
              '<div class="gs-ed-empty"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="gs-tasks"></div>' +
        '<div class="gs-viz"' + (panelMode === false ? ' hidden' : '') + '>' +
          // One panel at a time; each tab carries a live badge so the folded
          // panels still tell you what they hold at a glance.
          '<div class="gs-tabs" role="tablist" aria-label="Repository views">' +
            '<button type="button" class="gs-tab is-active" role="tab" aria-selected="true" data-tab="files">File Status<span class="gs-tab-badge" hidden></span></button>' +
            '<button type="button" class="gs-tab" role="tab" aria-selected="false" data-tab="changes">Changes<span class="gs-tab-badge" hidden></span></button>' +
            '<button type="button" class="gs-tab" role="tab" aria-selected="false" data-tab="history">History<span class="gs-tab-badge" hidden></span></button>' +
            '<button type="button" class="gs-tab" role="tab" aria-selected="false" data-tab="remote" hidden>Remote<span class="gs-tab-badge" hidden></span></button>' +
            (panelMode === 'toggle'
              ? '<button type="button" class="gs-viz-toggle" aria-expanded="true" aria-label="Repository views"' +
                ' title="Hide these views">' + ICON_CHEVRON + '</button>'
              : '') +
          '</div>' +
          // divs, not <section>s: reveal.js takes every section for a slide
          '<div class="gs-panel" role="tabpanel" data-panel="files">' +
            '<div class="gs-stages"></div>' +
          '</div>' +
          '<div class="gs-panel" role="tabpanel" data-panel="changes" hidden>' +
            '<div class="gs-diff"></div>' +
          '</div>' +
          '<div class="gs-panel" role="tabpanel" data-panel="history" hidden>' +
            '<div class="gs-graph-scroll"><svg class="gs-graph" xmlns="http://www.w3.org/2000/svg"></svg>' +
              '<div class="gs-cd-layer"></div></div>' +
          '</div>' +
          '<div class="gs-panel" role="tabpanel" data-panel="remote" hidden>' +
            '<div class="gs-remote" hidden>' +
              // the learner's repository and the remote side by side, so a
              // push or pull can be watched moving commits across
              '<div class="gs-split">' +
                '<div class="gs-side gs-side-local">' +
                  '<div class="gs-side-head"><span class="gs-side-label">Local</span></div>' +
                  '<div class="gs-graph-scroll"><svg class="gs-local-graph gs-graph-compact" xmlns="http://www.w3.org/2000/svg"></svg></div>' +
                '</div>' +
                '<div class="gs-side gs-side-remote">' +
                  '<div class="gs-side-head"><span class="gs-side-label">Remote</span>' +
                    '<span class="gs-remote-name"></span></div>' +
                  '<div class="gs-graph-scroll"><svg class="gs-remote-graph gs-graph-compact" xmlns="http://www.w3.org/2000/svg"></svg></div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      (treeOn
        // Beside the whole box rather than in a tab, so learners can keep
        // an eye on the tree while they type.
        // A div, not an <aside>: Quarto's page grid sends asides to the margin.
        ? '<div class="gs-tree" role="complementary" aria-label="Commit tree"' + (treeShown ? '' : ' hidden') + '>' +
            '<div class="gs-tree-inner">' +
            '<div class="gs-tree-head"><span class="gs-eyebrow">Commit tree</span></div>' +
            '<div class="gs-tree-scroll"><svg class="gs-tree-svg" xmlns="http://www.w3.org/2000/svg" role="img"></svg></div>' +
          '</div></div>'
        : '');

    // a long title is cut short to fit the bar; the full one is on hover
    var titleNode = host.querySelector('.gs-head > .gs-eyebrow');
    titleNode.title = titleNode.textContent;

    var out = host.querySelector('.gs-out');
    var form = host.querySelector('.gs-input-row');
    var input = host.querySelector('.gs-input');
    var hintsNode = host.querySelector('.gs-hints');
    var stagesNode = host.querySelector('.gs-stages');
    var diffNode = host.querySelector('.gs-diff');
    var svg = host.querySelector('.gs-graph');
    var cdLayer = host.querySelector('.gs-cd-layer');
    // History rows opened to show what the commit changed. Details are
    // cached by oid: a commit never changes, it can only go away.
    var openCommits = {};
    var commitInfo = {};
    var remoteWrap = host.querySelector('.gs-remote');
    var remoteSvg = host.querySelector('.gs-remote-graph');
    var localSvg = host.querySelector('.gs-local-graph');
    var remoteNameNode = host.querySelector('.gs-remote-name');
    // the remote shown on the right; with more than one, a dropdown picks it
    var remoteName = null;
    var tasksNode = host.querySelector('.gs-tasks');
    var resetBtn = host.querySelector('.gs-reset');
    var undoBtn = host.querySelector('.gs-undo');
    var vimNode = host.querySelector('.gs-vim');
    var vimText = host.querySelector('.gs-vim-text');
    var vimStatus = host.querySelector('.gs-vim-status');
    // the open vim session, if any: { abandon() }
    var vim = null;
    var treeScroll = host.querySelector('.gs-tree-scroll');
    var tree = treeOn ? root.GitSandboxTree.createTreeView(host.querySelector('.gs-tree-svg')) : null;
    // the first drawing after a reset appears at once; later ones animate
    var treeInstant = true;

    // Undo is full time travel: each entry restores the repo, the task
    // ticks, the command history and the terminal together, so the undone
    // command leaves no trace anywhere. Only commands that actually changed
    // state get an entry, so `undo` never appears to do nothing.
    var undoStack = group.undo;
    var UNDO_DEPTH = 20;

    function pushUndo(snap) {
      snap.owner = self;
      undoStack.push(snap);
      if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    }

    // can this view undo? only its own change, and only the latest one:
    // undoing past a change made in another view would take that back too
    function canUndo() {
      var top = undoStack[undoStack.length - 1];
      return !!top && top.owner === self;
    }

    // the other views of a shared repository redraw after every change
    // here; `note` is a line for their terminals
    function notifyViews(note) {
      group.members.forEach(function (m) {
        if (m === self || !m.refresh) return;
        if (note) m.note(note);
        m.refresh();
      });
    }

    function promptText() { return host.querySelector('.gs-prompt').textContent; }

    function captureUndo(line) {
      return {
        line: line,
        core: sb.snapshot(),
        outHtml: out.innerHTML,
        prompt: promptText(),
        histLen: history.length,
        done: tasks.map(function (t) { return !!t._done; }),
        tree: tree ? tree.snapshot() : null
      };
    }

    // back to a captureUndo() snapshot: repo, terminal, history and ticks
    function restoreSnap(snap) {
      sb.restore(snap.core);
      // C-names given out since the snapshot are handed back, so the next
      // commit reuses the undone one's name
      if (tree) tree.restore(snap.tree);
      out.innerHTML = snap.outHtml;
      out.scrollTop = out.scrollHeight;
      history.length = snap.histLen;
      histIdx = history.length;
      tasks.forEach(function (t, i) { t._done = snap.done[i]; t._wasDone = snap.done[i]; });
    }

    function doUndo() {
      if (!canUndo()) {
        echo(promptText(), 'undo');
        writeText(undoStack.length
          ? 'The last change was made in another view of this repository. Undo it there.'
          : 'Nothing to undo.');
        return;
      }
      var entry = undoStack.pop();
      restoreSnap(entry);
      echo(entry.prompt, 'undo');
      writeText('Undid: {y}' + entry.line + '{/}');
    }

    /* ------------------------------ tabs ------------------------------ */

    var tabButtons = {};
    var tabPanels = {};
    host.querySelectorAll('.gs-tab').forEach(function (b) { tabButtons[b.getAttribute('data-tab')] = b; });
    host.querySelectorAll('.gs-panel').forEach(function (p) { tabPanels[p.getAttribute('data-panel')] = p; });
    var panelOn = {};
    panelTabs.forEach(function (n) { panelOn[n] = true; });
    // panels left out by `panel-tabs` never show; Remote also waits for a remote
    PANEL_NAMES.forEach(function (n) { if (!panelOn[n]) tabButtons[n].hidden = true; });
    var defaultTab = panelTabs.filter(function (n) { return n !== 'remote'; })[0] || 'remote';
    var activeTab = defaultTab;
    var vizToggle = host.querySelector('.gs-viz-toggle');

    // `fromUser`: a click on a tab also unfolds folded panels; a command
    // choosing a tab for the learner leaves them folded.
    function selectTab(name, fromUser) {
      if (!tabButtons[name] || tabButtons[name].hidden || !panelOn[name]) return;
      activeTab = name;
      if (fromUser && !panelsOpen) setPanelsOpen(true);
      showPanels();
    }

    // mark the `active` tab of `buttons` selected, and show only its pane
    function activate(buttons, panes, active, shown) {
      Object.keys(buttons).forEach(function (k) {
        var on = k === active;
        buttons[k].classList.toggle('is-active', on);
        buttons[k].setAttribute('aria-selected', on ? 'true' : 'false');
        panes[k].hidden = !on || !shown;
      });
    }

    function showPanels() {
      activate(tabButtons, tabPanels, activeTab, panelsOpen);
      // A graph drawn while its panel was hidden used the fallback width;
      // now that it has a real width, redraw at it.
      redrawGraph();
    }

    function setPanelsOpen(open) {
      panelsOpen = open;
      host.querySelector('.gs-viz').classList.toggle('is-folded', !open);
      if (vizToggle) {
        vizToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        vizToggle.title = open ? 'Hide these views' : 'Show these views';
      }
      showPanels();
    }

    Object.keys(tabButtons).forEach(function (k) {
      tabButtons[k].addEventListener('click', function () { selectTab(k, true); });
    });
    if (vizToggle) vizToggle.addEventListener('click', function () { setPanelsOpen(!panelsOpen); });
    if (activeTab !== 'files') showPanels();

    function setBadge(name, text) {
      var badge = tabButtons[name].querySelector('.gs-tab-badge');
      badge.hidden = !text;
      badge.textContent = text || '';
      badge.classList.toggle('gs-tab-badge-ok', text === '✓');
    }

    // Which tab would a learner look at after this command? Only a shell
    // edit has an opinion (the file it touched); git commands leave the
    // learner's chosen view alone.
    function tabFor(line) {
      var c = line.trim().split(/\s+/)[0];
      if (/^(echo|touch|rm|mkdir)$/.test(c)) return 'files';
      return null;
    }

    // The graph is drawn at the SVG's current pixel width, so a later resize
    // would scale it like an image (tiny text on narrow screens). Redraw the
    // last model whenever the width actually changes.
    var lastGraph = null;
    var lastGraphW = 0;
    var lastCommitCount = 0;
    var stagesInstant = true;
    var lastRemoteGraph = null;
    var lastRemoteGraphW = 0;
    var lastLocalGraphW = 0;
    function redrawGraph() {
      var w = svg.clientWidth;
      if (lastGraph && w && w !== lastGraphW) {
        lastGraphW = w;
        drawHistory(lastGraph);
      }
      var rw = remoteSvg.clientWidth;
      if (lastRemoteGraph && rw && rw !== lastRemoteGraphW) {
        lastRemoteGraphW = rw;
        renderCompactGraph(remoteSvg, lastRemoteGraph, true);
      }
      var lw = localSvg.clientWidth;
      if (lastRemoteGraph && lastGraph && lw && lw !== lastLocalGraphW) {
        lastLocalGraphW = lw;
        renderCompactGraph(localSvg, lastGraph);
      }
    }
    if (typeof ResizeObserver !== 'undefined') {
      var graphObserver = new ResizeObserver(redrawGraph);
      graphObserver.observe(svg.parentNode);
      graphObserver.observe(localSvg.parentNode);
      graphObserver.observe(remoteSvg.parentNode);
    } else {
      root.addEventListener('resize', redrawGraph);
    }

    // The tree pane sits beside the box while there is room for both, and
    // drops below it when the box gets too narrow to share.
    var lastTreeW = 0;
    function fitTree() {
      var w = host.clientWidth;
      host.classList.toggle('gs-tree-below', !!w && w < 760);
      placeTreeBtn();
      var tw = treeScroll.clientWidth;
      if (tw && tw !== lastTreeW) {
        lastTreeW = tw;
        tree.redraw();
      }
    }
    if (tree) {
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitTree).observe(host);
      else root.addEventListener('resize', fitTree);
      fitTree();
    }

    // `tree-view: toggle`: the header button opens and closes the pane. The
    // tree keeps up with every command while closed, so it opens current.
    var treeBtn = host.querySelector('.gs-tree-btn');
    // The button sits in the top right corner of the box: in the tree's own
    // header while the tree is open beside the box, in the box's header
    // otherwise, so opening and closing the tree never moves it.
    function placeTreeBtn() {
      if (!treeBtn) return;
      var beside = treeShown && !host.classList.contains('gs-tree-below');
      var bar = host.querySelector(beside ? '.gs-tree-head' : '.gs-head');
      if (treeBtn.parentNode === bar) return;
      var focused = host.ownerDocument.activeElement === treeBtn;
      bar.appendChild(treeBtn);
      if (focused) treeBtn.focus();
    }
    function setTreeShown(on) {
      treeShown = on;
      host.classList.toggle('gs-has-tree', on);
      host.querySelector('.gs-tree').hidden = !on;
      placeTreeBtn();
      treeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      treeBtn.title = on ? 'Hide the commit tree' : 'Show the commit tree';
      if (on) {
        lastTreeW = 0;
        fitTree();
      }
    }
    if (treeBtn) treeBtn.addEventListener('click', function () { setTreeShown(!treeShown); });

    // On a reveal.js slide the box fills the rest of the slide at a fixed
    // height (see .gs-fill in the CSS): the terminal takes up the slack and
    // the views below get a fixed area that scrolls, so neither the box nor
    // anything around it moves as the repository changes.
    var slide = host.closest ? host.closest('.reveal .slides section') : null;
    if (slide) {
      host.classList.add('gs-fill');
      var fillSlide = function () {
        var zoom = browserZoom();
        if (host.style.getPropertyValue('--gs-zoom') !== String(zoom)) host.style.setProperty('--gs-zoom', String(zoom));
        // offsets are only real while the slide is displayed
        if (!host.offsetParent) return;
        var deck = root.Reveal && root.Reveal.getConfig ? root.Reveal.getConfig() : null;
        var slideH = deck && typeof deck.height === 'number' ? deck.height : 700;
        var top = 0;
        for (var n = host; n && n !== slide && slide.contains(n); n = n.offsetParent) top += n.offsetTop;
        var h = Math.max(320, Math.floor(slideH - top - 8));
        if (host.style.height !== h + 'px') host.style.height = h + 'px';
      };
      var hookDeck = function () {
        if (!root.Reveal || !root.Reveal.on || hookDeck.done) return;
        hookDeck.done = true;
        ['ready', 'slidechanged', 'resize'].forEach(function (ev) { root.Reveal.on(ev, fillSlide); });
      };
      fillSlide();
      hookDeck();
      root.addEventListener('load', function () { hookDeck(); fillSlide(); });
      // zooming resizes the window, but reveal.js only reports a resize
      // when its own scale changes
      root.addEventListener('resize', fillSlide);
    }

    /* ------------------------ workspace views ------------------------- */

    var viewButtons = {};
    var viewPanes = {};
    host.querySelectorAll('.gs-wtab').forEach(function (b) { viewButtons[b.getAttribute('data-view')] = b; });
    host.querySelectorAll('.gs-view').forEach(function (p) { viewPanes[p.getAttribute('data-view')] = p; });

    function selectView(name, focus) {
      if (!viewButtons[name]) return;
      activate(viewButtons, viewPanes, name, true);
      // lets narrow screens give the stacked file tree + editor more room
      host.querySelector('.gs-term-wrap').classList.toggle('is-editor', name === 'editor');
      if (!focus) return;
      if (name === 'terminal') input.focus();
      else if (openFile) edText.focus();
    }

    Object.keys(viewButtons).forEach(function (k) {
      viewButtons[k].addEventListener('click', function () { selectView(k, true); });
    });

    /* ------------------------- file editor ---------------------------- */

    var fbList = host.querySelector('.gs-fb-list');
    var fbTitle = host.querySelector('.gs-fb-title');
    var fbUp = host.querySelector('.gs-fb-up');
    var fbHome = host.querySelector('.gs-fb-home');
    var fbHidden = host.querySelector('.gs-fb-hidden');
    var fbNewBtn = host.querySelector('.gs-fb-new');
    var fbCreate = host.querySelector('.gs-fb-create');
    var fbName = host.querySelector('.gs-fb-name');
    var fbErr = host.querySelector('.gs-fb-err');
    var edName = host.querySelector('.gs-ed-name');
    var edStatus = host.querySelector('.gs-ed-status');
    var edText = host.querySelector('.gs-ed-text');
    var edEmpty = host.querySelector('.gs-ed-empty');
    var edSave = host.querySelector('.gs-ed-save');
    var edRevert = host.querySelector('.gs-ed-revert');
    var dirtyDot = host.querySelector('.gs-wtab-dirty');

    var openFile = null;   // path of the file shown in the editor
    var openKind = 'text'; // 'text', 'readonly' (inside .git) or 'binary'
    var savedText = '';    // that file's contents on disk
    // Unsaved edits per file, so hopping between files never loses work and
    // nothing reaches the working directory (or git status) until Save.
    var drafts = {};
    var lastTree = [];     // [{ path, type }] under the working directory
    var fileSet = {};      // path -> true for every file in lastTree
    var lastStatus = null;
    var edNote = '';

    // The browser opens on the working directory and follows `cd`. "Up"
    // walks real folders while inside the project, then the folders of the
    // prompt's path above it (~/demo-project -> ~); those hold nothing but
    // the way back down, which is the truth as far as this page's
    // filesystem goes. Tree keys stay project-relative throughout, so drafts
    // and git status line up wherever the view is rooted.
    var pathSegs = (config.prompt || '~/project').replace(/\s*\$\s*$/, '').split('/');
    if (pathSegs[0] === '') pathSegs[0] = '/';
    pathSegs = pathSegs.filter(function (x) { return x !== ''; });
    var projIdx = pathSegs.length - 1;   // index of the project folder
    var wdPath = '';       // sb.cwdPath() as of the last refresh
    var upLevels = 0;      // how far above the working directory the view is
    var expanded = {};     // folder key -> true; real folders use their path
    var showHidden = false;

    function fullSegs() { return pathSegs.concat(wdPath ? wdPath.split('/') : []); }
    function wdKey() { return wdPath || '../' + projIdx; }

    // Hidden means a dot-named segment below the working directory or off
    // its path; a learner who has `cd .git` still sees where they are.
    function isHidden(path) {
      if (wdPath && (path === wdPath || wdPath.indexOf(path + '/') === 0)) return false;
      if (wdPath && path.indexOf(wdPath + '/') === 0) path = path.slice(wdPath.length + 1);
      return path.split('/').some(function (seg) { return seg.charAt(0) === '.'; });
    }

    function fileMark(f, status) {
      if (!status) return null;
      if ((status.conflicted || []).some(function (c) { return c.file === f; })) return { k: '!', label: 'conflict', cls: 'conflict' };
      if (status.untracked.indexOf(f) !== -1) return { k: 'U', label: 'untracked', cls: 'new' };
      if (status.modified.indexOf(f) !== -1) return { k: 'M', label: 'modified', cls: 'mod' };
      if (status.staged.some(function (s) { return s.file === f; })) return { k: 'A', label: 'staged', cls: 'new' };
      if ((status.ignored || []).indexOf(f) !== -1) return { k: 'I', label: 'ignored', cls: 'ignored', quiet: true };
      return null;
    }

    function buildTree() {
      var top = { children: {} };
      lastTree.forEach(function (e) {
        if (!showHidden && isHidden(e.path)) return;
        var parts = e.path.split('/'), node = top;
        parts.forEach(function (part, i) {
          if (!node.children[part]) {
            node.children[part] = {
              name: part, key: parts.slice(0, i + 1).join('/'),
              type: i === parts.length - 1 ? e.type : 'dir', children: {}
            };
          }
          node = node.children[part];
        });
      });
      var viewIdx = fullSegs().length - 1 - upLevels;
      if (viewIdx >= projIdx) {
        // inside the project: root the view at that real folder
        fullSegs().slice(projIdx + 1, viewIdx + 1).forEach(function (part) {
          top = top.children[part] || { children: {} };
        });
        return top;
      }
      // above it: wrap the project in the prompt path's folders
      for (var seg = projIdx; seg > viewIdx; seg--) {
        var wrap = { children: {} };
        wrap.children[pathSegs[seg]] = {
          name: pathSegs[seg], key: '../' + seg, type: 'dir', children: top.children
        };
        top = wrap;
      }
      return top;
    }

    function changedUnder(node) {
      if (node.type === 'file') {
        var m = fileMark(node.key, lastStatus);
        return !!m && !m.quiet;
      }
      return Object.keys(node.children).some(function (k) { return changedUnder(node.children[k]); });
    }

    function treeRows(node, depth) {
      var kids = Object.keys(node.children).map(function (k) { return node.children[k]; });
      kids.sort(function (x, y) {
        if (x.type !== y.type) return x.type === 'dir' ? -1 : 1;
        return x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
      });
      return kids.map(function (n) {
        if (n.type === 'dir') {
          var open = !!expanded[n.key];
          var wd = n.key === wdKey();
          var inner = Object.keys(n.children).length
            ? treeRows(n, depth + 1)
            : '<li class="gs-fb-none" data-depth="' + (depth + 1) + '">empty</li>';
          return '<li><button type="button" class="gs-fb-row gs-fb-folder' + (wd ? ' is-wd' : '') + '"' +
            ' aria-expanded="' + open + '" data-dir="' + esc(n.key) + '" data-depth="' + depth + '">' +
            '<span class="gs-fb-chev">' + ICON_CHEVRON + '</span>' +
            '<span class="gs-fb-fname">' + esc(n.name) + '/</span>' +
            (wd ? '<span class="gs-fb-wd" title="working directory">WD</span>' : '') +
            (changedUnder(n) ? '<span class="gs-fb-changed" title="contains changes">●<span class="gs-sr"> (contains changes)</span></span>' : '') +
            '</button>' + (open ? '<ul role="group">' + inner + '</ul>' : '') + '</li>';
        }
        var mark = fileMark(n.key, lastStatus);
        var on = n.key === openFile;
        return '<li><button type="button" class="gs-fb-row gs-fb-file' + (on ? ' is-open' : '') + '"' +
          (on ? ' aria-current="true"' : '') + ' data-file="' + esc(n.key) + '" data-depth="' + depth + '">' +
          '<span class="gs-fb-fname">' + esc(n.name) + '</span>' +
          (n.key in drafts ? '<span class="gs-fb-dirty" title="Unsaved changes">●<span class="gs-sr"> (unsaved)</span></span>' : '') +
          (mark ? '<span class="gs-fb-mark gs-fb-mark-' + mark.cls + '" title="' + mark.label + '">' + mark.k +
            '<span class="gs-sr"> (' + mark.label + ')</span></span>' : '') +
          '</button></li>';
      }).join('');
    }

    function renderFileBrowser() {
      var segs = fullSegs();
      fbTitle.textContent = segs[segs.length - 1 - upLevels] || '';
      fbTitle.title = segs.slice(0, segs.length - upLevels).join('/').replace(/^\/\//, '/');
      fbUp.disabled = upLevels >= segs.length - 1;
      fbHome.hidden = upLevels === 0;
      fbName.placeholder = 'new file in ' + (segs[segs.length - 1] || '');
      var html = treeRows(buildTree(), 0);
      fbList.innerHTML = html || '<li class="gs-fb-none" data-depth="0">No files yet.</li>';
      // Indent through the CSSOM rather than style="" attributes, which a
      // strict Content Security Policy would block.
      fbList.querySelectorAll('[data-depth]').forEach(function (n) {
        n.style.paddingLeft = (10 + Number(n.getAttribute('data-depth')) * 14 +
          (n.classList.contains('gs-fb-folder') ? 0 : 16)) + 'px';
      });
    }

    function revealInTree(f) {
      var parts = f.split('/');
      for (var i = 1; i < parts.length; i++) expanded[parts.slice(0, i).join('/')] = true;
    }

    function renderEditor() {
      var dirty = !!openFile && openKind === 'text' && edText.value !== savedText;
      var showText = !!openFile && openKind !== 'binary';
      edText.hidden = !showText;
      edText.readOnly = openKind !== 'text';
      edEmpty.hidden = showText;
      edEmpty.textContent = openFile
        ? 'This file is binary (git stores objects compressed), so there is nothing readable to show.'
        : (Object.keys(fileSet).length ? 'Pick a file on the left to open it here.'
          : 'No files yet. Use + to create one.');
      edName.textContent = openFile || '';
      edSave.disabled = !dirty;
      edRevert.disabled = !dirty;
      edStatus.textContent = dirty ? 'unsaved'
        : openFile && openKind !== 'text' ? 'read-only' + (openKind === 'readonly' ? ', managed by git' : '')
        : edNote;
      if (dirtyDot) dirtyDot.hidden = !Object.keys(drafts).length;
    }

    // Read the open file and decide how it can be shown. Anything under
    // .git is git's own bookkeeping: viewable, but editing it by hand is how
    // repositories get broken, so it is read-only.
    async function loadOpenFile() {
      var bytes;
      try { bytes = await sb.readBytes(openFile); } catch (e) { bytes = new Uint8Array(0); }
      var text = null;
      if (bytes.indexOf(0) === -1) {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { text = null; }
      }
      openKind = text === null ? 'binary' : (/^\.git(\/|$)/.test(openFile) ? 'readonly' : 'text');
      savedText = text || '';
    }

    async function openInEditor(f) {
      openFile = f;
      edNote = '';
      revealInTree(f);
      await loadOpenFile();
      edText.value = f in drafts ? drafts[f] : savedText;
      renderFileBrowser();
      renderEditor();
    }

    // After any command, undo or reset, pick up what changed on disk. A file
    // with an unsaved draft keeps the draft: the learner's typing wins.
    async function syncEditor() {
      var wdNow = sb.cwdPath();
      if (wdNow !== wdPath) {
        // a `cd` moves the browser along with the shell
        wdPath = wdNow;
        upLevels = 0;
      }
      if (openFile && !fileSet[openFile] && !(openFile in drafts)) {
        openFile = null;
        openKind = 'text';
        edText.value = '';
        savedText = '';
      }
      if (openFile) {
        await loadOpenFile();
        if (!(openFile in drafts) && edText.value !== savedText) edText.value = savedText;
      }
      renderFileBrowser();
      renderEditor();
    }

    // Writing a file from the editor is a state change like any command:
    // it gets an undo entry and re-runs the task checks.
    async function editorWrite(name, text, label) {
      if (busy) return false;
      setBusy(true);
      var snap = captureUndo(label);
      try {
        await sb.writeFile(name, text);
      } catch (e) {
        edNote = 'could not save: ' + e.message;
        setBusy(false);
        renderEditor();
        return false;
      }
      if (sb.changedSince(snap.core)) pushUndo(snap);
      await refresh();
      notifyViews();
      setBusy(false);
      return true;
    }

    async function saveFile() {
      if (!openFile || edText.value === savedText) return;
      var name = openFile, text = edText.value;
      delete drafts[name];
      if (await editorWrite(name, text, 'save ' + name)) {
        edNote = 'saved';
        renderEditor();
      } else {
        drafts[name] = text;
      }
    }

    function revertFile() {
      if (!openFile) return;
      delete drafts[openFile];
      edText.value = savedText;
      edNote = '';
      renderFileBrowser();
      renderEditor();
      edText.focus();
    }

    // New files are named from the working directory, as `touch` would be,
    // and must land inside the project and outside .git; a lesson never
    // needs anything else, and git would refuse most of the rest.
    function fromWd(name) {
      var out = wdPath ? wdPath.split('/') : [];
      var parts = name.split('/');
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] === '' || parts[i] === '.') continue;
        if (parts[i] === '..') { if (!out.length) return null; out.pop(); }
        else out.push(parts[i]);
      }
      return out.join('/');
    }

    function badFileName(raw, name) {
      if (!raw) return 'Type a file name.';
      if (/\s/.test(raw)) return 'Leave spaces out of file names; they make commands harder to type.';
      if (/\/$/.test(raw)) return 'That is a folder name. Add a file name after the slash.';
      if (/^\//.test(raw) || !name) return 'Use a name inside the project, like notes.md or data/notes.md.';
      if (/^\.git(\/|$)/.test(name)) return 'Files inside .git belong to git. Pick another name.';
      if (lastTree.some(function (e) { return e.path === name && e.type === 'dir'; })) return 'A folder already has that name.';
      return null;
    }

    async function createFile(raw) {
      raw = raw.trim();
      var name = fromWd(raw);
      var problem = badFileName(raw, name);
      if (problem) { fbErr.textContent = problem; return; }
      fbErr.textContent = '';
      fbCreate.hidden = true;
      fbName.value = '';
      if (!fileSet[name]) {
        if (!(await editorWrite(name, '', 'create ' + name))) return;
      }
      await openInEditor(name);
      edText.focus();
    }

    fbList.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.gs-fb-row') : null;
      if (!b) return;
      if (b.hasAttribute('data-dir')) {
        var k = b.getAttribute('data-dir');
        expanded[k] = !expanded[k];
        renderFileBrowser();
        var again = fbList.querySelector('[data-dir="' + k.replace(/["\\]/g, '\\$&') + '"]');
        if (again) again.focus();
        return;
      }
      openInEditor(b.getAttribute('data-file')).then(function () { if (!edText.hidden) edText.focus(); });
    });
    fbUp.addEventListener('click', function () {
      var segs = fullSegs();
      if (upLevels >= segs.length - 1) return;
      upLevels++;
      // open the way back down so the working directory stays in view
      for (var seg = segs.length - 1 - upLevels + 1; seg <= projIdx; seg++) expanded['../' + seg] = true;
      var parts = wdPath ? wdPath.split('/') : [];
      for (var i = 1; i <= parts.length; i++) expanded[parts.slice(0, i).join('/')] = true;
      renderFileBrowser();
    });
    fbHome.addEventListener('click', function () {
      upLevels = 0;
      renderFileBrowser();
      fbUp.focus();
    });
    fbHidden.addEventListener('change', function () {
      showHidden = fbHidden.checked;
      renderFileBrowser();
    });
    edText.addEventListener('input', function () {
      if (!openFile) return;
      var was = openFile in drafts;
      if (edText.value === savedText) delete drafts[openFile];
      else drafts[openFile] = edText.value;
      edNote = '';
      if (was !== (openFile in drafts)) renderFileBrowser();
      renderEditor();
    });
    edText.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveFile();
      }
    });
    edSave.addEventListener('click', function () { saveFile(); });
    edRevert.addEventListener('click', revertFile);
    fbNewBtn.addEventListener('click', function () {
      fbCreate.hidden = !fbCreate.hidden;
      fbErr.textContent = '';
      if (!fbCreate.hidden) fbName.focus();
    });
    fbCreate.addEventListener('submit', function (e) {
      e.preventDefault();
      createFile(fbName.value);
    });
    fbName.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { fbCreate.hidden = true; fbName.value = ''; fbErr.textContent = ''; fbNewBtn.focus(); }
    });

    function write(html, cls) {
      var line = el('div', 'gs-line' + (cls ? ' ' + cls : ''), html);
      out.appendChild(line);
      out.scrollTop = out.scrollHeight;
    }
    function writeText(text, cls) {
      if (text === '' || text == null) return;
      write(markup(text), cls);
    }
    // a command as the terminal shows it once entered
    function echo(prompt, line) {
      write('<span class="gs-echo-prompt">' + esc(prompt) + '</span> ' + esc(line), 'gs-echo');
    }

    function renderHints() {
      var hints = config.hints || [];
      if (!hints.length) { hintsNode.innerHTML = ''; return; }
      hintsNode.innerHTML = '<span class="gs-hints-label">Try:</span>';
      hints.forEach(function (h) {
        var b = el('button', 'gs-hint', esc(h));
        b.type = 'button';
        b.addEventListener('click', function () { input.value = h; input.focus(); });
        hintsNode.appendChild(b);
      });
    }

    function renderTasks() {
      if (!tasks.length) { tasksNode.innerHTML = ''; return; }
      var done = 0;
      var rows = tasks.map(function (t) {
        if (t._error) {
          return '<li class="gs-task gs-task-broken">' +
                 '<span class="gs-task-mark" aria-hidden="true">!</span>' +
                 '<span class="gs-task-txt">' + t.text +
                 '<span class="gs-task-err">Authoring error: ' + esc(t._error) + '</span></span></li>';
        }
        var ok = !!t._done;
        if (ok) done++;
        // A task that ticked on this render gets a brief highlight, so the
        // completion registers even while the eye is on the terminal.
        var fresh = ok && !t._wasDone;
        t._wasDone = ok;
        return '<li class="gs-task' + (ok ? ' is-done' : '') + (fresh ? ' is-just-done' : '') + '">' +
               '<span class="gs-task-mark" aria-hidden="true">' + (ok ? '✓' : '') + '</span>' +
               '<span class="gs-task-txt">' + t.text + '</span></li>';
      }).join('');
      var broken = tasks.some(function (t) { return !!t._error; });
      var all = !broken && done === tasks.length;
      var note = config.doneNote || 'That is the whole exercise.';
      tasksNode.innerHTML =
        '<div class="gs-tasks-h">Tasks <span class="gs-count">' + done + ' of ' + tasks.length + '</span></div>' +
        '<ul class="gs-task-list">' + rows + '</ul>' +
        (all ? '<div class="gs-done">' + note + '</div>' : '');
    }

    async function refresh() {
      var graph = await sb.graphModel();
      var isRepo = await sb.isRepo();
      var status = isRepo ? await sb.statusModel()
        : { staged: [], modified: [], untracked: [], deleted: [], stagedDeleted: [], conflicted: [], merging: false, ignored: [] };
      var files = await sb.listFiles();
      var diff = await sb.diffModel();
      var chipsBefore = chipRects(stagesNode);
      renderStages(stagesNode, status, graph, files, isRepo);
      // a reset (or the first drawing) appears at once, like the tree
      if (!stagesInstant) {
        animateStages(stagesNode, chipsBefore,
          graph.commits.length > lastCommitCount ? commitColor(graph) : null);
      }
      stagesInstant = false;
      lastCommitCount = graph.commits.length;
      renderDiff(diffNode, diff);
      lastGraph = graph;
      drawHistory(graph);
      lastTree = await sb.listTree();
      fileSet = {};
      lastTree.forEach(function (e) { if (e.type === 'file') fileSet[e.path] = true; });
      lastStatus = isRepo ? status : null;
      await syncEditor();
      lastGraphW = svg.clientWidth;
      if (tree) drawTree(graph);

      var remote = await sb.remoteModel(remoteName);
      if (remote) {
        remoteWrap.hidden = false;
        remoteName = remote.name;
        drawRemoteName(remote);
        renderCompactGraph(localSvg, graph);
        renderCompactGraph(remoteSvg, remote.graph, true);
        lastRemoteGraph = remote.graph;
        lastRemoteGraphW = remoteSvg.clientWidth;
        lastLocalGraphW = localSvg.clientWidth;
      } else {
        remoteWrap.hidden = true;
        lastRemoteGraph = null;
      }

      // Tab badges: enough signal that folded panels lose nothing you would
      // catch at a glance. A count means "something here"; ✓ means clean.
      var changed = (status.conflicted || []).length + status.untracked.length + status.modified.length +
        status.deleted.length + status.staged.length + status.stagedDeleted.length;
      setBadge('files', isRepo ? (changed ? String(changed) : '✓')
        : (files.length ? String(files.length) : ''));
      setBadge('changes', !isRepo ? '' : (diff && diff.files.length ? String(diff.files.length) : '✓'));
      setBadge('history', graph.commits.length ? String(graph.commits.length) : '');
      tabButtons.remote.hidden = !remote || !panelOn.remote;
      if (remote) {
        setBadge('remote', !remote.tracked ? ''
          : (!remote.ahead && !remote.behind) ? '✓'
          : ((remote.ahead ? '⇡' + remote.ahead : '') +
             (remote.ahead && remote.behind ? ' ' : '') +
             (remote.behind ? '⇣' + remote.behind : '')));
      } else if (activeTab === 'remote') {
        selectTab(defaultTab);
      }

      // `file x contains "y"` needs file contents; read them up front so the
      // compiled predicates can stay synchronous.
      var contents = {};
      for (var f = 0; f < tasks.length; f++) {
        for (var g = 0; g < (tasks[f]._files || []).length; g++) {
          var name = tasks[f]._files[g];
          if (name in contents) continue;
          try { contents[name] = await sb.readFile(name); }
          catch (e) { contents[name] = ''; }
        }
      }

      var ctx = {
        sb: sb, graph: graph, status: status, files: files,
        history: history, isRepo: isRepo, remote: remote,
        _fileText: function (name) { return contents[name] || ''; }
      };
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i]._done || tasks[i]._error) continue;
        try { tasks[i]._done = !!(await tasks[i].check(ctx)); }
        catch (e) { tasks[i]._done = false; }
      }
      renderTasks();

      undoBtn.disabled = !canUndo();

      var br = graph.head;
      // follows `cd`, so the prompt always says which folder paths resolve in
      // a stopped merge shows as (main|MERGING), as git's own prompt does
      host.querySelector('.gs-prompt').textContent =
        sb.pwd() + (br ? ' (' + br + (status.merging ? '|MERGING' : '') + ')' : '') + ' $';
    }

    // The history graph, with the contents of each opened commit laid out
    // under its row: the details are HTML (diffs need text layout), placed
    // over a gap the graph leaves for them.
    function drawHistory(graph) {
      cdLayer.innerHTML = '';
      var heights = {}, nodes = {};
      var left = graphTextX(graph);
      var width = Math.max(160, (svg.clientWidth || 640) - left - 40);
      graph.commits.forEach(function (c) {
        if (!openCommits[c.oid] || !commitInfo[c.oid]) return;
        var n = el('div', 'gs-cd', commitDetailsHtml(commitInfo[c.oid]));
        n.setAttribute('data-oid', c.oid);
        n.style.left = left + 'px';
        n.style.width = width + 'px';
        cdLayer.appendChild(n);
        nodes[c.oid] = n;
        // jsdom (and a hidden panel) has no layout: estimate instead
        heights[c.oid] = (n.offsetHeight || 90 + commitInfo[c.oid].files.reduce(function (sum, f) {
          return sum + 30 + f.lines.length * 18;
        }, 0)) + 14;
      });
      var lay = renderGraph(svg, graph, { open: heights, onToggle: toggleCommit });
      Object.keys(nodes).forEach(function (oid) { nodes[oid].style.top = lay.detailTop[oid] + 'px'; });
    }

    async function toggleCommit(oid) {
      if (openCommits[oid]) {
        delete openCommits[oid];
      } else {
        if (!commitInfo[oid]) {
          try { commitInfo[oid] = await sb.commitDetails(oid); }
          catch (e) { return; }
        }
        openCommits[oid] = true;
      }
      if (lastGraph) drawHistory(lastGraph);
      // the redraw replaced the button; keep keyboard focus on it
      var again = svg.querySelector('.gs-cd-toggle[data-oid="' + oid + '"]');
      if (again && again.focus) again.focus();
    }

    function drawTree(graph) {
      var lay = tree.update(graph, treeInstant);
      treeInstant = false;
      // keep the commit HEAD points at in view as the tree grows downwards
      var p = graph.headOid && lay.pos[graph.headOid];
      if (!p || !treeScroll.clientHeight) return;
      var top = treeScroll.scrollTop, h = treeScroll.clientHeight, py = p.y * lay.scale;
      if (py - 40 < top || py + 50 > top + h) {
        var y = Math.max(0, py - h / 2);
        if (treeScroll.scrollTo) treeScroll.scrollTo({ top: y, behavior: 'smooth' });
        else treeScroll.scrollTop = y;
      }
    }

    /* ------------------------------ vim ------------------------------ */

    // A small modal vim, just enough to write a commit message and, more to
    // the point, to show learners why "how do I quit vim" is a famous
    // question. It starts in normal mode where typing does nothing useful,
    // and only the real ways out (:wq, :x, ZZ, :q!, ZQ) leave it. Resolves
    // with what was last written to the file, the way git reads it back.
    function openVim(file, text) {
      var saved = text;
      var mode = 'normal';
      var cmd = '';
      var pending = '';
      var nLines = function (t) { return t.replace(/\n$/, '').split('\n').length; };
      var info = '"' + file + '" ' + nLines(text) + 'L, ' + text.length + 'B';

      function status(msg, isErr) {
        vimStatus.textContent = msg;
        vimStatus.classList.toggle('is-err', !!isErr);
      }
      function caret(pos) {
        pos = Math.max(0, Math.min(vimText.value.length, pos));
        vimText.selectionStart = vimText.selectionEnd = pos;
      }
      function lineStart(pos) { return vimText.value.lastIndexOf('\n', pos - 1) + 1; }
      function lineEnd(pos) {
        var e = vimText.value.indexOf('\n', pos);
        return e === -1 ? vimText.value.length : e;
      }
      function setMode(m) {
        mode = m;
        vimNode.classList.toggle('is-insert', m === 'insert');
        if (m === 'insert') status('-- INSERT --');
        else if (m === 'normal') status('');
      }
      function moveLine(dir) {
        var pos = vimText.selectionStart, s = lineStart(pos), col = pos - s;
        if (dir < 0) {
          if (s === 0) return;
          var ps = lineStart(s - 1);
          caret(Math.min(ps + col, s - 1));
        } else {
          var e = lineEnd(pos);
          if (e === vimText.value.length) return;
          caret(Math.min(e + 1 + col, lineEnd(e + 1)));
        }
      }
      function write() {
        saved = vimText.value;
        status('"' + file + '" ' + nLines(saved) + 'L, ' + saved.length + 'B written');
      }
      function runCmd(c) {
        var bang = /!$/.test(c);
        var name = c.replace(/!$/, '');
        if (name === 'w') { write(); return; }
        if (name === 'wq' || name === 'x' || name === 'wqa' || name === 'xa') { write(); close(saved); return; }
        if (name === 'q' || name === 'qa') {
          if (!bang && vimText.value !== saved) {
            status('E37: No write since last change (add ! to override)', true);
            return;
          }
          close(saved);
          return;
        }
        status('E492: Not an editor command: ' + c, true);
      }
      // `result` is what git reads back; undefined means the session was
      // abandoned by Reset and there is no commit to finish
      function close(result) {
        vim = null;
        vimNode.hidden = true;
        out.hidden = false;
        form.hidden = false;
        hintsNode.hidden = false;
        vimText.removeEventListener('keydown', onKey);
        vimText.removeEventListener('beforeinput', onBeforeInput);
        resolve(result);
      }

      function onBeforeInput(e) {
        // phones type through beforeinput, not keydown; only insert mode edits
        if (mode !== 'insert') e.preventDefault();
      }

      function onKey(e) {
        var k = e.key;
        if (mode === 'insert') {
          if (k === 'Escape' || (e.ctrlKey && k === 'c')) {
            e.preventDefault();
            setMode('normal');
            // like vim, leaving insert mode steps back onto the last character
            var p = vimText.selectionStart;
            if (p > lineStart(p)) caret(p - 1);
          }
          return;
        }
        if (mode === 'cmd') {
          e.preventDefault();
          if (k === 'Escape' || (e.ctrlKey && k === 'c')) { setMode('normal'); return; }
          if (k === 'Enter') { setMode('normal'); runCmd(cmd.slice(1).trim()); return; }
          if (k === 'Backspace') {
            cmd = cmd.slice(0, -1);
            if (!cmd) { setMode('normal'); return; }
          } else if (k.length === 1) {
            cmd += k;
          }
          status(cmd);
          return;
        }

        // normal mode: arrows, Home, End and paging keep their usual meaning
        if (/^(Arrow|Page)|^(Home|End|Tab|Shift|Control|Alt|Meta)$/.test(k)) return;
        if (e.metaKey || (e.altKey && !e.ctrlKey)) return;
        e.preventDefault();
        if (e.ctrlKey) {
          if (k === 'c') status('Type  :qa!  and press <Enter> to abandon all changes and exit Vim');
          return;
        }
        var pos = vimText.selectionStart;
        var v = vimText.value;
        var two = pending + k;
        pending = '';
        if (two === 'ZZ') { if (v !== saved) write(); close(saved); return; }
        if (two === 'ZQ') { close(saved); return; }
        if (two === 'dd') {
          var s0 = lineStart(pos), e0 = lineEnd(pos);
          vimText.value = v.slice(0, s0) + v.slice(e0 + 1);
          caret(s0);
          return;
        }
        if (two === 'gg') { caret(0); return; }
        switch (k) {
          case 'i': setMode('insert'); return;
          case 'a': if (pos < lineEnd(pos)) caret(pos + 1); setMode('insert'); return;
          case 'I': caret(lineStart(pos)); setMode('insert'); return;
          case 'A': caret(lineEnd(pos)); setMode('insert'); return;
          case 'o':
            var eo = lineEnd(pos);
            vimText.value = v.slice(0, eo) + '\n' + v.slice(eo);
            caret(eo + 1); setMode('insert'); return;
          case 'O':
            var so = lineStart(pos);
            vimText.value = v.slice(0, so) + '\n' + v.slice(so);
            caret(so); setMode('insert'); return;
          case 'h': if (pos > lineStart(pos)) caret(pos - 1); return;
          case 'l': if (pos < lineEnd(pos) - 1) caret(pos + 1); return;
          case 'j': moveLine(1); return;
          case 'k': moveLine(-1); return;
          case '0': caret(lineStart(pos)); return;
          case '$': caret(Math.max(lineStart(pos), lineEnd(pos) - 1)); return;
          case 'G': caret(lineStart(v.length > 0 && v.charAt(v.length - 1) === '\n' ? v.length - 1 : v.length)); return;
          case 'x':
            if (pos < lineEnd(pos)) { vimText.value = v.slice(0, pos) + v.slice(pos + 1); caret(pos); }
            return;
          case ':': mode = 'cmd'; cmd = ':'; status(cmd); return;
          case 'Z': case 'd': case 'g': pending = k; return;
          case 'Escape': return;
        }
      }

      var resolve;
      var done = new Promise(function (r) { resolve = r; });
      vim = { abandon: function () { close(undefined); } };
      out.hidden = true;
      form.hidden = true;
      hintsNode.hidden = true;
      vimNode.hidden = false;
      vimText.value = text;
      vimText.addEventListener('keydown', onKey);
      vimText.addEventListener('beforeinput', onBeforeInput);
      setMode('normal');
      status(info);
      selectView('terminal');
      vimText.focus();
      caret(0);
      return done;
    }

    // `quiet`: a scripted command, run without taking the keyboard, which
    // on a slide belongs to reveal.js
    async function submit(line, quiet) {
      if (busy) return;
      setBusy(true);
      var trimmed = line.trim();
      if (trimmed === 'undo') {
        // never reaches the engine: undo is a sandbox affordance, not git
        doUndo();
        await refresh();
        notifyViews();
        setBusy(false);
        if (!quiet) input.focus();
        return;
      }
      var snap = captureUndo(line);
      echo(promptText(), line);
      history.push(line);
      histIdx = history.length;
      var r = await sb.run(line);
      if (r.editor) {
        var saved = await openVim(r.editor.file, r.editor.text);
        // Reset closes the editor from underneath us and starts afresh
        if (saved === undefined) return;
        r = await sb.finishCommit(saved);
      }
      if (trimmed === 'clear') { out.innerHTML = ''; }
      else if (trimmed === 'help') { writeText(helpText()); }
      else if (trimmed === 'reset') { await doReset(); }
      else { writeText(r.out, r.ok ? '' : 'gs-err'); }
      // a merge that stops on conflicts fails but still changes the repo,
      // and undoing it is the quickest way back out
      var changed = sb.changedSince(snap.core);
      if (trimmed !== 'reset' && changed) pushUndo(snap);
      // Switch before the refresh too, so the panel is on screen while its
      // chips move; and after, for a tab the refresh has just revealed.
      var want = r.ok ? tabFor(line) : null;
      if (want) selectTab(want);
      await refresh();
      if (want) selectTab(want);
      if (changed && trimmed !== 'reset') notifyViews();
      setBusy(false);
      if (!quiet) input.focus();
    }

    // The remote half's heading names the remote shown; with several it is
    // a dropdown. Only rebuilt when the names change, so an open dropdown
    // keeps its focus across refreshes.
    var lastRemoteNames = '';
    function drawRemoteName(r) {
      var names = r.remotes || [r.name];
      var key = names.join('\n');
      if (key !== lastRemoteNames) {
        lastRemoteNames = key;
        if (names.length > 1) {
          remoteNameNode.innerHTML = '<select class="gs-remote-select" aria-label="Remote">' +
            names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') +
            '</select>';
          remoteNameNode.firstChild.addEventListener('change', function (e) {
            remoteName = e.target.value;
            refresh();
          });
        } else {
          remoteNameNode.textContent = r.name;
        }
      }
      if (names.length > 1) remoteNameNode.firstChild.value = r.name;
    }

    function helpText() {
      return [
        '{w}This sandbox runs real git{/} (isomorphic-git) on a repo that lives only in this page.',
        '',
        '{y}git{/}    init, status, add [-f], rm [--cached], commit [-a] [-m], log [--oneline], diff,',
        '       restore [--staged], reset [--soft|--hard] [<commit>|<file>],',
        '       branch [-d] [-a], checkout [-b] <branch|commit>, checkout --track,',
        '       switch [-c|--detach] <branch>, switch -,',
        '       merge [--abort], config [--global],',
        '       remote add origin, clone, push [-u], pull [origin <branch>], fetch',
        '{y}shell{/}  ls, cat, echo "text" > file, echo "text" >> file, touch, rm [-r],',
        '       mkdir, cd, pwd',
        '       any command > file (or >> file) writes its output to a file',
        '{y}other{/}  help, clear, reset, undo',
        '       {y}*{/} and {y}?{/} match file names: git add *.txt',
        '',
        '{y}git <command> -h{/} shows how a git command is used.',
        '',
        '{y}git commit{/} without -m opens {y}vim{/}, as real git usually does.',
        'Press {y}i{/} to type, {y}Esc{/} to stop typing, then {y}:wq{/} and Enter to',
        'save and commit, or {y}:q!{/} and Enter to give up.',
        '',
        'A {y}merge{/} that conflicts leaves {y}<<<<<<<{/} markers in the files: edit them',
        'to keep what you want, then {y}git add{/} and {y}git commit{/}. {y}git merge --abort{/}',
        'gives up.',
        '',
        '{y}undo{/} takes back your last state-changing command (a sandbox',
        'nicety, not a git command — real git has no undo).'
      ].concat(editorOn ? [
        '',
        'The {y}Editor{/} tab above the terminal opens files for editing.',
        'Saved edits land in the working directory, ready for git add.'
      ] : []).join('\n');
    }

    // `initial`: the box is mounting, not being reset by the learner. A
    // view of a shared repository then shows it as it stands instead of
    // starting it over.
    async function doReset(initial) {
      if (vim) {
        // abandon the commit in progress; the submit waiting on it bows out
        vim.abandon();
        setBusy(false);
      }
      out.innerHTML = '';
      input.value = '';
      resetScript();
      // Tasks checked with `ran "..."` read the command history, so it has to
      // go too or they re-complete themselves on the very next refresh.
      history.length = 0;
      histIdx = 0;
      if (!(initial && !isOrigin)) undoStack.length = 0;
      tasks.forEach(function (t) { t._done = false; t._wasDone = false; });
      selectTab(defaultTab);
      // unsaved drafts belong to the run being thrown away
      drafts = {};
      openFile = null;
      openKind = 'text';
      edText.value = '';
      savedText = '';
      edNote = '';
      fbCreate.hidden = true;
      upLevels = 0;
      expanded = {};
      if (tree) { tree.reset(); treeInstant = true; }
      openCommits = {};
      commitInfo = {};
      stagesInstant = true;
      try {
        if (initial && !isOrigin) {
          await group.ready;
        } else {
          // a view's Reset starts the shared repository over from its seed
          var resetting = sb.reset(group.seed);
          group.ready = resetting.then(function () {}, function () {});
          await resetting;
        }
      } catch (e) {
        writeText('{r}This exercise could not be set up: ' + e.message + '{/}', 'gs-err');
        await refresh();
        return;
      }
      intro.forEach(function (l) { writeText(l); });
      await refresh();
      if (!(initial && !isOrigin)) notifyViews(initial ? '' : '{y}This repository was reset from another view.{/}');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value;
      // Enter on a scripted command that is waiting in the prompt runs it
      // the scripted way, so the script does not run it a second time
      if (scriptTyped && v.trim() === script[scriptRan]) { scriptGo(scriptStep() + 1); return; }
      input.value = '';
      if (!v.trim()) return;
      submit(v);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp') {
        if (!history.length) return;
        e.preventDefault();
        histIdx = Math.max(0, histIdx - 1);
        input.value = history[histIdx] || '';
      } else if (e.key === 'ArrowDown') {
        if (!history.length) return;
        e.preventDefault();
        histIdx = Math.min(history.length, histIdx + 1);
        input.value = history[histIdx] || '';
      }
    });

    resetBtn.addEventListener('click', function () { doReset(); });
    undoBtn.addEventListener('click', function () { submit('undo'); });
    host.querySelector('.gs-out').addEventListener('click', function () { input.focus(); });

    /* ------------------------ scripted commands ----------------------- */

    // A `script` plays back in steps: step 2k+1 types command k into the
    // prompt, step 2k+2 runs it. On a reveal.js slide each step is one of
    // the fragments the filter put beside the box, and the box follows
    // whichever of them are visible, so the deck's own keys, its URL and
    // its overview all drive it. Elsewhere the list's Next button does.
    //
    // Going back restores the snapshot taken just before the command,
    // so stepping backwards through a slide is exact time travel.
    var scriptRan = 0;          // commands passed: run, or skipped
    var scriptTyped = false;    // is script[scriptRan] waiting in the prompt?
    var scriptSkipped = {};
    var scriptSnaps = [];       // scriptSnaps[k]: the state before command k
    var scriptGen = 0;          // bumped by every move, to cut typing short
    var scriptTarget = 0;       // the step the latest move is heading for
    var scriptChain = null;     // moves run one after another, after mount
    var scriptNode = host.querySelector('.gs-script');
    var countBtn = host.querySelector('.gs-script-count');
    var scriptList = host.querySelector('.gs-script-list');
    var skipBtn = host.querySelector('.gs-script-skip');
    var nextBtn = host.querySelector('.gs-script-next');
    var caretNode = host.querySelector('.gs-type-caret');
    var measureNode = host.querySelector('.gs-type-measure');
    var hookSteps = null;
    var stepFrags = host.id
      ? Array.prototype.slice.call(document.querySelectorAll('.gs-step[data-gs-for="' + host.id + '"]'))
      : [];

    function scriptStep() { return scriptRan * 2 + (scriptTyped ? 1 : 0); }
    function deck() { return stepFrags.length && root.Reveal && root.Reveal.on ? root.Reveal : null; }

    function resetScript() {
      scriptGen++;
      scriptTarget = 0;
      scriptRan = 0;
      scriptTyped = false;
      scriptSkipped = {};
      scriptSnaps = [];
      if (script.length) renderScript();
    }

    function renderScript() {
      if (!script.length) return;
      var shown = scriptRan + (scriptTyped ? 1 : 0);
      countBtn.textContent = '[' + shown + '/' + script.length + ']';
      countBtn.setAttribute('aria-label', 'Scripted command ' + shown + ' of ' + script.length + '; show the list');
      scriptList.innerHTML = script.map(function (c, i) {
        var state = i < scriptRan ? (scriptSkipped[i] ? 'skipped' : 'ran')
          : (i === scriptRan && scriptTyped ? 'current' : 'next');
        var mark = { ran: '✓', skipped: '↷', current: '▸', next: String(i + 1) }[state];
        var label = { ran: 'ran', skipped: 'skipped', current: 'in the prompt', next: 'not yet run' }[state];
        return '<li><button type="button" class="gs-script-item is-' + state + '" data-i="' + i + '"' +
          ' title="Jump to this command">' +
          '<span class="gs-script-mark" aria-hidden="true">' + mark + '</span>' +
          '<code>' + esc(c) + '</code><span class="gs-sr"> (' + label + ')</span></button></li>';
      }).join('');
      // skip the command in the prompt, or else the one up next
      skipBtn.disabled = scriptRan >= script.length;
      nextBtn.disabled = scriptRan >= script.length;
      var cur = scriptList.querySelector('.is-current');
      if (cur && cur.scrollIntoView && scriptNode.classList.contains('is-open')) cur.scrollIntoView({ block: 'nearest' });
    }

    // the fake caret that follows the typing, since the input is not focused
    function placeCaret() {
      measureNode.textContent = input.value;
      caretNode.style.left = (input.offsetLeft + 2 + measureNode.offsetWidth - input.scrollLeft) + 'px';
    }
    function showCaret(on) {
      caretNode.hidden = !on;
      if (on) placeCaret();
    }

    function reducedMotion() {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function typeOut(cmd, gen) {
      input.value = '';
      if (reducedMotion()) { input.value = cmd; showCaret(true); return Promise.resolve(); }
      showCaret(true);
      // long commands type faster, so none takes much more than a second
      var per = Math.max(18, Math.min(60, 1400 / cmd.length));
      return new Promise(function (resolve) {
        var i = 0;
        (function tick() {
          if (gen !== scriptGen) { resolve(); return; }
          input.value = cmd.slice(0, ++i);
          input.scrollLeft = input.scrollWidth;
          placeCaret();
          if (i >= cmd.length) { resolve(); return; }
          setTimeout(tick, per * (0.6 + Math.random() * 0.8));
        })();
      });
    }

    function scriptRestore(k) {
      var snap = scriptSnaps[k];
      if (!snap) return;
      restoreSnap(snap);
      if (undoStack.length > snap.undoLen) undoStack.length = snap.undoLen;
      scriptSnaps.length = k;
      scriptRan = k;
      // a command stepped back over can be run this time
      for (var i = k; i < script.length; i++) delete scriptSkipped[i];
    }

    async function waitIdle() {
      while (busy) await new Promise(function (r) { setTimeout(r, 40); });
    }

    async function applyStep(target, gen) {
      // only the latest move matters: it says where to end up
      if (gen !== scriptGen) return;
      var wantRan = Math.floor(target / 2);
      var wantTyped = target % 2 === 1;
      var forward = target > scriptStep();
      if (wantRan < scriptRan) {
        scriptRestore(wantRan);
        scriptTyped = false;
        input.value = '';
        showCaret(false);
        await refresh();
        notifyViews();
      }
      while (scriptRan < wantRan) {
        if (gen !== scriptGen) return;
        var k = scriptRan;
        await waitIdle();
        var snap = captureUndo(script[k]);
        snap.undoLen = undoStack.length;
        scriptSnaps[k] = snap;
        input.value = '';
        showCaret(false);
        scriptTyped = false;
        scriptRan = k + 1;
        renderScript();
        if (!scriptSkipped[k]) await submit(script[k], true);
      }
      if (gen !== scriptGen) return;
      if (wantTyped) {
        var cmd = script[wantRan];
        var already = scriptTyped && input.value === cmd;
        scriptTyped = true;
        renderScript();
        if (!already) {
          if (forward) await typeOut(cmd, gen);
          else { input.value = cmd; showCaret(true); }
        }
      } else {
        if (scriptTyped) input.value = '';
        scriptTyped = false;
        showCaret(false);
      }
      renderScript();
    }

    // queue a move to `target`; each move waits for the last to finish
    function scriptMove(target) {
      target = Math.max(0, Math.min(script.length * 2, target));
      var gen = ++scriptGen;
      scriptTarget = target;
      // a scripted `git commit` without -m waits in vim; going back gives up on it
      if (vim && target < scriptStep()) { vim.abandon(); setBusy(false); }
      scriptChain = (scriptChain || ready).then(function () { return applyStep(target, gen); })
        .catch(function (e) { writeText('{r}The script stopped: ' + e.message + '{/}', 'gs-err'); });
      return scriptChain;
    }

    // follow the fragments: how many of this box's are showing is the step
    function followDeck() {
      var n = 0;
      stepFrags.forEach(function (f) { if (f.classList.contains('visible')) n++; });
      if (n !== scriptTarget) scriptMove(n);
    }

    // a move asked for from the box itself; on a slide it goes through
    // reveal.js, so the deck's fragments stay the record of where we are
    function scriptGo(target) {
      target = Math.max(0, Math.min(script.length * 2, target));
      var R = deck();
      if (R && R.navigateFragment) {
        var idx = target === 0 ? -1 : Number(stepFrags[target - 1].getAttribute('data-fragment-index'));
        if (!isNaN(idx)) {
          R.navigateFragment(idx);
          followDeck();
          return;
        }
      }
      scriptMove(target);
    }

    if (script.length) {
      var openPop = function (on) {
        scriptNode.classList.toggle('is-open', on);
        countBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      };
      countBtn.addEventListener('click', function () { openPop(!scriptNode.classList.contains('is-open')); });
      scriptNode.addEventListener('mouseenter', function () { openPop(true); });
      scriptNode.addEventListener('mouseleave', function () { openPop(false); });
      scriptNode.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { openPop(false); countBtn.focus(); }
      });
      // keep focus off the buttons afterwards: on a slide Space and the
      // arrows belong to reveal.js, and a focused button would take them
      var done = function () { if (deck() && document.activeElement) document.activeElement.blur(); };
      scriptList.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.gs-script-item') : null;
        if (!b) return;
        var i = Number(b.getAttribute('data-i'));
        // jumping to a command lines it up in the prompt, running the ones
        // before it that have not run yet
        delete scriptSkipped[i];
        scriptGo(i * 2 + 1);
        done();
      });
      skipBtn.addEventListener('click', function () {
        var k = scriptRan;
        if (k >= script.length) return;
        scriptSkipped[k] = true;
        // on to the next command, typed and waiting; past the last, the end
        scriptGo(k + 1 < script.length ? (k + 1) * 2 + 1 : script.length * 2);
        done();
      });
      nextBtn.addEventListener('click', function () { scriptGo(scriptStep() + 1); });
      input.addEventListener('focus', function () { showCaret(false); });
      input.addEventListener('input', function () { if (scriptTyped && input.value !== script[scriptRan]) showCaret(false); });

      if (stepFrags.length) {
        hookSteps = function () {
          if (!deck() || hookSteps.done) return;
          hookSteps.done = true;
          ['ready', 'slidechanged', 'fragmentshown', 'fragmenthidden'].forEach(function (ev) {
            root.Reveal.on(ev, followDeck);
          });
          followDeck();
        };
      } else {
        nextBtn.hidden = false;
      }
    }

    renderHints();
    var ready = doReset(true);
    if (hookSteps) {
      hookSteps();
      root.addEventListener('load', hookSteps);
    }
    self.refresh = function () { return ready.then(refresh); };
    self.note = function (text) { writeText(text); };

    return {
      sandbox: sb, refresh: refresh, run: submit, ready: ready, tasks: tasks, tree: tree,
      // the scripted commands: step(n) moves to step n (2k+1 types command
      // k, 2k+2 runs it) and resolves once it is there
      script: {
        commands: script,
        step: function (n) { return scriptMove(n); },
        position: function () { return scriptStep(); }
      }
    };
  }

  function boot() {
    var pending = root.__gsPending || [];
    pending.forEach(function (p) { mount(p[0], p[1]); });
    root.__gsPending = { push: function (p) { mount(p[0], p[1]); } };
  }

  // The graph helpers live with the `when:` language; they are offered here
  // too for hand-written `check:` functions.
  var W = root.GitSandboxWhen || {};
  root.GitSandboxUI = {
    mount: mount,
    boot: boot,
    branchOid: W.branchOid,
    reaches: W.reaches,
    isMerged: W.isMerged,
    commitCount: W.commitCount,
    hasMergeCommit: W.hasMergeCommit
  };

  // Mount the exercises the Quarto filter queued on the page (and any it
  // queues later). A page without the filter calls mount() itself.
  boot();
})(window);
