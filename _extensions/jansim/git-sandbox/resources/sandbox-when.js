/* ------------------------------------------------------------------
   The `when:` mini-language.

   Lesson authors describe what a learner must achieve as a condition on
   repository state rather than as JavaScript:

     when: repo
     when: commits >= 2
     when: commits on report >= 3
     when: branch report and on main
     when: detached
     when: merged report into main
     when: merge commit
     when: merging and not conflicts
     when: file report.qmd contains "Q3"
     when: ran /git\s+status/
     when: not clean

   compileWhen(src) returns a predicate (ctx) => boolean, or throws an Error
   with an author-facing message. Compilation happens once at mount time so
   mistakes surface immediately rather than on the learner's tenth command.
   ------------------------------------------------------------------ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GitSandboxWhen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEYWORDS = ['and', 'or', 'not'];

  /* ------------------------------ tokenizer ------------------------------ */

  function tokenize(src) {
    var tokens = [];
    var i = 0;
    var n = src.length;
    while (i < n) {
      var c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(' || c === ')') { tokens.push({ t: c, v: c, at: i }); i++; continue; }
      if (c === '"' || c === "'") {
        var q = c, buf = '', start = i;
        i++;
        while (i < n && src[i] !== q) {
          if (src[i] === '\\' && i + 1 < n) { buf += src[i + 1]; i += 2; }
          else { buf += src[i]; i++; }
        }
        if (i >= n) throw new Error('unterminated string starting at character ' + (start + 1));
        i++;
        tokens.push({ t: 'str', v: buf, at: start });
        continue;
      }
      if (c === '/') {
        var rstart = i, rbuf = '';
        i++;
        while (i < n && src[i] !== '/') {
          if (src[i] === '\\' && i + 1 < n) { rbuf += src[i] + src[i + 1]; i += 2; }
          else { rbuf += src[i]; i++; }
        }
        if (i >= n) throw new Error('unterminated /regex/ starting at character ' + (rstart + 1));
        i++;
        var flags = '';
        while (i < n && /[a-z]/.test(src[i])) { flags += src[i]; i++; }
        tokens.push({ t: 'regex', v: rbuf, flags: flags, at: rstart });
        continue;
      }
      var opMatch = /^(>=|<=|==|=|>|<)/.exec(src.slice(i));
      if (opMatch) { tokens.push({ t: 'op', v: opMatch[1], at: i }); i += opMatch[1].length; continue; }
      var wordMatch = /^[^\s()]+/.exec(src.slice(i));
      if (!wordMatch) throw new Error('unexpected character ' + JSON.stringify(c));
      var w = wordMatch[0];
      if (/^\d+$/.test(w)) tokens.push({ t: 'num', v: parseInt(w, 10), at: i });
      else if (KEYWORDS.indexOf(w) !== -1) tokens.push({ t: w, v: w, at: i });
      else tokens.push({ t: 'word', v: w, at: i });
      i += w.length;
    }
    return tokens;
  }

  /* ------------------------------ predicates ----------------------------- */

  // Graph helpers, shared with the UI (which re-exports them for `check:`
  // functions). `graph` is sandbox.graphModel().

  // oid a branch currently points at, or null
  function branchOid(graph, name) {
    var b = (graph.branches || []).filter(function (x) { return x.name === name; })[0];
    return b ? b.oid : null;
  }
  // every commit reachable from `from` by walking parents, as { oid: true }
  function ancestors(graph, from) {
    var byOid = {}, seen = {}, stack = from ? [from] : [];
    graph.commits.forEach(function (c) { byOid[c.oid] = c; });
    while (stack.length) {
      var oid = stack.pop();
      if (seen[oid]) continue;
      seen[oid] = true;
      if (byOid[oid]) stack.push.apply(stack, byOid[oid].parents || []);
    }
    return seen;
  }
  // is `target` reachable by walking parents back from `from`?
  function reaches(graph, from, target) {
    return !!from && !!target && !!ancestors(graph, from)[target];
  }
  // commits reachable from a branch tip, or all of them without a name
  function commitCount(graph, name) {
    if (!name) return graph.commits.length;
    return Object.keys(ancestors(graph, branchOid(graph, name))).length;
  }
  // Has branch `name` been merged into branch `into`? Ancestry alone would
  // be true the moment `name` is branched off `into`, so a real merge must
  // also have been recorded by the sandbox. The ancestry check still
  // matters: it goes false again if `into` is later rewound past the merge.
  // When either branch no longer exists (deleted after merging, or a
  // remote-tracking name), the record alone decides.
  function isMerged(graph, name, into) {
    var recorded = (graph.merges || []).some(function (m) { return m.from === name && m.into === into; });
    if (!recorded) return false;
    var fromOid = branchOid(graph, name), intoOid = branchOid(graph, into);
    return !fromOid || !intoOid || reaches(graph, intoOid, fromOid);
  }
  function hasMergeCommit(graph) {
    return graph.commits.some(function (c) { return (c.parents || []).length > 1; });
  }

  function compare(op, left, right) {
    switch (op) {
      case '>=': return left >= right;
      case '>': return left > right;
      case '<=': return left <= right;
      case '<': return left < right;
      case '==':
      case '=': return left === right;
    }
    return false;
  }

  /* -------------------------------- parser ------------------------------- */

  function parse(src) {
    var tokens = tokenize(src);
    var pos = 0;

    function peek(k) { return tokens[pos + (k || 0)]; }
    function next() { return tokens[pos++]; }
    function describe(tok) {
      if (!tok) return 'end of expression';
      return JSON.stringify(String(tok.v));
    }
    function expectWord(what) {
      var tok = peek();
      if (!tok || (tok.t !== 'word' && tok.t !== 'str' && tok.t !== 'num')) {
        throw new Error('expected ' + what + ' but found ' + describe(tok));
      }
      return String(next().v);
    }

    // `a or b or c` / `a and b and c`, left to right
    function chain(word, sub, join) {
      return function () {
        var left = sub();
        while (peek() && peek().t === word) {
          next();
          left = join(left, sub());
        }
        return left;
      };
    }
    var parseAnd = chain('and', parseNot, function (a, b) {
      return function (ctx) { return a(ctx) && b(ctx); };
    });
    var parseOr = chain('or', parseAnd, function (a, b) {
      return function (ctx) { return a(ctx) || b(ctx); };
    });

    function parseNot() {
      if (peek() && peek().t === 'not') {
        next();
        var inner = parseNot();
        return function (ctx) { return !inner(ctx); };
      }
      if (peek() && peek().t === '(') {
        next();
        var expr = parseOr();
        if (!peek() || peek().t !== ')') {
          throw new Error('missing closing parenthesis');
        }
        next();
        return expr;
      }
      return parsePredicate();
    }

    function parsePredicate() {
      var tok = peek();
      if (!tok) throw new Error('expression ended early; expected a condition');
      if (tok.t !== 'word') {
        throw new Error('expected a condition but found ' + describe(tok));
      }
      var word = String(next().v);

      switch (word) {
        case 'repo':
          return function (ctx) { return !!ctx.isRepo; };

        case 'clean':
          return function (ctx) {
            var s = ctx.status;
            return ctx.isRepo && s.staged.length === 0 && s.modified.length === 0 &&
                   s.untracked.length === 0 && s.deleted.length === 0 &&
                   s.stagedDeleted.length === 0 && !(s.conflicted || []).length;
          };

        // a merge stopped on conflicts and not yet committed or aborted
        case 'merging':
          return function (ctx) { return !!ctx.status.merging; };

        // ...with files whose conflicts are not yet marked resolved
        case 'conflicts':
          return function (ctx) { return (ctx.status.conflicted || []).length > 0; };

        case 'staged':
          return function (ctx) {
            return ctx.status.staged.length > 0 || ctx.status.stagedDeleted.length > 0;
          };

        case 'merge': {
          var m = peek();
          if (!m || String(m.v) !== 'commit') {
            throw new Error('expected "merge commit" but found "merge ' +
              (m ? String(m.v) : '') + '"');
          }
          next();
          return function (ctx) { return hasMergeCommit(ctx.graph); };
        }

        case 'commits': {
          var branch = null;
          if (peek() && peek().t === 'word' && String(peek().v) === 'on') {
            next();
            branch = expectWord('a branch name after "commits on"');
          }
          var op = '>=';
          if (peek() && peek().t === 'op') op = String(next().v);
          var numTok = peek();
          if (!numTok || numTok.t !== 'num') {
            throw new Error('expected a number after "commits' +
              (branch ? ' on ' + branch : '') + (op !== '>=' ? ' ' + op : '') +
              '" but found ' + describe(numTok));
          }
          next();
          var want = numTok.v;
          return function (ctx) { return compare(op, commitCount(ctx.graph, branch), want); };
        }

        case 'branch': {
          var bname = expectWord('a branch name after "branch"');
          return function (ctx) {
            return (ctx.graph.branches || []).some(function (b) { return b.name === bname; });
          };
        }

        case 'on': {
          var onName = expectWord('a branch name after "on"');
          return function (ctx) { return ctx.graph.head === onName; };
        }

        // HEAD points at a commit rather than a branch (`git checkout <commit>`)
        case 'detached':
          return function (ctx) { return !!ctx.graph.detached; };

        case 'merged': {
          var from = expectWord('a branch name after "merged"');
          var into = peek();
          if (!into || String(into.v) !== 'into') {
            throw new Error('expected "merged ' + from + ' into <branch>" but found ' +
              describe(into) + ' after the branch name');
          }
          next();
          var target = expectWord('a branch name after "into"');
          return function (ctx) { return isMerged(ctx.graph, from, target); };
        }

        case 'file': {
          var fname = expectWord('a filename after "file"');
          if (peek() && peek().t === 'word' && String(peek().v) === 'contains') {
            next();
            var needleTok = peek();
            if (!needleTok || (needleTok.t !== 'str' && needleTok.t !== 'word' && needleTok.t !== 'regex')) {
              throw new Error('expected text or /regex/ after "contains" but found ' + describe(needleTok));
            }
            next();
            if (needleTok.t === 'regex') {
              var fre = new RegExp(needleTok.v, needleTok.flags || '');
              return function (ctx) { return fre.test(ctx._fileText(fname)); };
            }
            var needle = String(needleTok.v);
            return function (ctx) { return ctx._fileText(fname).indexOf(needle) !== -1; };
          }
          return function (ctx) { return ctx.files.indexOf(fname) !== -1; };
        }

        case 'remote':
          return function (ctx) { return !!ctx.remote; };

        // true once the current branch's latest commit is on the remote
        case 'pushed':
          return function (ctx) {
            return !!(ctx.remote && ctx.remote.tracked && ctx.remote.ahead === 0);
          };

        case 'ran': {
          var rTok = peek();
          if (!rTok || (rTok.t !== 'regex' && rTok.t !== 'str' && rTok.t !== 'word')) {
            throw new Error('expected /regex/ or "text" after "ran" but found ' + describe(rTok));
          }
          next();
          if (rTok.t === 'regex') {
            var re = new RegExp(rTok.v, rTok.flags || '');
            return function (ctx) { return (ctx.history || []).some(function (h) { return re.test(h); }); };
          }
          var text = String(rTok.v);
          return function (ctx) {
            return (ctx.history || []).some(function (h) { return h.indexOf(text) !== -1; });
          };
        }

        default:
          throw new Error('unknown condition "' + word + '". Available: repo, clean, staged, ' +
            'commits, commits on <branch>, branch <name>, on <branch>, detached, merged <a> into <b>, ' +
            'merge commit, merging, conflicts, file <name> [contains "text"], ran /regex/, remote, pushed');
      }
    }

    var fn = parseOr();
    if (pos < tokens.length) {
      throw new Error('unexpected ' + describe(peek()) + ' after a complete condition');
    }
    return fn;
  }

  /* -------------------------------- public ------------------------------- */

  function compileWhen(src) {
    if (typeof src !== 'string' || src.trim() === '') {
      throw new Error('`when:` is empty');
    }
    // `file ... contains` needs file contents, which are async; the UI
    // reads them before evaluating (see filesNeeded) into ctx._fileText.
    try {
      return parse(src);
    } catch (e) {
      throw new Error('cannot read `when: ' + src + '` — ' + e.message);
    }
  }

  // Which filenames does this expression need the contents of? The UI reads
  // them before evaluating so predicates can stay synchronous.
  function filesNeeded(src) {
    var out = [];
    try {
      var tokens = tokenize(src);
      for (var i = 0; i < tokens.length - 2; i++) {
        if (tokens[i].t === 'word' && String(tokens[i].v) === 'file' &&
            tokens[i + 2] && tokens[i + 2].t === 'word' && String(tokens[i + 2].v) === 'contains') {
          out.push(String(tokens[i + 1].v));
        }
      }
    } catch (e) { /* compileWhen will report it */ }
    return out;
  }

  function compileJs(src) {
    var body = /(^|[\s;{])return[\s(]/.test(src) ? src : 'return (' + src + ');';
    try {
      /* eslint-disable no-new-func */
      return new Function('c', body);
    } catch (e) {
      throw new Error('cannot compile `js:` block — ' + e.message);
    }
  }

  return {
    compileWhen: compileWhen, compileJs: compileJs, filesNeeded: filesNeeded, tokenize: tokenize,
    branchOid: branchOid, reaches: reaches, commitCount: commitCount, isMerged: isMerged,
    hasMergeCommit: hasMergeCommit
  };
});
