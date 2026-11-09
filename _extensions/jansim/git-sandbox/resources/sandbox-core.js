/* ------------------------------------------------------------------
   git sandbox core: in-memory fs + shell/git command engine + graph model
   No DOM. Works in Node (for tests) and in the browser.
   Requires a global `git` (isomorphic-git UMD).
   ------------------------------------------------------------------ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GitSandboxCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------- memory fs ---------------------------- */

  function createMemFS() {
    var store = new Map();
    var enc = new TextEncoder();
    var dec = new TextDecoder();
    var inode = 1;

    function norm(p) {
      p = String(p).replace(/\\/g, '/');
      if (p.charAt(0) !== '/') p = '/' + p;
      var parts = [];
      p.split('/').forEach(function (seg) {
        if (seg === '' || seg === '.') return;
        if (seg === '..') { parts.pop(); return; }
        parts.push(seg);
      });
      return '/' + parts.join('/');
    }
    function dirname(p) {
      p = norm(p);
      if (p === '/') return '/';
      var i = p.lastIndexOf('/');
      return i <= 0 ? '/' : p.slice(0, i);
    }
    function basename(p) {
      p = norm(p);
      return p.slice(p.lastIndexOf('/') + 1);
    }
    function mkErr(code, path) {
      var msgs = {
        ENOENT: 'no such file or directory',
        EEXIST: 'file already exists',
        ENOTDIR: 'not a directory',
        EISDIR: 'illegal operation on a directory',
        ENOTEMPTY: 'directory not empty',
        EINVAL: 'invalid argument'
      };
      var e = new Error(code + ': ' + (msgs[code] || code) + ", '" + path + "'");
      e.code = code;
      e.path = path;
      e.errno = -1;
      return e;
    }
    function statObj(node) {
      var isDir = node.type === 'dir';
      var isLink = node.type === 'symlink';
      return {
        type: node.type,
        mode: node.mode,
        size: isDir ? 0 : (node.content ? node.content.length : 0),
        ino: node.ino,
        mtimeMs: node.mtimeMs,
        ctimeMs: node.mtimeMs,
        uid: 1, gid: 1, dev: 1,
        isFile: function () { return node.type === 'file'; },
        isDirectory: function () { return isDir; },
        isSymbolicLink: function () { return isLink; }
      };
    }
    function get(p) { return store.get(norm(p)); }
    function requireParentDir(p) {
      var d = dirname(p);
      var pn = store.get(d);
      if (!pn) throw mkErr('ENOENT', p);
      if (pn.type !== 'dir') throw mkErr('ENOTDIR', p);
    }

    store.set('/', { type: 'dir', mode: 16877, mtimeMs: Date.now(), ino: inode++ });

    var promises = {
      readFile: function (p, opts) {
        return Promise.resolve().then(function () {
          var n = get(p);
          if (!n) throw mkErr('ENOENT', p);
          if (n.type === 'dir') throw mkErr('EISDIR', p);
          var encoding = typeof opts === 'string' ? opts : (opts && opts.encoding);
          return encoding ? dec.decode(n.content) : n.content.slice();
        });
      },
      writeFile: function (p, data, opts) {
        return Promise.resolve().then(function () {
          requireParentDir(p);
          var bytes = typeof data === 'string' ? enc.encode(data)
            : (data instanceof Uint8Array ? new Uint8Array(data) : enc.encode(String(data)));
          var mode = (opts && typeof opts === 'object' && opts.mode) || 33188;
          var existing = get(p);
          store.set(norm(p), {
            type: 'file', content: bytes, mode: existing ? existing.mode : mode,
            mtimeMs: Date.now(), ino: existing ? existing.ino : inode++
          });
        });
      },
      unlink: function (p) {
        return Promise.resolve().then(function () {
          var n = get(p);
          if (!n) throw mkErr('ENOENT', p);
          if (n.type === 'dir') throw mkErr('EISDIR', p);
          store.delete(norm(p));
        });
      },
      readdir: function (p) {
        return Promise.resolve().then(function () {
          var d = norm(p);
          var n = store.get(d);
          if (!n) throw mkErr('ENOENT', p);
          if (n.type !== 'dir') throw mkErr('ENOTDIR', p);
          var prefix = d === '/' ? '/' : d + '/';
          var out = [];
          store.forEach(function (_v, k) {
            if (k === d || k.indexOf(prefix) !== 0) return;
            var rest = k.slice(prefix.length);
            if (rest.indexOf('/') === -1 && rest !== '') out.push(rest);
          });
          return out.sort();
        });
      },
      mkdir: function (p, opts) {
        return Promise.resolve().then(function () {
          var d = norm(p);
          if (store.has(d)) {
            if (opts && opts.recursive) return;
            throw mkErr('EEXIST', p);
          }
          if (opts && opts.recursive) {
            var parts = d.split('/').filter(Boolean);
            var cur = '';
            parts.forEach(function (seg) {
              cur += '/' + seg;
              if (!store.has(cur)) store.set(cur, { type: 'dir', mode: 16877, mtimeMs: Date.now(), ino: inode++ });
            });
            return;
          }
          requireParentDir(d);
          store.set(d, { type: 'dir', mode: 16877, mtimeMs: Date.now(), ino: inode++ });
        });
      },
      rmdir: function (p) {
        return Promise.resolve().then(function () {
          var d = norm(p);
          var n = store.get(d);
          if (!n) throw mkErr('ENOENT', p);
          if (n.type !== 'dir') throw mkErr('ENOTDIR', p);
          var prefix = d === '/' ? '/' : d + '/';
          var empty = true;
          store.forEach(function (_v, k) { if (k !== d && k.indexOf(prefix) === 0) empty = false; });
          if (!empty) throw mkErr('ENOTEMPTY', p);
          store.delete(d);
        });
      },
      stat: function (p) {
        return Promise.resolve().then(function () {
          var n = get(p);
          if (!n) throw mkErr('ENOENT', p);
          return statObj(n);
        });
      },
      lstat: function (p) { return promises.stat(p); },
      readlink: function (p) {
        return Promise.resolve().then(function () {
          var n = get(p);
          if (!n || n.type !== 'symlink') throw mkErr('EINVAL', p);
          return n.target;
        });
      },
      symlink: function (target, p) {
        return Promise.resolve().then(function () {
          requireParentDir(p);
          store.set(norm(p), { type: 'symlink', target: target, mode: 41453, mtimeMs: Date.now(), ino: inode++ });
        });
      },
      chmod: function (p, mode) {
        return Promise.resolve().then(function () {
          var n = get(p);
          if (!n) throw mkErr('ENOENT', p);
          n.mode = mode;
        });
      },
      rm: function (p, opts) {
        return Promise.resolve().then(function () {
          var d = norm(p);
          var n = store.get(d);
          if (!n) {
            if (opts && opts.force) return;
            throw mkErr('ENOENT', p);
          }
          if (n.type === 'dir' && opts && opts.recursive) {
            var prefix = d === '/' ? '/' : d + '/';
            var kill = [];
            store.forEach(function (_v, k) { if (k === d || k.indexOf(prefix) === 0) kill.push(k); });
            kill.forEach(function (k) { store.delete(k); });
            return;
          }
          if (n.type === 'dir') throw mkErr('EISDIR', p);
          store.delete(d);
        });
      }
    };

    return {
      promises: promises,
      _store: store,
      _norm: norm,
      _dirname: dirname,
      _basename: basename
    };
  }

  /* --------------------------- tokenizing --------------------------- */

  // Split a command line into words, honouring single/double quotes, and
  // pull out redirection operators (> and >>). Each word is { text, glob }:
  // glob is true when it holds an unquoted *, ? or [, which the shell
  // expands into matching file names, as bash does.
  function tokenizeWords(line) {
    var words = [];
    var cur = '';
    var has = false;
    var glob = false;
    var quote = null;
    function push() { words.push({ text: cur, glob: glob }); cur = ''; has = false; glob = false; }
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (quote) {
        if (ch === quote) { quote = null; }
        else if (ch === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; has = true; }
        else { cur += ch; has = true; }
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
      if (ch === ' ' || ch === '\t') {
        if (has) push();
        continue;
      }
      if (ch === '>' ) {
        if (has) push();
        if (line[i + 1] === '>') { words.push({ text: '>>', glob: false }); i++; } else { words.push({ text: '>', glob: false }); }
        continue;
      }
      if (ch === '*' || ch === '?' || ch === '[') glob = true;
      cur += ch; has = true;
    }
    if (has) push();
    if (quote) throw new Error('unmatched quote');
    return words;
  }

  function tokenize(line) {
    return tokenizeWords(line).map(function (w) { return w.text; });
  }

  function hasGlob(s) { return /[*?[]/.test(s); }

  // A glob as a regular expression. In the shell (`pathSep` true) * and ?
  // stop at a slash; in a git pathspec they do not, so `git add '*.txt'`
  // also stages notes/b.txt, as real git does.
  function globRegex(pattern, pathSep) {
    var any = pathSep ? '[^/]' : '.';
    var re = '';
    for (var i = 0; i < pattern.length; i++) {
      var ch = pattern[i];
      if (ch === '*') re += any + '*';
      else if (ch === '?') re += any;
      else if (ch === '[') {
        var end = pattern.indexOf(']', i + 2);
        if (end === -1) { re += '\\['; continue; }
        var set = pattern.slice(i + 1, end);
        if (set.charAt(0) === '!') set = '^' + set.slice(1);
        re += '[' + set.replace(/\\/g, '\\\\') + ']';
        i = end;
      } else re += ch.replace(/[.+^${}()|\\\]]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
  }

  function splitRedirect(tokens) {
    var out = { args: [], redirect: null, target: null };
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i] === '>' || tokens[i] === '>>') {
        out.redirect = tokens[i];
        out.target = tokens[i + 1] || null;
        i++;
        continue;
      }
      out.args.push(tokens[i]);
    }
    return out;
  }

  /* ------------------------------ -h help ---------------------------- */

  // What `git <command> -h` prints. The usage lines are git's own (as of
  // git 2.55; tests/test-realgit.js checks them against the git it finds); the
  // options are only those this sandbox understands, laid out the way
  // git lays out its option lists, so what a learner copies into their
  // notes is both real and something they can try here.
  function opt(flags, desc) {
    var pad = '    ' + flags;
    return pad.length < 26 ? pad + new Array(27 - pad.length).join(' ') + desc
      : pad + '\n' + new Array(27).join(' ') + desc;
  }

  var HELP = {
    init: ['usage: git init [-q | --quiet] [--bare] [--template=<template-directory>]',
      '                [--separate-git-dir <git-dir>] [--object-format=<format>]',
      '                [--ref-format=<format>]',
      '                [-b <branch-name> | --initial-branch=<branch-name>]',
      '                [--shared[=<permissions>]] [<directory>]', '',
      opt('-b, --initial-branch <name>', 'override the name of the initial branch')],
    status: ['usage: git status [<options>] [--] [<pathspec>...]', '',
      opt('--ignored', 'show ignored files')],
    add: ['usage: git add [<options>] [--] <pathspec>...', '',
      opt('-f, --force', 'allow adding otherwise ignored files'),
      opt('-A, --all', 'add changes from all tracked and untracked files')],
    commit: ['usage: git commit [-a | --interactive | --patch] [-s] [-v] [-u[<mode>]] [--amend]',
      '                  [--dry-run] [(-c | -C | --squash) <commit> | --fixup [(amend|reword):]<commit>]',
      '                  [-F <file> | -m <msg>] [--reset-author] [--allow-empty]',
      '                  [--allow-empty-message] [--no-verify] [-e] [--author=<author>]',
      '                  [--date=<date>] [--cleanup=<mode>] [--[no-]status]',
      '                  [-i | -o] [--pathspec-from-file=<file> [--pathspec-file-nul]]',
      '                  [(--trailer <token>[(=|:)<value>])...] [-S[<keyid>]]',
      '                  [--] [<pathspec>...]', '',
      'Commit message options',
      opt('-m, --message <message>', 'commit message'), '',
      'Commit contents options',
      opt('-a, --all', 'commit all changed files')],
    rm: ['usage: git rm [-f | --force] [-n] [-r] [--cached] [--ignore-unmatch]',
      '              [--quiet] [--pathspec-from-file=<file> [--pathspec-file-nul]]',
      '              [--] [<pathspec>...]', '',
      opt('--cached', 'only remove from the index'),
      opt('-r', 'allow recursive removal')],
    restore: ['usage: git restore [<options>] [--source=<branch>] <file>...', '',
      opt('-s, --source <tree-ish>', 'which tree-ish to checkout from'),
      opt('-S, --staged', 'restore the index'),
      opt('-W, --worktree', 'restore the working tree (default)')],
    reset: ['usage: git reset [--mixed | --soft | --hard | --merge | --keep] [-q] [<commit>]',
      '   or: git reset [-q] [<tree-ish>] [--] <pathspec>...',
      '   or: git reset [-q] [--pathspec-from-file [--pathspec-file-nul]] [<tree-ish>]',
      '   or: git reset --patch [<tree-ish>] [--] [<pathspec>...]', '',
      opt('--mixed', 'reset HEAD and index'),
      opt('--soft', 'reset only HEAD'),
      opt('--hard', 'reset HEAD, index and working tree')],
    log: ['usage: git log [<options>] [<revision-range>] [[--] <path>...]',
      '   or: git show [<options>] <object>...', '',
      opt('--oneline', 'show each commit on a single line')],
    diff: ['usage: git diff [<options>] [<commit>] [--] [<path>...]',
      '   or: git diff [<options>] --cached [--merge-base] [<commit>] [--] [<path>...]',
      '   or: git diff [<options>] [--merge-base] <commit> [<commit>...] <commit> [--] [<path>...]',
      '   or: git diff [<options>] <commit>...<commit> [--] [<path>...]',
      '   or: git diff [<options>] <blob> <blob>',
      '   or: git diff [<options>] --no-index [--] <path> <path> [<pathspec>...]'],
    branch: ['usage: git branch [<options>] [-r | -a] [--merged] [--no-merged]',
      '   or: git branch [<options>] [-f] [--recurse-submodules] <branch-name> [<start-point>]',
      '   or: git branch [<options>] [-l] [<pattern>...]',
      '   or: git branch [<options>] [-r] (-d | -D) <branch-name>...',
      '   or: git branch [<options>] (-m | -M) [<old-branch>] <new-branch>',
      '   or: git branch [<options>] (-c | -C) [<old-branch>] <new-branch>',
      '   or: git branch [<options>] [-r | -a] [--points-at]',
      '   or: git branch [<options>] [-r | -a] [--format]', '',
      opt('-d, --delete', 'delete fully merged branch'),
      opt('-D', 'delete branch (even if not merged)')],
    checkout: ['usage: git checkout [<options>] <branch>',
      '   or: git checkout [<options>] [<branch>] -- <file>...', '',
      opt('-b <branch>', 'create and checkout a new branch'),
      opt('--detach', 'detach HEAD at named commit')],
    switch: ['usage: git switch [<options>] [<branch>]', '',
      opt('-c, --create <branch>', 'create and switch to a new branch'),
      opt('-d, --detach', 'detach HEAD at named commit')],
    merge: ['usage: git merge [<options>] [<commit>...]',
      '   or: git merge --abort',
      '   or: git merge --continue', '',
      opt('--abort', 'abort the current in-progress merge'),
      opt('--continue', 'continue the current in-progress merge')],
    remote: ['usage: git remote [-v | --verbose]',
      '   or: git remote add [-t <branch>] [-m <master>] [-f] [--tags | --no-tags] [--mirror=<fetch|push>] <name> <url>',
      '   or: git remote rename [--[no-]progress] <old> <new>',
      '   or: git remote remove <name>',
      '   or: git remote set-head <name> (-a | --auto | -d | --delete | <branch>)',
      '   or: git remote [-v | --verbose] show [-n] <name>',
      '   or: git remote prune [-n | --dry-run] <name>',
      '   or: git remote [-v | --verbose] update [-p | --prune] [(<group> | <remote>)...]',
      '   or: git remote set-branches [--add] <name> <branch>...',
      '   or: git remote get-url [--push] [--all] <name>',
      '   or: git remote set-url [--push] <name> <newurl> [<oldurl>]',
      '   or: git remote set-url --add <name> <newurl>',
      '   or: git remote set-url --delete <name> <url>', '',
      opt('-v, --verbose', 'be verbose; must be placed before a subcommand')],
    push: ['usage: git push [<options>] [<repository> [<refspec>...]]', '',
      opt('-u, --set-upstream', 'set upstream for git pull/status')],
    pull: ['usage: git pull [<options>] [<repository> [<refspec>...]]'],
    fetch: ['usage: git fetch [<options>] [<repository> [<refspec>...]]',
      '   or: git fetch [<options>] <group>',
      '   or: git fetch --multiple [<options>] [(<repository>|<group>)...]',
      '   or: git fetch --all [<options>]'],
    clone: ['usage: git clone [<options>] [--] <repo> [<dir>]'],
    config: ['usage: git config list [<file-option>] [<display-option>] [--includes]',
      '   or: git config get [<file-option>] [<display-option>] [--includes] [--all] [--regexp] [--value=<pattern>] [--fixed-value] [--default=<default>] [--url=<url>] <name>',
      '   or: git config set [<file-option>] [--type=<type>] [--all] [--value=<pattern>] [--fixed-value] <name> <value>',
      '   or: git config unset [<file-option>] [--all] [--value=<pattern>] [--fixed-value] <name>',
      '   or: git config rename-section [<file-option>] <old-name> <new-name>',
      '   or: git config remove-section [<file-option>] <name>',
      '   or: git config edit [<file-option>]',
      '   or: git config [<file-option>] --get-colorbool <name> [<stdout-is-tty>]', '',
      'Config file location',
      opt('--global', 'use global config file'),
      opt('--local', 'use repository config file')],
    stash: ['usage: git stash list [<log-options>]',
      '   or: git stash show [-u | --include-untracked | --only-untracked] [<diff-options>] [<stash>]',
      '   or: git stash drop [-q | --quiet] [<stash>]',
      '   or: git stash pop [--index] [-q | --quiet] [<stash>]',
      '   or: git stash apply [--index] [-q | --quiet] [--label-ours=<label>] [--label-theirs=<label>] [--label-base=<label>] [<stash>]',
      '   or: git stash branch <branchname> [<stash>]',
      '   or: git stash [push] [-p | --patch] [-S | --staged] [-k | --[no-]keep-index] [-q | --quiet]',
      '                 [-u | --include-untracked] [-a | --all] [(-m | --message) <message>]',
      '                 [--pathspec-from-file=<file> [--pathspec-file-nul]]',
      '                 [--] [<pathspec>...]',
      '   or: git stash save [-p | --patch] [-S | --staged] [-k | --[no-]keep-index] [-q | --quiet]',
      '                 [-u | --include-untracked] [-a | --all] [<message>]',
      '   or: git stash clear',
      '   or: git stash create [<message>]',
      '   or: git stash store [(-m | --message) <message>] [-q | --quiet] <commit>',
      '   or: git stash export (--print | --to-ref <ref>) [<stash>...]',
      '   or: git stash import <commit>'],
    'check-ignore': ['usage: git check-ignore [<options>] <pathname>...',
      '   or: git check-ignore [<options>] --stdin']
  };

  /* ------------------------------ engine ---------------------------- */

  function createSandbox(options) {
    options = options || {};
    var gitlib = options.git || (typeof self !== 'undefined' ? self.git : null);
    if (!gitlib) throw new Error('isomorphic-git not found');

    var fs = createMemFS();
    var dir = options.dir || '/project';
    // Path shown to the user in messages and pwd; the real in-memory fs
    // stays rooted at `dir` regardless of what the prompt displays.
    var displayDir = options.displayDir || '~' + dir;
    // Mock remote: a bare repository elsewhere in the same in-memory fs,
    // created by `git remote add origin <url>`. Push/pull/fetch move objects
    // and refs between it and the local repo — nothing leaves the page.
    var remoteGitdir = '/origin';
    // The mock remote's URL once it exists, "on GitHub". Whether the local
    // repository knows it is a separate matter, kept where git keeps it:
    // remote.origin.url in .git/config (see originUrl). The two differ
    // before a clone, or after the learner deletes .git.
    var remoteUrl = null;
    // where HEAD was before the last checkout or switch (a branch name or
    // a commit), for `git switch -`
    var prevHead = null;
    // Merges that actually moved a ref ({ from, into }), via `git merge` or
    // `git pull`. The graph alone cannot distinguish "freshly branched off Y"
    // from "fast-forward merged into Y" — both leave X's tip an ancestor of
    // Y's — so `merged X into Y` conditions need this record.
    var mergesDone = [];
    var author = { name: 'Your Name', email: 'you@example.com' };
    // `git config --global` settings other than user.*, keyed in lower
    // case. The sandbox has no home folder, so they live here; the only
    // one that changes anything is init.defaultBranch.
    var globalConfig = {};
    var defaultBranch = options.defaultBranch || 'main';
    var repoReady = false;
    // Shell working directory, always `dir` or a folder inside it. The
    // repository itself stays at `dir`; only relative paths follow `cd`.
    var cwd = dir;
    var prevCwd = dir;

    // isomorphic-git options for the local repository, or with ropts the
    // mock remote's bare one
    function withFs(o, extra) {
      for (var k in extra) o[k] = extra[k];
      return o;
    }
    function opts(extra) { return withFs({ fs: fs, dir: dir }, extra); }
    function ropts(extra) { return withFs({ fs: fs, gitdir: remoteGitdir }, extra); }

    function abs(p) {
      if (!p) return cwd;
      return p.charAt(0) === '/' ? fs._norm(p) : fs._norm(cwd + '/' + p);
    }
    // like abs(), but relative paths start at the project's top, not cwd
    function fromRoot(p) {
      if (!p) return dir;
      return p.charAt(0) === '/' ? fs._norm(p) : fs._norm(dir + '/' + p);
    }
    function rel(p) {
      var a = abs(p);
      return a.indexOf(dir + '/') === 0 ? a.slice(dir.length + 1) : a.replace(/^\//, '');
    }

    // What the shell makes of an unquoted glob: the matching paths, sorted,
    // spelled as the learner typed the pattern, or null when nothing
    // matches (bash then passes the pattern on unchanged). Dot files only
    // match a pattern segment that starts with a dot.
    async function expandGlob(pattern) {
      var absolute = pattern.charAt(0) === '/';
      var found = [{ at: absolute ? '' : cwd, shown: absolute ? '' : null }];
      var segs = pattern.split('/');
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        var last = i === segs.length - 1;
        if (seg === '' && (i === 0 || last)) continue;
        var next = [];
        for (var f = 0; f < found.length; f++) {
          var here = found[f];
          var join = function (name) {
            return { at: here.at + '/' + name, shown: here.shown === null ? name : here.shown + '/' + name };
          };
          if (!hasGlob(seg)) { next.push(join(seg)); continue; }
          var names;
          try { names = await fs.promises.readdir(here.at || '/'); } catch (e) { continue; }
          var re = globRegex(seg, true);
          names.forEach(function (n) {
            if (n.charAt(0) === '.' && seg.charAt(0) !== '.') return;
            if (re.test(n)) next.push(join(n));
          });
        }
        found = next;
      }
      var out = [];
      for (var k = 0; k < found.length; k++) {
        try { await fs.promises.stat(found[k].at); } catch (e) { continue; }
        out.push(found[k].shown === null ? '.' : (absolute ? '/' : '') + found[k].shown);
      }
      return out.length ? out.sort() : null;
    }

    // A git pathspec as a test on repository paths (relative to the top,
    // like statusMatrix reports them). Relative specs start at cwd, so
    // `git add .` in a subfolder means that folder. A plain spec matches
    // the path itself or anything below it; one with *, ? or [ is a glob
    // over the whole path. Null if the spec points outside the project.
    function pathspec(spec) {
      var full = abs(spec);
      if (!insideProject(full)) return null;
      var base = full === dir ? '' : full.slice(dir.length + 1);
      if (hasGlob(base)) {
        var re = globRegex(base, false);
        return function (p) { return re.test(p); };
      }
      return function (p) { return !base || p === base || p.indexOf(base + '/') === 0; };
    }

    async function ensureWorkdir() {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    // cwd as the learner sees it, e.g. ~/project/src
    function displayCwd() {
      return cwd === dir ? displayDir : displayDir + cwd.slice(dir.length);
    }

    function insideProject(p) {
      return p === dir || p.indexOf(dir + '/') === 0;
    }

    // A checkout or reset can delete the folder the learner is standing in.
    // A real shell would leave them in a ghost directory; here we step back
    // to the project root so every later command still works.
    async function ensureCwd() {
      if (cwd === dir) return;
      try {
        if ((await fs.promises.stat(cwd)).isDirectory()) return;
      } catch (e) {}
      cwd = dir;
    }

    async function isRepo() {
      try { await fs.promises.stat(dir + '/.git'); return true; }
      catch (e) { return false; }
    }

    // the commit a ref names, or null (no such ref, or no commit yet)
    async function refOid(ref) {
      try { return await gitlib.resolveRef(opts({ ref: ref })); } catch (e) { return null; }
    }

    async function currentBranch() {
      try { return (await gitlib.currentBranch(opts({ fullname: false }))) || null; }
      catch (e) { return null; }
    }

    // Where HEAD was detached, so `git status` can say "detached at" until
    // a commit moves HEAD on, and "detached from" after, as real git does.
    var detachPoint = null;

    // The first line of `git status`: "On branch main", or the detached form.
    async function headLine() {
      var br = await currentBranch();
      if (br) return 'On branch ' + br;
      var oid = await refOid('HEAD');
      if (!oid) return 'On branch ' + defaultBranch;
      if (!detachPoint) detachPoint = oid;
      return 'HEAD detached ' + (oid === detachPoint ? 'at ' : 'from ') + detachPoint.slice(0, 7);
    }

    // A commit named the ways a learner is likely to type it: a full or
    // abbreviated hash, HEAD, a branch, or any of those followed by ~n or ^.
    // Returns the full oid, or null if nothing matches.
    async function resolveCommit(spec) {
      var m = /^(.+?)((?:[~^]\d*)*)$/.exec(spec);
      if (!m) return null;
      var oid = await refOid(m[1]);
      if (!oid && /^[0-9a-f]{4,40}$/i.test(m[1])) {
        try { oid = await gitlib.expandOid(opts({ oid: m[1].toLowerCase() })); } catch (e) {}
      }
      if (!oid) return null;
      try { if ((await gitlib.readObject(opts({ oid: oid }))).type !== 'commit') return null; }
      catch (e) { return null; }
      var steps = m[2].match(/[~^]\d*/g) || [];
      for (var i = 0; i < steps.length; i++) {
        var n = steps[i].length > 1 ? parseInt(steps[i].slice(1), 10) : 1;
        // ~n walks n first parents; ^n picks the nth parent
        var walk = steps[i].charAt(0) === '~' ? n : (n ? 1 : 0);
        var pick = steps[i].charAt(0) === '^' ? n - 1 : 0;
        for (var w = 0; w < walk; w++) {
          var ps = (await gitlib.readCommit(opts({ oid: oid }))).commit.parent || [];
          oid = ps[w === walk - 1 ? pick : 0];
          if (!oid) return null;
        }
      }
      return oid;
    }

    // Files with uncommitted changes that moving HEAD to `oid` would
    // replace, because the two commits hold different versions of them.
    // isomorphic-git's checkout overwrites these without a word; git refuses.
    async function overwrittenBy(oid, st) {
      var headOid = await refOid('HEAD');
      if (!headOid) return [];
      var changed = st.staged.map(function (x) { return x.file; })
        .concat(st.modified, st.deleted, st.stagedDeleted);
      async function blobAt(commit, f) {
        try { return (await gitlib.readBlob(opts({ oid: commit, filepath: f }))).oid; }
        catch (e) { return null; }
      }
      var out = [];
      for (var i = 0; i < changed.length; i++) {
        if (out.indexOf(changed[i]) !== -1) continue;
        if ((await blobAt(headOid, changed[i])) !== (await blobAt(oid, changed[i]))) out.push(changed[i]);
      }
      return out.sort();
    }

    async function subjectOf(oid) {
      return ((await gitlib.readCommit(opts({ oid: oid }))).commit.message || '').split('\n')[0];
    }

    // Commits reachable from `oid` but from no branch: what leaving a
    // detached HEAD would abandon. Newest first.
    async function orphanedFrom(oid) {
      var kept = {};
      var names = await gitlib.listBranches(opts());
      for (var i = 0; i < names.length; i++) {
        var r = await reachableFrom(await refOid(names[i]), opts);
        for (var k in r) kept[k] = true;
      }
      var out = [];
      var o = oid;
      while (o && !kept[o]) {
        var c = await gitlib.readCommit(opts({ oid: o }));
        out.push({ oid: o, message: (c.commit.message || '').split('\n')[0] });
        o = (c.commit.parent || [])[0];
      }
      return out;
    }

    // What git prints when HEAD leaves a detached commit: either where it
    // was, or a warning naming the commits nothing points at any more.
    async function leavingDetached(oldOid) {
      var lost = await orphanedFrom(oldOid);
      if (!lost.length) return 'Previous HEAD position was ' + oldOid.slice(0, 7) + ' ' + await subjectOf(oldOid) + '\n';
      var n = lost.length;
      return '{y}Warning: you are leaving ' + n + ' commit' + (n === 1 ? '' : 's') + ' behind, not connected to\n' +
        'any of your branches:{/}\n\n' +
        lost.slice(0, 5).map(function (c) { return '  ' + c.oid.slice(0, 7) + ' ' + c.message; }).join('\n') +
        (n > 5 ? '\n ... and ' + (n - 5) + ' more.' : '') + '\n\n' +
        'If you want to keep ' + (n === 1 ? 'it' : 'them') + ' by creating a new branch, this may be a good time\n' +
        'to do so with:\n\n' +
        ' git branch <new-branch-name> ' + oldOid.slice(0, 7) + '\n\n';
    }

    // Working files (not .git) as path -> bytes; their names are what the
    // learner sees with `ls -a`, and comparing the bytes tells afterwards
    // which ones a merge touched.
    function workdirBytes() {
      var out = {};
      var prefix = dir + '/';
      fs._store.forEach(function (v, k) {
        if (k.indexOf(prefix) !== 0 || k.indexOf(dir + '/.git/') === 0 || v.type !== 'file') return;
        out[k.slice(prefix.length)] = v.content;
      });
      return out;
    }

    // tracked and untracked working files, .gitignore and ignored ones too
    async function listFiles() { return Object.keys(workdirBytes()).sort(); }

    // Every file and folder under the workdir, .git included, as
    // [{ path, type: 'file' | 'dir' }] relative to it. The editor's file
    // browser needs folders (empty ones too) and git's own files, which
    // listFiles leaves out on purpose.
    async function listTree() {
      var out = [];
      var prefix = dir + '/';
      fs._store.forEach(function (v, k) {
        if (k.indexOf(prefix) !== 0) return;
        out.push({ path: k.slice(prefix.length), type: v.type === 'dir' ? 'dir' : 'file' });
      });
      return out.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
    }

    /* ------------------------------ remote -------------------------- */

    async function remoteBranchOid(name) {
      try { return (await fs.promises.readFile(remoteGitdir + '/refs/heads/' + name, 'utf8')).trim(); }
      catch (e) { return null; }
    }

    // the branch the remote's HEAD names, or null
    async function remoteDefault() {
      try { return (await fs.promises.readFile(remoteGitdir + '/HEAD', 'utf8')).replace(/^ref: refs\/heads\//, '').trim(); }
      catch (e) { return null; }
    }

    async function listRemoteBranchNames() {
      try { return (await fs.promises.readdir(remoteGitdir + '/refs/heads')).sort(); }
      catch (e) { return []; }
    }

    // Copy every git object file present under `from` but missing under `to`.
    // Both repos live in the same in-memory fs, so a push/fetch "transfer"
    // is a plain file copy.
    async function copyObjects(fromGitdir, toGitdir) {
      var prefix = fromGitdir + '/objects/';
      var paths = [];
      fs._store.forEach(function (v, k) {
        if (v.type === 'file' && k.indexOf(prefix) === 0) paths.push(k);
      });
      for (var i = 0; i < paths.length; i++) {
        var dest = toGitdir + paths[i].slice(fromGitdir.length);
        try { await fs.promises.stat(dest); continue; } catch (e) { /* missing: copy */ }
        await fs.promises.mkdir(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
        await fs.promises.writeFile(dest, await fs.promises.readFile(paths[i]));
      }
    }

    // set of commit oids reachable from `oid`, read via the given options builder
    async function reachableFrom(oid, optsFn) {
      var seen = {};
      var queue = [oid];
      while (queue.length) {
        var o = queue.shift();
        if (!o || seen[o]) continue;
        var c;
        try { c = await gitlib.readCommit(optsFn({ oid: o })); } catch (e) { continue; }
        seen[o] = true;
        (c.commit.parent || []).forEach(function (p) { queue.push(p); });
      }
      return seen;
    }

    // How many commits each side has that the other lacks; each oid is read
    // through its own options builder (opts local, ropts the remote).
    async function aheadBehind(mine, mineOpts, theirs, theirsOpts) {
      var a = mine ? await reachableFrom(mine, mineOpts) : {};
      var b = await reachableFrom(theirs, theirsOpts);
      return {
        ahead: Object.keys(a).filter(function (o) { return !b[o]; }).length,
        behind: Object.keys(b).filter(function (o) { return !a[o]; }).length
      };
    }

    // remote.origin.url, or null when this repository has no origin
    async function originUrl() {
      if (!(await isRepo())) return null;
      try { return (await gitlib.getConfig(opts({ path: 'remote.origin.url' }))) || null; }
      catch (e) { return null; }
    }

    // One spelling of a URL for comparing: `git@github.com:a/b.git`,
    // `https://github.com/a/b` and `https://github.com/a/b.git/` all agree.
    function urlKey(u) {
      return String(u).trim().toLowerCase()
        .replace(/^[a-z+]+:\/\//, '').replace(/^[^@\/]+@/, '').replace(/^([^\/:]+):/, '$1/')
        .replace(/\/+$/, '').replace(/\.git$/, '');
    }

    // origin/x (or remotes/origin/x, refs/remotes/origin/x) -> x, else null
    function trackingName(spec) {
      var m = /^(?:refs\/)?(?:remotes\/)?origin\/(.+)$/.exec(spec || '');
      return m ? m[1] : null;
    }

    function trackingOid(name) { return refOid('refs/remotes/origin/' + name); }

    // the branches `git fetch` has recorded from origin, sorted; not
    // origin/HEAD, which only points at one of them
    async function trackingNames() {
      var out = [];
      async function walk(sub) {
        var names = [];
        try { names = await fs.promises.readdir(dir + '/.git/refs/remotes/origin' + sub); } catch (e) { return; }
        for (var i = 0; i < names.length; i++) {
          if (!sub && names[i] === 'HEAD') continue;
          var p = dir + '/.git/refs/remotes/origin' + sub + '/' + names[i];
          if ((await fs.promises.stat(p)).isDirectory()) await walk(sub + '/' + names[i]);
          else out.push((sub + '/' + names[i]).slice(1));
        }
      }
      await walk('');
      return out.sort();
    }

    // The branch origin/HEAD points at (the remote's default branch, which
    // fetch and clone record), or null
    async function originHead() {
      try {
        var t = await fs.promises.readFile(dir + '/.git/refs/remotes/origin/HEAD', 'utf8');
        var m = /^ref: refs\/remotes\/origin\/(.+)$/.exec(t.trim());
        return m ? m[1] : null;
      } catch (e) { return null; }
    }

    // A branch's upstream lives in .git/config, as in git, so it survives
    // undo and is what `git pull` and `git status` consult. Returns the
    // remote branch's name, or null.
    async function upstreamOf(branch) {
      var merge = null;
      try { merge = await gitlib.getConfig(opts({ path: 'branch.' + branch + '.merge' })); } catch (e) {}
      return merge ? String(merge).replace(/^refs\/heads\//, '') : null;
    }

    // remoteBranch null removes the upstream
    async function setUpstream(branch, remoteBranch) {
      await gitlib.setConfig(opts({ path: 'branch.' + branch + '.remote', value: remoteBranch ? 'origin' : undefined }));
      await gitlib.setConfig(opts({ path: 'branch.' + branch + '.merge', value: remoteBranch ? 'refs/heads/' + remoteBranch : undefined }));
    }

    // Where a new branch starts: { oid, tracks } where tracks names the
    // remote branch when the start point is origin/x, as git then sets it
    // as the upstream. Null if `spec` names nothing.
    async function startPoint(spec) {
      var t = trackingName(spec);
      if (t) {
        var toid = await trackingOid(t);
        if (toid) return { oid: toid, tracks: t };
      }
      var oid = await resolveCommit(spec);
      return oid ? { oid: oid, tracks: null } : null;
    }

    // What `git status` and `git checkout` say about a branch and its
    // upstream: "Your branch is ahead of 'origin/main' by 1 commit." and the
    // like. Compares with the remote-tracking branch, so news on the remote
    // shows only after `git fetch`, as in git. Empty without an upstream.
    async function trackingLines(branch) {
      var up = await upstreamOf(branch);
      if (!up) return [];
      var name = "'origin/" + up + "'";
      var theirs = await trackingOid(up);
      if (!theirs) return ['Your branch is based on ' + name + ', but the upstream is gone.',
        '  (use "git branch --unset-upstream" to fixup)'];
      var mine = await refOid(branch);
      if (!mine) return [];
      var ab = await aheadBehind(mine, opts, theirs, opts), ahead = ab.ahead, behind = ab.behind;
      var n = function (k) { return k + ' commit' + (k === 1 ? '' : 's'); };
      if (!ahead && !behind) return ['Your branch is up to date with ' + name + '.'];
      if (!behind) return ['Your branch is ahead of ' + name + ' by ' + n(ahead) + '.',
        '  (use "git push" to publish your local commits)'];
      if (!ahead) return ['Your branch is behind ' + name + ' by ' + n(behind) + ', and can be fast-forwarded.',
        '  (use "git pull" to update your local branch)'];
      return ['Your branch and ' + name + ' have diverged,',
        'and have ' + ahead + ' and ' + behind + ' different commits each, respectively.',
        '  (use "git pull" if you want to integrate the remote branch with yours)'];
    }

    function prefixLines(lines) { return lines.length ? '\n' + lines.join('\n') : ''; }

    async function setTrackingRef(branch, oid) {
      await gitlib.writeRef(opts({ ref: 'refs/remotes/origin/' + branch, value: oid, force: true }));
    }

    /* ------------------------- merge conflicts ---------------------- */

    // A merge that stops on conflicts leaves MERGE_HEAD and MERGE_MSG in
    // .git, as real git does, plus sandbox-merge.json: what is being merged
    // into what, and which files are still unresolved. isomorphic-git keeps
    // the unmerged index entries (and refuses to commit over them) but has
    // no API to list them, so the list lives here and shrinks as the learner
    // runs `git add` or `git rm`. Everything is in the in-memory fs, so undo
    // snapshots carry a half-finished merge along with the rest.
    var MERGE_STATE = '/.git/sandbox-merge.json';

    async function mergeState() {
      try { return JSON.parse(await fs.promises.readFile(dir + MERGE_STATE, 'utf8')); }
      catch (e) { return null; }
    }

    async function saveMergeState(st) {
      await fs.promises.writeFile(dir + '/.git/MERGE_HEAD', st.oid + '\n');
      await fs.promises.writeFile(dir + '/.git/MERGE_MSG', st.message + '\n');
      await fs.promises.writeFile(dir + MERGE_STATE, JSON.stringify(st));
    }

    async function clearMergeState() {
      ['/.git/MERGE_HEAD', '/.git/MERGE_MSG', MERGE_STATE].forEach(function (f) {
        fs._store.delete(dir + f);
      });
    }

    // `git add` / `git rm` on a conflicted path marks it resolved
    async function markResolved(paths) {
      var st = await mergeState();
      if (!st) return;
      st.unresolved = st.unresolved.filter(function (c) { return paths.indexOf(c.file) === -1; });
      await fs.promises.writeFile(dir + MERGE_STATE, JSON.stringify(st));
    }

    function unmergedError(verb) {
      return {
        out: 'error: ' + verb + ' is not possible because you have unmerged files.\n' +
             "hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n" +
             'hint: as appropriate to mark resolution and make a commit.\n' +
             'fatal: Exiting because of an unresolved conflict.',
        ok: false
      };
    }

    // A merge or pull cannot start while another is under way
    function mergeBlocker(st, verb) {
      if (st.conflicted.length) return unmergedError(verb);
      if (!st.merging) return null;
      return { out: 'fatal: You have not concluded your merge (MERGE_HEAD exists).\n' +
        'Please, commit your changes before you merge.', ok: false };
    }

    function sameBytes(a, b) {
      if (!a || !b || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    // Merge `theirs` (a ref) into the checked-out branch `ours`; `label` is
    // what the learner calls the other side, and goes into the conflict
    // markers and the merge record. Shared by `git merge` and `git pull`.
    // Returns isomorphic-git's result, or { conflict: <command result> }.
    async function mergeInto(ours, theirs, label, message) {
      var before = workdirBytes();
      var result;
      try {
        result = await gitlib.merge(opts({
          ours: ours, theirs: theirs, theirName: label,
          abortOnConflict: false,
          author: { name: author.name, email: author.email },
          message: message
        }));
      } catch (e) {
        if (e.code !== 'MergeConflictError') throw e;
        return { conflict: await stopOnConflicts(ours, theirs, label, message, before, e.data) };
      }
      // bring the working directory in line with the new ref
      await gitlib.checkout(opts({ ref: ours, force: true }));
      if (!result.alreadyMerged) mergesDone.push({ from: label, into: ours });
      return result;
    }

    async function stopOnConflicts(ours, theirs, label, message, before, data) {
      var conflicted = data.filepaths || [];
      var kindOf = function (f) {
        if ((data.deleteByUs || []).indexOf(f) !== -1) return 'deleted by us';
        if ((data.deleteByTheirs || []).indexOf(f) !== -1) return 'deleted by them';
        return 'both modified';
      };
      // isomorphic-git writes the cleanly merged files to the working
      // directory but leaves them out of the index. Real git stages them, so
      // they go into the merge commit without a `git add`; do the same, but
      // only for files the merge actually changed, so the learner's own
      // unstaged edits stay unstaged.
      var after = workdirBytes();
      var seen = {};
      Object.keys(before).concat(Object.keys(after)).forEach(function (f) { seen[f] = true; });
      var paths = Object.keys(seen).sort();
      for (var i = 0; i < paths.length; i++) {
        var f = paths[i];
        if (conflicted.indexOf(f) !== -1 || sameBytes(before[f], after[f])) continue;
        if (after[f]) await gitlib.add(opts({ filepath: f }));
        else await gitlib.remove(opts({ filepath: f }));
      }
      var unresolved = conflicted.map(function (f) { return { file: f, kind: kindOf(f) }; });
      await saveMergeState({
        from: label, into: ours, message: message,
        oid: await gitlib.resolveRef(opts({ ref: theirs })),
        files: conflicted.slice(), unresolved: unresolved
      });
      var lines = [];
      unresolved.forEach(function (c) {
        if (c.kind === 'both modified') {
          lines.push('Auto-merging ' + c.file);
          lines.push('{r}CONFLICT (content){/}: Merge conflict in ' + c.file);
        } else {
          var gone = c.kind === 'deleted by us' ? 'HEAD' : label;
          var kept = c.kind === 'deleted by us' ? label : 'HEAD';
          lines.push('{r}CONFLICT (modify/delete){/}: ' + c.file + ' deleted in ' + gone +
            ' and modified in ' + kept + '. Version ' + kept + ' of ' + c.file + ' left in tree.');
        }
      });
      lines.push('Automatic merge failed; fix conflicts and then commit the result.');
      return { out: lines.join('\n'), ok: false, conflict: true };
    }

    /* ------------------------- graph model ------------------------- */

    // Shared commit-graph builder. refEntries: [{ name, oid, isHead, remote }].
    // Walks history from the given refs (plus extraSeeds), reading commits
    // with optsFn — opts for the local repo, ropts for the remote.
    async function buildGraph(refEntries, extraSeeds, optsFn) {
      var seeds = refEntries.map(function (e) { return e.oid; })
        .concat(extraSeeds || [])
        .filter(Boolean);

      var seen = new Map();
      var queue = seeds.slice();
      while (queue.length) {
        var oid2 = queue.shift();
        if (!oid2 || seen.has(oid2)) continue;
        var c;
        try { c = await gitlib.readCommit(optsFn({ oid: oid2 })); }
        catch (e) { continue; }
        seen.set(oid2, {
          oid: oid2,
          short: oid2.slice(0, 7),
          message: (c.commit.message || '').split('\n')[0],
          parents: c.commit.parent || [],
          timestamp: c.commit.author.timestamp,
          author: c.commit.author.name,
          refs: []
        });
        (c.commit.parent || []).forEach(function (p) { queue.push(p); });
      }

      // Topological order, children before parents, preferring newer commits.
      // A plain timestamp sort is not enough: commits made in the same second
      // (which happens whenever we seed a repo programmatically) would tie.
      var all = Array.from(seen.values());
      var childCount = {};
      all.forEach(function (c) { childCount[c.oid] = 0; });
      all.forEach(function (c) {
        (c.parents || []).forEach(function (p) {
          if (p in childCount) childCount[p]++;
        });
      });
      var ready = all.filter(function (c) { return childCount[c.oid] === 0; });
      var commits = [];
      var guard = all.length + 1;
      while (ready.length && guard-- > 0) {
        ready.sort(function (a, b) { return b.timestamp - a.timestamp; });
        var next = ready.shift();
        commits.push(next);
        (next.parents || []).forEach(function (p) {
          if (!(p in childCount)) return;
          childCount[p]--;
          if (childCount[p] === 0) ready.push(seen.get(p));
        });
      }
      // safety net: if a cycle ever appeared, fall back to timestamp order
      if (commits.length !== all.length) {
        commits = all.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
      }

      refEntries.forEach(function (e) {
        var node = seen.get(e.oid);
        if (node) node.refs.push({ name: e.name, isHead: !!e.isHead, remote: !!e.remote });
      });

      // lane assignment: walk newest -> oldest keeping a set of open lanes
      var lanes = [];
      var laneOf = {};
      commits.forEach(function (c2) {
        var lane = lanes.indexOf(c2.oid);
        if (lane === -1) {
          lane = lanes.indexOf(null);
          if (lane === -1) { lane = lanes.length; lanes.push(null); }
        }
        lanes[lane] = null;
        laneOf[c2.oid] = lane;
        c2.lane = lane;
        var ps = c2.parents || [];
        if (ps.length) {
          lanes[lane] = ps[0];
          for (var j = 1; j < ps.length; j++) {
            if (lanes.indexOf(ps[j]) !== -1) continue;
            var free = lanes.indexOf(null);
            if (free === -1) { lanes.push(ps[j]); } else { lanes[free] = ps[j]; }
          }
        }
      });

      return commits;
    }

    async function graphModel() {
      if (!(await isRepo())) return { commits: [], branches: [], head: null, detached: false, merges: [] };

      var branches = await gitlib.listBranches(opts());
      var head = await currentBranch();
      var refs = {};
      var refEntries = [];

      for (var i = 0; i < branches.length; i++) {
        var oid = await refOid(branches[i]);
        if (!oid) continue;   // unborn branch
        refs[branches[i]] = oid;
        refEntries.push({ name: branches[i], oid: oid, isHead: branches[i] === head });
      }

      // remote-tracking refs (origin/*) appear as grey pills, like real git log
      if (remoteUrl) {
        // origin/HEAD is left out: a pill saying where the remote's
        // default branch is would only crowd the graph
        var tracked = await trackingNames();
        for (var t = 0; t < tracked.length; t++) {
          var toid = await trackingOid(tracked[t]);
          if (toid) refEntries.push({ name: 'origin/' + tracked[t], oid: toid, remote: true });
        }
      }

      // include HEAD in case it is detached
      var headOid = await refOid('HEAD');

      var commits = await buildGraph(refEntries, headOid ? [headOid] : [], opts);

      return {
        commits: commits,
        branches: branches.map(function (b) { return { name: b, oid: refs[b] || null, isHead: b === head }; }),
        head: head,
        headOid: headOid,
        detached: head === null && headOid !== null,
        merges: mergesDone.slice()
      };
    }

    // What the mock remote looks like "on GitHub": its own commit graph plus
    // how the learner's current branch compares to it. Null until
    // `git remote add origin <url>` has run. `remotes` lists every remote's
    // name; there is only ever `origin` for now, so `name` picks it.
    async function remoteModel(name) {
      if (!remoteUrl) return null;
      var remotes = ['origin'];
      name = remotes.indexOf(name) !== -1 ? name : remotes[0];
      var names = await listRemoteBranchNames();
      var refEntries = [];
      for (var i = 0; i < names.length; i++) {
        refEntries.push({ name: 'origin/' + names[i], oid: await remoteBranchOid(names[i]), remote: true });
      }
      var commits = await buildGraph(refEntries, [], ropts);

      var branch = await currentBranch();
      var tracked = false, ahead = 0, behind = 0;
      if (branch) {
        var remoteOid = await remoteBranchOid(branch);
        if (remoteOid) {
          tracked = true;
          var ab = await aheadBehind(await refOid(branch), opts, remoteOid, ropts);
          ahead = ab.ahead;
          behind = ab.behind;
        }
      }
      return {
        name: name, remotes: remotes,
        url: remoteUrl,
        graph: { commits: commits, branches: names, head: null, detached: false },
        branch: branch, tracked: tracked, ahead: ahead, behind: behind
      };
    }

    /* --------------------------- git status ------------------------ */

    // returns { staged:[], modified:[], untracked:[], deleted:[], stagedDeleted:[], ignored:[] }
    // isomorphic-git statusMatrix rows are [filepath, HEAD, WORKDIR, STAGE] where
    //   HEAD:    0 = absent,               1 = present
    //   WORKDIR: 0 = absent,               1 = same as HEAD, 2 = different from HEAD
    //   STAGE:   0 = absent, 1 = same as HEAD, 2 = same as WORKDIR, 3 = different from both
    //
    // During a merge that stopped on conflicts, `merging` is true and the
    // files still to resolve are in `conflicted` ([{ file, kind }]) and in
    // none of the other lists.
    async function statusModel() {
      var matrix = await gitlib.statusMatrix(opts());
      var merge = await mergeState();
      var res = {
        staged: [], modified: [], untracked: [], deleted: [], stagedDeleted: [],
        conflicted: merge ? merge.unresolved.slice() : [], merging: !!merge,
        ignored: []
      };
      // statusMatrix lists every working file except those .gitignore
      // matches (and does not track), so whatever it leaves out is ignored
      var listed = {};
      matrix.forEach(function (row) { listed[row[0]] = true; });
      (await listFiles()).forEach(function (f) { if (!listed[f]) res.ignored.push(f); });
      var skip = {};
      res.conflicted.forEach(function (c) { skip[c.file] = true; });
      // a file taken out of git (`git rm --cached`) but still on disk
      var leftOnDisk = [];
      matrix.forEach(function (row) {
        var file = row[0], head = row[1], workdir = row[2], stage = row[3];
        if (skip[file]) return;

        if (head === 0) {
          // file is not in the last commit
          if (stage === 0) { if (workdir !== 0) res.untracked.push(file); return; }
          res.staged.push({ file: file, kind: 'new file' });
          if (workdir === 0) res.deleted.push(file);       // staged then deleted on disk
          else if (stage === 3) res.modified.push(file);   // staged, then edited again
          return;
        }

        // file was in the last commit
        if (stage === 0) { res.stagedDeleted.push(file); if (workdir !== 0) leftOnDisk.push(file); return; }
        if (workdir === 0) { res.deleted.push(file); return; }
        if (stage === 1) { if (workdir === 2) res.modified.push(file); return; }
        // stage 2 or 3 => something is staged
        if (workdir === 2 || stage === 3) {
          res.staged.push({ file: file, kind: 'modified' });
          if (stage === 3) res.modified.push(file);        // staged one version, edited again
        }
      });
      // statusMatrix still lists it because HEAD has it, so ask .gitignore
      for (var i = 0; i < leftOnDisk.length; i++) {
        if (await gitlib.isIgnored(opts({ filepath: leftOnDisk[i] }))) res.ignored.push(leftOnDisk[i]);
        else res.untracked.push(leftOnDisk[i]);
      }
      res.ignored.sort();
      return res;
    }

    // Untracked (or ignored) files as `git status` lists them: a folder
    // holding nothing else git knows about shows once, as `notes/`, instead
    // of file by file. `others` are paths that keep a folder from
    // collapsing on top of the tracked ones.
    async function untrackedShown(untracked, others) {
      var known = (await gitlib.statusMatrix(opts()))
        .filter(function (row) { return row[1] !== 0 || row[3] !== 0; })
        .map(function (row) { return row[0]; })
        .concat(others || []);
      var shown = [];
      untracked.forEach(function (f) {
        var parts = f.split('/');
        var name = f;
        for (var i = 1; i < parts.length; i++) {
          var d = parts.slice(0, i).join('/') + '/';
          if (!known.some(function (k) { return k.indexOf(d) === 0; })) { name = d; break; }
        }
        if (shown.indexOf(name) === -1) shown.push(name);
      });
      return shown.sort();
    }

    // `git rm` deletes a folder once its last file has gone, as git does
    async function removeFileAndEmptyParents(p) {
      try { await fs.promises.unlink(p); } catch (e) { return; }
      var d = fs._dirname(p);
      while (d !== dir && insideProject(d)) {
        try { await fs.promises.rmdir(d); } catch (e) { return; }
        d = fs._dirname(d);
      }
    }

    // path -> blob oid for everything in the staging area
    async function indexEntries() {
      var out = {};
      await gitlib.walk(opts({
        trees: [gitlib.STAGE()],
        map: async function (fp, entries) {
          if (!entries[0]) return null;
          if (fp !== '.' && (await entries[0].type()) === 'blob') out[fp] = await entries[0].oid();
          return true;
        }
      }));
      return out;
    }

    function ambiguous(word) {
      return {
        out: "fatal: ambiguous argument '" + word + "': unknown revision or path not in the working tree.\n" +
          "Use '--' to separate paths from revisions, like this:\n" +
          "'git <command> [<revision>...] -- [<file>...]'",
        ok: false
      };
    }

    // Is `spec` a path git could mean: on disk, staged, or in the last commit?
    async function knownPath(spec) {
      var match = pathspec(spec);
      if (!match) return false;
      try { await fs.promises.stat(abs(spec)); return true; } catch (e) {}
      var pool = await gitlib.listFiles(opts());
      var head = await refOid('HEAD');
      if (head) pool = pool.concat(Object.keys(await flatTree(head)));
      return pool.some(match);
    }

    // What `git reset` prints after it has unstaged things: every tracked
    // file whose working copy now differs from the staging area.
    async function unstagedSummary() {
      var st = await statusModel();
      var rows = st.modified.map(function (f) { return 'M\t' + f; })
        .concat(st.deleted.map(function (f) { return 'D\t' + f; }));
      rows.sort(function (a, b) { return a.slice(2) < b.slice(2) ? -1 : 1; });
      return rows.length ? 'Unstaged changes after reset:\n' + rows.join('\n') : '';
    }

    // Put the staged copy of each matching path back to how commit `oid`
    // has it (or take it out of the staging area, if `oid` lacks it or
    // there is no commit yet). Shared by `git reset <path>` and
    // `git restore --staged <path>`; the working files are not touched.
    async function unstagePaths(specs, oid, verb) {
      var pool = {};
      (await gitlib.listFiles(opts())).forEach(function (f) { pool[f] = true; });
      if (oid) Object.keys(await flatTree(oid)).forEach(function (f) { pool[f] = true; });
      var hits = [];
      for (var i = 0; i < specs.length; i++) {
        var match = pathspec(specs[i]);
        var h = match ? Object.keys(pool).filter(match) : [];
        if (!h.length) {
          return verb === 'reset'
            ? ambiguous(specs[i])
            : { out: "error: pathspec '" + specs[i] + "' did not match any file(s) known to git", ok: false };
        }
        h.forEach(function (f) { if (hits.indexOf(f) === -1) hits.push(f); });
      }
      for (var j = 0; j < hits.length; j++) {
        if (oid) await gitlib.resetIndex(opts({ filepath: hits[j], ref: oid }));
        else await gitlib.remove(opts({ filepath: hits[j] }));
      }
      await markResolved(hits);
      return { out: verb === 'reset' ? await unstagedSummary() : '', ok: true };
    }

    // `git reset [--soft|--mixed|--hard] <commit>`: move the current branch
    // (or a detached HEAD) to `oid`; --mixed also resets the staging area
    // to it, --hard the working files too. Any merge in progress is
    // dropped, as in git.
    async function resetTo2(oid, mode) {
      var branch = await currentBranch();
      var tracked = await gitlib.listFiles(opts());
      await gitlib.writeRef(opts(branch
        ? { ref: 'refs/heads/' + branch, value: oid, force: true }
        : { ref: 'HEAD', value: oid, force: true }));
      await clearMergeState();
      if (mode === 'soft') return { out: '', ok: true };
      var target = await flatTree(oid);
      if (mode === 'hard') {
        await gitlib.checkout(opts({ ref: branch || oid, force: true }));
        // files git tracked that the commit does not have go away
        for (var i = 0; i < tracked.length; i++) {
          if (!target[tracked[i]]) await removeFileAndEmptyParents(dir + '/' + tracked[i]);
        }
        return { out: 'HEAD is now at ' + oid.slice(0, 7) + ' ' + await subjectOf(oid), ok: true };
      }
      var all = {};
      tracked.concat(Object.keys(target)).forEach(function (f) { all[f] = true; });
      var paths = Object.keys(all);
      for (var j = 0; j < paths.length; j++) await gitlib.resetIndex(opts({ filepath: paths[j], ref: oid }));
      return { out: await unstagedSummary(), ok: true };
    }

    // .git/config as `git config --list` prints it: section.key=value
    async function localConfigLines() {
      var text = '';
      try { text = await fs.promises.readFile(dir + '/.git/config', 'utf8'); } catch (e) { return []; }
      var out = [], section = '';
      text.split('\n').forEach(function (line) {
        var sec = /^\s*\[([^\s\]"]+)(?:\s+"([^"]*)")?\]/.exec(line);
        if (sec) { section = sec[1].toLowerCase() + (sec[2] !== undefined ? '.' + sec[2] : ''); return; }
        var kv = /^\s*([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(line);
        if (kv && section) out.push(section + '.' + kv[1].toLowerCase() + '=' + kv[2].trim());
      });
      return out;
    }

    /* ---------------------------- commits --------------------------- */

    async function makeCommit(msg, st) {
      var o = { message: msg, author: { name: author.name, email: author.email } };
      var merge = await mergeState();
      var parent = await refOid('HEAD');
      // concluding a conflicted merge: the commit gets both parents
      if (merge) o.parent = [parent, merge.oid];
      var sha = await gitlib.commit(opts(o));
      var branch = await currentBranch();
      if (merge) {
        await clearMergeState();
        mergesDone.push({ from: merge.from, into: merge.into });
      }
      var nFiles = st.staged.length + st.stagedDeleted.length;
      return {
        out: '[' + (branch || 'detached HEAD') + (parent ? '' : ' (root-commit)') + ' ' + sha.slice(0, 7) + '] ' + msg.split('\n')[0] + '\n ' + nFiles + ' file' + (nFiles === 1 ? '' : 's') + ' changed',
        ok: true
      };
    }

    // Can `git commit` go ahead? Null if so, else the refusal. A merge
    // commit may record no change of its own (the learner kept their side
    // of every conflict), so only an ordinary commit needs something staged.
    async function commitBlocker(st) {
      if (st.conflicted.length) return unmergedError('Committing');
      if (st.merging || st.staged.length || st.stagedDeleted.length) return null;
      var extra = st.untracked.length || st.modified.length
        ? '\nUse `git add <file>` to stage changes first.' : '';
      return { out: (await headLine()) + '\nnothing to commit, working tree clean' + extra, ok: false };
    }

    // what `git commit` without -m puts in the editor, as real git does
    async function commitTemplate(st) {
      var merge = await mergeState();
      var lines = merge ? [merge.message, ''] : [''];
      if (merge && merge.files.length) {
        lines.push('# Conflicts:');
        merge.files.forEach(function (f) { lines.push('#\t' + f); });
        lines.push('#');
      }
      lines = lines.concat([
        '# Please enter the commit message for your changes. Lines starting',
        "# with '#' will be ignored, and an empty message aborts the commit.",
        '#',
        '# ' + (await headLine())
      ]);
      if (merge) lines.push('# All conflicts fixed but you are still merging.');
      lines = lines.concat([
        '#',
        '# Changes to be committed:'
      ]);
      st.staged.forEach(function (s) { lines.push('#\t' + s.kind + ':   ' + s.file); });
      st.stagedDeleted.forEach(function (f) { lines.push('#\tdeleted:    ' + f); });
      lines.push('#');
      return lines.join('\n') + '\n';
    }

    // Second half of an editor commit: `text` is the saved COMMIT_EDITMSG,
    // or null if the editor quit without saving.
    async function finishCommit(text) {
      var msg = String(text == null ? '' : text).split('\n')
        .filter(function (l) { return l.charAt(0) !== '#'; })
        .map(function (l) { return l.replace(/\s+$/, ''); })
        .join('\n').replace(/^\n+|\n+$/g, '');
      if (!msg) return { out: 'Aborting commit due to empty commit message.', ok: false, kind: 'git' };
      var st = await statusModel();
      var blocked = await commitBlocker(st);
      if (blocked) {
        blocked.kind = 'git';
        return blocked;
      }
      var r = await makeCommit(msg, st);
      r.kind = 'git';
      return r;
    }

    /* -------------------------- git commands ----------------------- */

    async function gitCommand(args) {
      var sub = args[0];
      var rest = args.slice(1);

      if (!sub) return { out: usageGit(), ok: false };

      // `git <command> -h` works anywhere, even outside a repository.
      // Real git exits with 129 here; the sandbox counts it as success so
      // the text is not shown as an error, and `> file` captures it.
      if (rest.length === 1 && (rest[0] === '-h' || rest[0] === '--help') && HELP[sub]) {
        return { out: HELP[sub].join('\n'), ok: true };
      }
      if (sub === 'help' && rest[0] && HELP[rest[0]]) return { out: HELP[rest[0]].join('\n'), ok: true };

      if (sub !== 'init' && sub !== 'clone' && sub !== 'help' && sub !== 'config' && !(await isRepo())) {
        return { out: 'fatal: not a git repository (or any of the parent directories): .git\nHint: run `git init` first.', ok: false };
      }

      switch (sub) {
        case 'init': {
          if (cwd !== dir && !(await isRepo())) {
            return { out: 'This sandbox keeps the repository at the top of the project.\nRun `cd ~` first, then `git init`.', ok: false };
          }
          if (await isRepo()) return { out: 'Reinitialized existing Git repository in ' + displayDir + '/.git/', ok: true };
          var initial = globalConfig['init.defaultbranch'] || defaultBranch;
          for (var ib = 0; ib < rest.length; ib++) {
            if (rest[ib] === '-b' || rest[ib] === '--initial-branch') initial = rest[++ib] || initial;
            else if (rest[ib].indexOf('--initial-branch=') === 0) initial = rest[ib].slice(17);
          }
          await gitlib.init(opts({ defaultBranch: initial }));
          detachPoint = null;
          prevHead = null;
          repoReady = true;
          return { out: 'Initialized empty Git repository in ' + displayDir + '/.git/', ok: true };
        }

        case 'config': {
          var global = false, list = false, unset = false;
          var cw = [];
          // git 2.46+ spells the actions as subcommands: list, get, set, unset
          var action = ['list', 'get', 'set', 'unset'].indexOf(rest[0]) !== -1 ? rest[0] : null;
          if (action === 'list') list = true;
          if (action === 'unset') unset = true;
          rest.slice(action ? 1 : 0).forEach(function (a) {
            if (a === '--global' || a === '--system') global = true;
            else if (a === '-l' || a === '--list') list = true;
            else if (a === '--unset') unset = true;
            else if (a === '--local' || a === '--get' || a === '--add' || a === '--replace-all') { /* the default */ }
            else cw.push(a);
          });
          var inRepo = await isRepo();
          if (list) {
            var all = ['user.name=' + author.name, 'user.email=' + author.email];
            Object.keys(globalConfig).sort().forEach(function (k) { all.push(k + '=' + globalConfig[k]); });
            if (!global && inRepo) all = all.concat(await localConfigLines());
            return { out: all.join('\n'), ok: true };
          }
          if (!cw.length) return { out: HELP.config.join('\n'), ok: false };
          var key = cw[0];
          // section and variable names are case-insensitive in git
          var lk = key.toLowerCase();
          if (lk.indexOf('.') <= 0 || lk.charAt(lk.length - 1) === '.') {
            return { out: 'error: key does not contain a section: ' + key, ok: false };
          }
          var value = cw.length > 1 ? cw.slice(1).join(' ') : null;
          if (action === 'get' && value !== null) return { out: 'error: wrong number of arguments, should be 1', ok: false };
          if (action === 'set' && value === null) return { out: 'error: wrong number of arguments, should be 2', ok: false };
          // user.name and user.email sign the sandbox's commits, whichever file they are set in
          if (lk === 'user.name' || lk === 'user.email') {
            var field = lk === 'user.name' ? 'name' : 'email';
            if (value === null && !unset) return { out: author[field], ok: true };
            author[field] = unset ? (field === 'name' ? 'Your Name' : 'you@example.com') : value;
            return { out: '', ok: true };
          }
          if (!global && !inRepo) {
            if (value === null && !unset && lk in globalConfig) return { out: globalConfig[lk], ok: true };
            return { out: 'fatal: not in a git directory', ok: false };
          }
          if (global) {
            if (unset) delete globalConfig[lk];
            else if (value === null) return lk in globalConfig ? { out: globalConfig[lk], ok: true } : { out: '', ok: false };
            else globalConfig[lk] = value;
            return { out: '', ok: true };
          }
          if (unset) { await gitlib.setConfig(opts({ path: key, value: undefined })); return { out: '', ok: true }; }
          if (value === null) {
            var got = await gitlib.getConfig(opts({ path: key }));
            if (got === undefined || got === null) {
              return lk in globalConfig ? { out: globalConfig[lk], ok: true } : { out: '', ok: false };
            }
            return { out: String(got), ok: true };
          }
          await gitlib.setConfig(opts({ path: key, value: value }));
          return { out: '', ok: true };
        }

        case 'status': {
          var st = await statusModel();
          var lines = [await headLine()];
          var stBranch = await currentBranch();
          if (stBranch) lines = lines.concat(await trackingLines(stBranch));
          var anyCommit = !!(await refOid('HEAD'));
          if (!anyCommit) lines.push('', 'No commits yet');
          if (st.conflicted.length) {
            lines.push('You have unmerged paths.',
              '  (fix conflicts and run "git commit")',
              '  (use "git merge --abort" to abort the merge)');
          } else if (st.merging) {
            lines.push('All conflicts fixed but you are still merging.',
              '  (use "git commit" to conclude merge)');
          }

          if (st.staged.length || st.stagedDeleted.length) {
            lines.push('', 'Changes to be committed:',
              anyCommit ? '  (use "git restore --staged <file>..." to unstage)' : '  (use "git rm --cached <file>..." to unstage)');
            st.staged.forEach(function (s) { lines.push('  {g}' + s.kind + ':   ' + s.file + '{/}'); });
            st.stagedDeleted.forEach(function (f) { lines.push('  {g}deleted:    ' + f + '{/}'); });
          }
          if (st.conflicted.length) {
            lines.push('', 'Unmerged paths:', '  (use "git add <file>..." to mark resolution)');
            st.conflicted.forEach(function (c) { lines.push('  {r}' + c.kind + ':   ' + c.file + '{/}'); });
          }
          if (st.modified.length || st.deleted.length) {
            lines.push('', 'Changes not staged for commit:',
              '  (use "git ' + (st.deleted.length ? 'add/rm' : 'add') + ' <file>..." to update what will be committed)',
              '  (use "git restore <file>..." to discard changes in working directory)');
            st.modified.forEach(function (f) { lines.push('  {r}modified:   ' + f + '{/}'); });
            st.deleted.forEach(function (f) { lines.push('  {r}deleted:    ' + f + '{/}'); });
          }
          if (st.untracked.length) {
            lines.push('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
            (await untrackedShown(st.untracked)).forEach(function (f) { lines.push('  {r}' + f + '{/}'); });
          }
          if (rest.indexOf('--ignored') !== -1 && st.ignored.length) {
            lines.push('', 'Ignored files:', '  (use "git add -f <file>..." to include in what will be committed)');
            (await untrackedShown(st.ignored, st.untracked)).forEach(function (f) { lines.push('  {r}' + f + '{/}'); });
          }
          var anyStaged = st.staged.length || st.stagedDeleted.length;
          if (!anyStaged) {
            if (st.modified.length || st.deleted.length || st.conflicted.length) {
              lines.push('', 'no changes added to commit (use "git add" and/or "git commit -a")');
            } else if (st.untracked.length) {
              lines.push('', 'nothing added to commit but untracked files present (use "git add" to track)');
            } else if (!anyCommit) {
              lines.push('', 'nothing to commit (create/copy files and use "git add" to track)');
            } else {
              lines.push('', 'nothing to commit, working tree clean');
            }
          }
          return { out: lines.join('\n'), ok: true };
        }

        case 'add': {
          if (!rest.length) return { out: "Nothing specified, nothing added.\nhint: try 'git add .' or 'git add <file>'", ok: false };
          var added = [];
          // statusMatrix leaves out files .gitignore matches; -f takes them too
          var force = rest.indexOf('-f') !== -1 || rest.indexOf('--force') !== -1;
          var m = await gitlib.statusMatrix(opts());
          var st0 = await statusModel();
          var conflictedNow = st0.conflicted.map(function (c) { return c.file; });
          var ignoredNamed = [];
          for (var i = 0; i < rest.length; i++) {
            var spec = rest[i];
            if (spec === '--' || (spec.charAt(0) === '-' && spec !== '-A' && spec !== '--all')) continue;
            // -A is repo-wide; `.` means here and below, as in real git
            var match = spec === '-A' || spec === '--all' ? pathspec(dir) : pathspec(spec);
            if (!match) return { out: "fatal: " + spec + ": '" + spec + "' is outside repository at '" + displayDir + "'", ok: false };
            var hit = m.filter(function (row) { return match(row[0]); }).map(function (row) { return row[0]; });
            // a conflicted file the learner deleted: staging the deletion resolves it
            conflictedNow.forEach(function (c) { if (match(c) && hit.indexOf(c) === -1) hit.push(c); });
            if (force) {
              st0.ignored.forEach(function (f) {
                if (match(f) && hit.indexOf(f) === -1) hit.push(f);
              });
            }
            if (!hit.length) {
              var exists = true;
              try { await fs.promises.stat(abs(spec)); } catch (e) { exists = false; }
              // Naming an ignored file outright is refused (but the other
              // paths still go in); a folder or glob that only reaches
              // ignored files just matches nothing, as in real git.
              if (exists && !hasGlob(spec) && await gitlib.isIgnored(opts({ filepath: rel(spec) }))) {
                ignoredNamed.push(spec);
                continue;
              }
              if (exists) continue;    // an empty folder: nothing to add, no complaint
              return { out: "fatal: pathspec '" + spec + "' did not match any files", ok: false };
            }
            for (var j = 0; j < hit.length; j++) {
              var gone = true;
              try { gone = !(await fs.promises.stat(dir + '/' + hit[j])).isFile(); } catch (e) {}
              if (gone) await gitlib.remove(opts({ filepath: hit[j] }));
              else await gitlib.add(opts({ filepath: hit[j], force: force }));
              added.push(hit[j]);
            }
          }
          await markResolved(added);
          if (ignoredNamed.length) {
            return {
              out: 'The following paths are ignored by one of your .gitignore files:\n' +
                ignoredNamed.join('\n') + '\n' +
                '{y}hint: Use -f if you really want to add them.{/}',
              ok: false
            };
          }
          return { out: '', ok: true, silentNote: added.length + ' path(s) staged' };
        }

        case 'rm': {
          var cached = rest.indexOf('--cached') !== -1;
          var recursive = rest.some(function (a) { return /^-[a-zA-Z]*r/.test(a) && a.charAt(1) !== '-'; });
          var dashes = rest.indexOf('--');
          var rmSpecs = rest.filter(function (a, n) { return (dashes !== -1 && n > dashes) || (a.charAt(0) !== '-'); });
          if (!rmSpecs.length) return { out: 'usage: git rm [--cached] [-r] [--] <file>...', ok: false };
          // only what git tracks can be removed: the index, plus files
          // still in conflict
          var inIndex = await gitlib.listFiles(opts());
          (await mergeState() || { unresolved: [] }).unresolved.forEach(function (c) {
            if (inIndex.indexOf(c.file) === -1) inIndex.push(c.file);
          });
          var doomed = [];
          // check every path first: git removes nothing if one is wrong
          for (var ri = 0; ri < rmSpecs.length; ri++) {
            var rmMatch = pathspec(rmSpecs[ri]);
            var rmHit = rmMatch ? inIndex.filter(rmMatch) : [];
            if (!rmHit.length) return { out: "fatal: pathspec '" + rmSpecs[ri] + "' did not match any files", ok: false };
            if (!recursive && !hasGlob(rmSpecs[ri]) && rmHit.some(function (f) { return f !== rel(rmSpecs[ri]); })) {
              return { out: "fatal: not removing '" + rmSpecs[ri] + "' recursively without -r", ok: false };
            }
            rmHit.forEach(function (f) { if (doomed.indexOf(f) === -1) doomed.push(f); });
          }
          doomed.sort();
          for (var rd = 0; rd < doomed.length; rd++) {
            await gitlib.remove(opts({ filepath: doomed[rd] }));
            // --cached takes the file out of git only; it stays on disk
            if (!cached) await removeFileAndEmptyParents(dir + '/' + doomed[rd]);
          }
          await markResolved(doomed);
          return { out: doomed.map(function (f) { return "rm '" + f + "'"; }).join('\n'), ok: true };
        }

        case 'check-ignore': {
          var ciPaths = rest.filter(function (a) { return a.charAt(0) !== '-'; });
          if (!ciPaths.length) return { out: 'fatal: no path specified', ok: false };
          var ignoredOnes = [];
          for (var ci = 0; ci < ciPaths.length; ci++) {
            if (await gitlib.isIgnored(opts({ filepath: rel(ciPaths[ci]) }))) ignoredOnes.push(ciPaths[ci]);
          }
          // like git: prints the ignored ones, and fails if there were none
          return { out: ignoredOnes.join('\n'), ok: ignoredOnes.length > 0 };
        }

        case 'commit': {
          // each -m is a paragraph of the message, as in git
          var msgs = [];
          var stageAll = false;
          for (var k = 0; k < rest.length; k++) {
            var ca = rest[k];
            if (ca === '-m' || ca === '--message') { msgs.push(rest[++k] || ''); continue; }
            if (ca.indexOf('--message=') === 0) { msgs.push(ca.slice(10)); continue; }
            if (ca === '-a' || ca === '--all') { stageAll = true; continue; }
            // bundled short options, as in `-am "message"` or `-mText`
            if (/^-[a-zA-Z]/.test(ca)) {
              for (var ck = 1; ck < ca.length; ck++) {
                if (ca.charAt(ck) === 'a') stageAll = true;
                else if (ca.charAt(ck) === 'm') {
                  msgs.push(ck + 1 < ca.length ? ca.slice(ck + 1) : (rest[++k] || ''));
                  break;
                }
              }
            }
          }
          var msg = msgs.length ? msgs.filter(Boolean).join('\n\n') : null;
          if (msg === '') return { out: 'Aborting commit due to empty commit message.', ok: false };
          var st2 = await statusModel();
          if (st2.conflicted.length) return unmergedError('Committing');
          if (stageAll) {
            // -a stages every change to a file git already tracks, never
            // an untracked one
            var cm = await gitlib.statusMatrix(opts());
            for (var cr = 0; cr < cm.length; cr++) {
              if (cm[cr][1] === 0 && cm[cr][3] === 0) continue;
              if (cm[cr][2] === 0) await gitlib.remove(opts({ filepath: cm[cr][0] }));
              else await gitlib.add(opts({ filepath: cm[cr][0] }));
            }
            st2 = await statusModel();
          }
          var blocked = await commitBlocker(st2);
          if (blocked) return blocked;
          if (msg === null) {
            // Without -m, real git opens an editor (usually vim) on
            // COMMIT_EDITMSG. The engine has no screen, so it hands the
            // template back; the UI runs the editor and passes what was
            // saved to finishCommit. Nothing has changed yet.
            return { out: '', ok: true, editor: { file: '.git/COMMIT_EDITMSG', text: await commitTemplate(st2) } };
          }
          return makeCommit(msg, st2);
        }

        case 'log': {
          var oneline = rest.indexOf('--oneline') !== -1;
          // `git log origin/main`: start from a branch, remote-tracking
          // branch or commit instead of HEAD
          var logFrom = null;
          for (var lf = 0; lf < rest.length; lf++) {
            if (rest[lf] === '-n') { lf++; continue; }
            if (rest[lf].charAt(0) === '-') continue;
            var tn = trackingName(rest[lf]);
            logFrom = (tn && await trackingOid(tn)) || await resolveCommit(rest[lf]);
            if (!logFrom) return ambiguous(rest[lf]);
            break;
          }
          var commits;
          try { commits = await gitlib.log(opts({ depth: 50, ref: logFrom || 'HEAD' })); }
          catch (e) { return { out: "fatal: your current branch does not have any commits yet", ok: false }; }
          if (!commits.length) return { out: 'fatal: your current branch does not have any commits yet', ok: false };
          // isomorphic-git's log revisits shared history once per merge parent
          var logSeen = {};
          commits = commits.filter(function (c) {
            if (logSeen[c.oid]) return false;
            logSeen[c.oid] = true;
            return true;
          });
          var g = await graphModel();
          // --all: every commit any branch or origin/* reaches, newest first
          if (rest.indexOf('--all') !== -1) {
            commits = [];
            for (var ga = 0; ga < g.commits.length; ga++) commits.push(await gitlib.readCommit(opts({ oid: g.commits[ga].oid })));
          }
          // -3, -n 3, --max-count=3
          var maxCount = null;
          for (var lr = 0; lr < rest.length; lr++) {
            if (/^-\d+$/.test(rest[lr])) maxCount = parseInt(rest[lr].slice(1), 10);
            else if (rest[lr] === '-n') maxCount = parseInt(rest[lr + 1], 10);
            else if (rest[lr].indexOf('--max-count=') === 0) maxCount = parseInt(rest[lr].slice(12), 10);
          }
          if (maxCount !== null && !isNaN(maxCount)) commits = commits.slice(0, maxCount);
          var refsByOid = {};
          g.commits.forEach(function (c) { if (c.refs.length) refsByOid[c.oid] = c.refs; });
          // a detached HEAD points at a commit, not a branch: `(HEAD, main)`
          if (g.detached) refsByOid[g.headOid] = [{ name: 'HEAD' }].concat(refsByOid[g.headOid] || []);
          var remoteHead = await originHead();
          var rhOid = remoteHead ? await trackingOid(remoteHead) : null;
          if (rhOid) refsByOid[rhOid] = (refsByOid[rhOid] || []).concat([{ name: 'origin/HEAD' }]);
          var outLines = [];
          commits.forEach(function (c) {
            var decor = refsByOid[c.oid]
              ? ' {y}(' + refsByOid[c.oid].slice().sort(function (x, y) { return (y.isHead || y.name === 'HEAD') - (x.isHead || x.name === 'HEAD'); })
                  .map(function (r) { return r.isHead ? 'HEAD -> ' + r.name : r.name; }).join(', ') + '){/}'
              : '';
            if (oneline) {
              outLines.push('{y}' + c.oid.slice(0, 7) + '{/}' + decor + ' ' + c.commit.message.split('\n')[0]);
            } else {
              outLines.push('{y}commit ' + c.oid + '{/}' + decor);
              outLines.push('Author: ' + c.commit.author.name + ' <' + c.commit.author.email + '>');
              outLines.push('Date:   ' + gitDate(c.commit.author));
              outLines.push('');
              outLines.push('    ' + c.commit.message.split('\n')[0]);
              outLines.push('');
            }
          });
          return { out: outLines.join('\n'), ok: true };
        }

        case 'branch': {
          var del = false, listAll = false, listRemote = false, upTo = null, unsetUp = false;
          var names = [];
          for (var bi = 0; bi < rest.length; bi++) {
            var ba = rest[bi];
            if (ba === '-d' || ba === '-D' || ba === '--delete') del = true;
            else if (ba === '-a' || ba === '--all') listAll = true;
            else if (ba === '-r' || ba === '--remotes') listRemote = true;
            else if (ba === '-u' || ba === '--set-upstream-to') upTo = rest[++bi] || '';
            else if (ba.indexOf('--set-upstream-to=') === 0) upTo = ba.slice(18);
            else if (ba === '--unset-upstream') unsetUp = true;
            else if (ba.charAt(0) !== '-') names.push(ba);
          }
          var all = await gitlib.listBranches(opts());
          var cur = await currentBranch();
          if (del && listRemote) {
            // `git branch -d -r origin/x` forgets a remote-tracking branch
            var gone = trackingName(names[0] || '');
            var goneOid = gone ? await trackingOid(gone) : null;
            if (!goneOid) return { out: "error: remote-tracking branch '" + (names[0] || '') + "' not found.", ok: false };
            await gitlib.deleteRef(opts({ ref: 'refs/remotes/origin/' + gone }));
            return { out: 'Deleted remote-tracking branch origin/' + gone + ' (was ' + goneOid.slice(0, 7) + ').', ok: true };
          }
          if (del) {
            if (!names.length) return { out: 'fatal: branch name required', ok: false };
            if (names[0] === cur) return { out: "error: cannot delete branch '" + names[0] + "' checked out at '" + displayDir + "'", ok: false };
            if (all.indexOf(names[0]) === -1) return { out: "error: branch '" + names[0] + "' not found.", ok: false };
            var delOid = await gitlib.resolveRef(opts({ ref: names[0] }));
            await gitlib.deleteBranch(opts({ ref: names[0] }));
            await setUpstream(names[0], null);
            return { out: 'Deleted branch ' + names[0] + ' (was ' + delOid.slice(0, 7) + ').', ok: true };
          }
          if (upTo !== null || unsetUp) {
            var forBranch = names[0] || cur;
            if (!forBranch) return { out: 'fatal: could not set upstream of HEAD when it does not point to any branch.', ok: false };
            if (all.indexOf(forBranch) === -1) return { out: "fatal: branch '" + forBranch + "' does not exist", ok: false };
            if (unsetUp) {
              if (!(await upstreamOf(forBranch))) return { out: "fatal: branch '" + forBranch + "' has no upstream information", ok: false };
              await setUpstream(forBranch, null);
              return { out: '', ok: true };
            }
            var upName = trackingName(upTo);
            if (!upName || !(await trackingOid(upName))) {
              return {
                out: "fatal: the requested upstream branch '" + upTo + "' does not exist\n" +
                  'hint:\n' +
                  'hint: If you are planning on basing your work on an upstream\n' +
                  'hint: branch that already exists at the remote, you may need to\n' +
                  'hint: run "git fetch" to retrieve it.\n' +
                  'hint:\n' +
                  'hint: If you are planning to push out a new local branch that\n' +
                  'hint: will track its remote counterpart, you may want to use\n' +
                  'hint: "git push -u" to set the upstream config as you push.',
                ok: false
              };
            }
            await setUpstream(forBranch, upName);
            return { out: "branch '" + forBranch + "' set up to track 'origin/" + upName + "'.", ok: true };
          }
          if (!names.length) {
            var listed = listRemote ? [] : all.map(function (b) { return b === cur ? '{g}* ' + b + '{/}' : '  ' + b; });
            if (!listRemote && !cur && all.length) listed.unshift('{g}* (' + (await headLine()) + '){/}');
            if (listAll || listRemote) {
              var oh = await originHead();
              if (oh) listed.push('  {r}' + (listAll ? 'remotes/' : '') + 'origin/HEAD{/} -> origin/' + oh);
              (await trackingNames()).forEach(function (t) {
                listed.push('  {r}' + (listAll ? 'remotes/' : '') + 'origin/' + t + '{/}');
              });
            }
            return { out: listed.join('\n'), ok: true };
          }
          if (all.indexOf(names[0]) !== -1) return { out: "fatal: a branch named '" + names[0] + "' already exists", ok: false };
          if (names[1]) {
            // `git branch <name> <start-point>`; starting from origin/x tracks it
            var start = await startPoint(names[1]);
            if (!start) return { out: "fatal: not a valid object name: '" + names[1] + "'", ok: false };
            await gitlib.writeRef(opts({ ref: 'refs/heads/' + names[0], value: start.oid }));
            if (start.tracks) {
              await setUpstream(names[0], start.tracks);
              return { out: "branch '" + names[0] + "' set up to track 'origin/" + start.tracks + "'.", ok: true };
            }
            return { out: '', ok: true, silentNote: 'created branch ' + names[0] };
          }
          try { await gitlib.branch(opts({ ref: names[0] })); }
          catch (e) { return { out: 'fatal: ' + e.message, ok: false }; }
          return { out: '', ok: true, silentNote: 'created branch ' + names[0] };
        }

        case 'switch':
        case 'checkout': {
          var create = null, track = false, detach = false, names2 = [];
          for (var si = 0; si < rest.length; si++) {
            var sa = rest[si];
            if (sa === '-b' || sa === '-c' || sa === '--create') {
              create = rest[++si];
              if (!create) return { out: "error: switch `" + sa.replace(/^-+/, '') + "' requires a value", ok: false };
            }
            else if (sa === '-t' || sa === '--track') track = true;
            else if (sa === '--detach' || sa === '-d') detach = true;
            else if (sa === '-' || sa.charAt(0) !== '-') names2.push(sa);
          }
          // `--track origin/x` names the new branch after the remote one
          if (track && !create) {
            if (!names2[0] || !trackingName(names2[0])) {
              return { out: 'fatal: missing branch name; try -' + (sub === 'switch' ? 'c' : 'b'), ok: false };
            }
            create = trackingName(names2[0]);
          }
          if (!create && !names2.length) return { out: 'fatal: missing branch name', ok: false };
          var name = names2[0];
          // `-` is the branch (or commit) you were on before
          if (name === '-' && !create) {
            if (!prevHead) return { out: 'fatal: invalid reference: @{-1}', ok: false };
            name = prevHead;
            // back to a detached commit: checkout does that; switch wants --detach
            if (/^[0-9a-f]{40}$/.test(name) && sub === 'checkout') detach = true;
          }
          var all2 = await gitlib.listBranches(opts());
          var midMerge = await statusModel();
          if (midMerge.conflicted.length) {
            return {
              out: 'error: you need to resolve your current index first\n' +
                midMerge.conflicted.map(function (c) { return c.file + ': needs merge'; }).join('\n'),
              ok: false
            };
          }
          // What to switch to: an existing branch (target2 null), a new
          // branch at newStart, or a commit to detach at (target2).
          var target2 = null, newStart = null;
          if (!create && !detach && all2.indexOf(name) === -1 && await trackingOid(name)) {
            // git's guess: `git switch feature` when only origin/feature exists
            create = name;
            name = 'origin/' + name;
          }
          if (create) {
            if (all2.indexOf(create) !== -1) return { out: "fatal: a branch named '" + create + "' already exists", ok: false };
            if (name) {
              newStart = await startPoint(name);
              if (!newStart) {
                return { out: "fatal: '" + name + "' is not a commit and a branch '" + create + "' cannot be created from it", ok: false };
              }
            }
          } else {
            target2 = all2.indexOf(name) !== -1 && !detach ? null : await resolveCommit(name);
            if (all2.indexOf(name) === -1 && !target2) {
              return { out: (sub === 'switch' ? 'fatal: invalid reference: ' + name
                  : "error: pathspec '" + name + "' did not match any file(s) known to git") +
                '\nhint: use `git ' + sub + ' ' + (sub === 'switch' ? '-c ' : '-b ') + name + '` to create it', ok: false };
            }
            // `git switch` only moves between branches unless told to detach
            if (target2 && sub === 'switch' && !detach) {
              return { out: "fatal: a branch is expected, got commit '" + name + "'\n" +
                'hint: If you want to detach HEAD at the commit, try again with the --detach option.', ok: false };
            }
          }
          var wasBranch = await currentBranch();
          var wasOid = await refOid('HEAD');
          if (create && !newStart) {
            // a new branch right here: nothing to check out, and it works
            // before the first commit too
            if (midMerge.merging) await clearMergeState();
            await gitlib.branch(opts({ ref: create, checkout: true }));
            prevHead = wasBranch || wasOid;
            return { out: "Switched to a new branch '" + create + "'", ok: true };
          }
          var branchTo = create || (target2 ? null : name);
          var newOid = target2 || (newStart ? newStart.oid : await gitlib.resolveRef(opts({ ref: name })));
          var clobbered = midMerge.merging ? [] : await overwrittenBy(newOid, midMerge);
          if (clobbered.length) {
            return { out: 'error: Your local changes to the following files would be overwritten by checkout:\n' +
              clobbered.map(function (f) { return '\t' + f; }).join('\n') + '\n' +
              'Please commit your changes or stash them before you switch branches.\nAborting', ok: false };
          }
          if (branchTo && branchTo === wasBranch) {
            return { out: "Already on '" + branchTo + "'" + prefixLines(await trackingLines(branchTo)), ok: true };
          }
          if (midMerge.merging) await clearMergeState();
          var tracksNote = '';
          if (create) {
            await gitlib.writeRef(opts({ ref: 'refs/heads/' + create, value: newOid }));
            // starting from origin/x sets it as the upstream, as git does
            if (newStart.tracks) {
              await setUpstream(create, newStart.tracks);
              tracksNote = "\nbranch '" + create + "' set up to track 'origin/" + newStart.tracks + "'.";
            }
          }
          // isomorphic-git's checkout rewrites the index and working tree
          // even when the target is the commit we are already on, dropping
          // staged and modified files; real git carries them over, so when
          // nothing differs only HEAD moves
          if (wasOid && wasOid === newOid) {
            await gitlib.writeRef(opts(target2 ? { ref: 'HEAD', value: target2, force: true }
              : { ref: 'HEAD', value: 'refs/heads/' + branchTo, symbolic: true, force: true }));
          } else {
            try { await gitlib.checkout(opts({ ref: target2 || branchTo })); }
            catch (e) { return { out: 'fatal: ' + e.message, ok: false }; }
          }
          prevHead = wasBranch || wasOid;
          var leaving = !wasBranch && wasOid && wasOid !== target2 ? await leavingDetached(wasOid) : '';
          if (create) return { out: leaving + "Switched to a new branch '" + create + "'" + tracksNote, ok: true };
          if (!target2) {
            return { out: leaving + "Switched to branch '" + name + "'" + prefixLines(await trackingLines(name)), ok: true };
          }
          detachPoint = target2;
          var landed = 'HEAD is now at ' + target2.slice(0, 7) + ' ' + await subjectOf(target2);
          if (!wasBranch) return { out: leaving + landed, ok: true };
          return {
            out: "Note: switching to '" + name + "'.\n\n" +
              "{y}You are in 'detached HEAD' state.{/} You can look around, make experimental\n" +
              'changes and commit them, and you can discard any commits you make in this\n' +
              'state without impacting any branches by switching back to a branch.\n\n' +
              'If you want to create a new branch to retain commits you create, you may\n' +
              'do so (now or later) by using -c with the switch command. Example:\n\n' +
              '  git switch -c <new-branch-name>\n\n' +
              'Or undo this operation with:\n\n' +
              '  git switch -\n\n' +
              'Turn off this advice by setting config variable advice.detachedHead to false\n\n' +
              landed,
            ok: true
          };
        }

        case 'merge': {
          var inMerge = await statusModel();
          if (rest[0] === '--abort') {
            if (!inMerge.merging) return { out: 'fatal: There is no merge to abort (MERGE_HEAD missing).', ok: false };
            // back to the last commit, as `git reset --merge` does; files the
            // merge brought in are staged, so the forced checkout drops them
            await gitlib.checkout(opts({ ref: await currentBranch(), force: true }));
            await clearMergeState();
            return { out: '', ok: true };
          }
          if (rest[0] === '--continue') {
            if (!inMerge.merging) return { out: 'fatal: There is no merge in progress (MERGE_HEAD missing).', ok: false };
            return gitCommand(['commit']);
          }
          var unfinished = mergeBlocker(inMerge, 'Merging');
          if (unfinished) return unfinished;
          var theirs = rest.filter(function (a) { return a.charAt(0) !== '-'; })[0];
          if (!theirs) return { out: 'usage: git merge <branch>', ok: false };
          var ours = await currentBranch();
          if (!ours) {
            return { out: 'fatal: this sandbox can only merge into a branch, and HEAD is detached.\n' +
              'Switch to a branch first, or create one here with `git switch -c <name>`.', ok: false };
          }
          if (theirs === ours) return { out: 'Already up to date.', ok: true };
          // a local branch, a remote-tracking branch such as origin/main
          // (what `git fetch` brought in), or any commit
          var known = await gitlib.listBranches(opts());
          var theirRef = null, mergeMsg;
          // git leaves " into main" out of the message (merge.suppressDest)
          var into = ours === 'main' || ours === 'master' ? '' : ' into ' + ours;
          if (known.indexOf(theirs) !== -1) {
            theirRef = theirs;
            mergeMsg = "Merge branch '" + theirs + "'" + into;
          } else if (trackingName(theirs) && await trackingOid(trackingName(theirs))) {
            theirRef = 'refs/remotes/origin/' + trackingName(theirs);
            mergeMsg = "Merge remote-tracking branch '" + theirs + "'" + into;
          } else {
            theirRef = await resolveCommit(theirs);
            mergeMsg = "Merge commit '" + theirs + "'" + into;
          }
          if (!theirRef) return { out: 'merge: ' + theirs + ' - not something we can merge', ok: false };
          var oursBefore = await gitlib.resolveRef(opts({ ref: ours }));
          var result;
          try {
            result = await mergeInto(ours, theirRef, theirs, mergeMsg);
          } catch (e) {
            return { out: 'fatal: ' + e.message, ok: false };
          }
          if (result.conflict) return result.conflict;
          if (result.alreadyMerged) return { out: 'Already up to date.', ok: true };
          if (result.fastForward) return { out: 'Updating ' + oursBefore.slice(0, 7) + '..' + (result.oid || '').slice(0, 7) + '\nFast-forward', ok: true };
          return { out: "Merge made by the 'ort' strategy.", ok: true };
        }

        case 'remote': {
          var linked = await originUrl();
          if (rest[0] === 'add') {
            if (!rest[1] || !rest[2]) return { out: 'usage: git remote add <name> <url>', ok: false };
            if (rest[1] !== 'origin') {
              return { out: 'This sandbox has a single remote, and it must be called origin:\n' +
                '  git remote add origin ' + rest[2], ok: false };
            }
            if (linked) return { out: 'error: remote origin already exists.', ok: false };
            // the first `remote add` creates the mock remote; after that
            // (say, in a fresh `git init`) it only links to it again
            if (!remoteUrl) {
              await gitlib.init({ fs: fs, gitdir: remoteGitdir, bare: true, defaultBranch: defaultBranch });
              remoteUrl = rest[2];
            }
            await gitlib.addRemote(opts({ remote: 'origin', url: rest[2] }));
            return { out: '', ok: true };
          }
          if (rest[0] === 'remove' || rest[0] === 'rm') {
            if (rest[1] !== 'origin' || !linked) return { out: "error: No such remote: '" + (rest[1] || '') + "'", ok: false };
            await gitlib.deleteRemote(opts({ remote: 'origin' }));
            await fs.promises.rm(dir + '/.git/refs/remotes/origin', { recursive: true, force: true });
            return { out: '', ok: true };
          }
          if (!rest.length) return { out: linked ? 'origin' : '', ok: true };
          if (rest[0] === '-v') {
            if (!linked) return { out: '', ok: true };
            return { out: 'origin\t' + linked + ' (fetch)\norigin\t' + linked + ' (push)', ok: true };
          }
          return { out: 'usage: git remote [-v] | git remote add origin <url> | git remote remove origin', ok: false };
        }

        case 'clone': {
          var cargs = rest.filter(function (a) { return a.charAt(0) !== '-'; });
          var curl = cargs[0];
          if (!curl) return { out: 'fatal: You must specify a repository to clone.\n\n' + HELP.clone.join('\n'), ok: false };
          if (cargs[1] && cargs[1] !== '.') {
            return { out: 'This sandbox keeps the repository in the project folder itself,\n' +
              'so `git clone <url>` clones into it, as `git clone <url> .` would.', ok: false };
          }
          if (cwd !== dir) {
            return { out: 'This sandbox keeps the repository at the top of the project.\nRun `cd ~` first, then `git clone`.', ok: false };
          }
          if (!remoteUrl || urlKey(curl) !== urlKey(remoteUrl)) {
            return { out: "fatal: repository '" + curl + "' does not exist" +
              (remoteUrl ? "\nhint: this exercise's remote is " + remoteUrl : ''), ok: false };
          }
          if ((await isRepo()) || (await fs.promises.readdir(dir)).length) {
            return { out: "fatal: destination path '.' already exists and is not an empty directory.", ok: false };
          }
          var rbranches = await listRemoteBranchNames();
          var rhead = await remoteDefault();
          if (rbranches.indexOf(rhead) === -1) rhead = rbranches[0] || rhead || defaultBranch;
          await gitlib.init(opts({ defaultBranch: rhead }));
          await gitlib.addRemote(opts({ remote: 'origin', url: curl }));
          detachPoint = null;
          prevHead = null;
          if (!rbranches.length) {
            return { out: "Cloning into '.'...\nwarning: You appear to have cloned an empty repository.", ok: true };
          }
          await copyObjects(remoteGitdir, dir + '/.git');
          for (var cb = 0; cb < rbranches.length; cb++) await setTrackingRef(rbranches[cb], await remoteBranchOid(rbranches[cb]));
          // like git: one local branch, the remote's default, tracking it
          await gitlib.writeRef(opts({ ref: 'refs/heads/' + rhead, value: await remoteBranchOid(rhead) }));
          await gitlib.writeRef(opts({ ref: 'refs/remotes/origin/HEAD', value: 'refs/remotes/origin/' + rhead, symbolic: true }));
          await setUpstream(rhead, rhead);
          await gitlib.checkout(opts({ ref: rhead }));
          return { out: "Cloning into '.'...\ndone.", ok: true };
        }

        case 'push': {
          var pushUrl = await originUrl();
          if (!pushUrl) return { out: 'fatal: No configured push destination.\nAdd a remote first: git remote add origin <url>', ok: false };
          var setUp = rest.indexOf('-u') !== -1 || rest.indexOf('--set-upstream') !== -1;
          var words = rest.filter(function (a) { return a.charAt(0) !== '-'; });
          if (words[0] && words[0] !== 'origin') return { out: "fatal: '" + words[0] + "' does not appear to be a git repository", ok: false };
          var pbr = words[1] || (await currentBranch());
          if (!pbr) return { out: 'fatal: you are not currently on a branch.', ok: false };
          var locals = await gitlib.listBranches(opts());
          if (locals.indexOf(pbr) === -1) return { out: 'error: src refspec ' + pbr + ' does not match any', ok: false };
          if (!words[1] && !(await upstreamOf(pbr))) {
            return {
              out: 'fatal: The current branch ' + pbr + ' has no upstream branch.\n' +
                   'To push the current branch and set the remote as upstream, use\n\n' +
                   '    git push -u origin ' + pbr,
              ok: false
            };
          }
          var localOid = await gitlib.resolveRef(opts({ ref: pbr }));
          var remoteOid = await remoteBranchOid(pbr);
          var upNote = '';
          if (setUp && (await upstreamOf(pbr)) !== pbr) {
            await setUpstream(pbr, pbr);
            upNote = "branch '" + pbr + "' set up to track 'origin/" + pbr + "'.";
          }
          if (remoteOid === localOid) return { out: (upNote ? upNote + '\n' : '') + 'Everything up-to-date', ok: true };
          if (remoteOid) {
            // only fast-forward pushes are allowed, like a real remote
            var pushedSet = await reachableFrom(localOid, opts);
            if (!pushedSet[remoteOid]) {
              return {
                out: 'To ' + pushUrl + '\n' +
                     ' {r}! [rejected]{/}        ' + pbr + ' -> ' + pbr + ' (fetch first)\n' +
                     'hint: Updates were rejected because the remote contains work that you do\n' +
                     'hint: not have locally. Pull the remote changes ({y}git pull{/}) before pushing again.',
                ok: false
              };
            }
          }
          await copyObjects(dir + '/.git', remoteGitdir);
          await fs.promises.mkdir(remoteGitdir + '/refs/heads', { recursive: true });
          await fs.promises.writeFile(remoteGitdir + '/refs/heads/' + pbr, localOid + '\n');
          await setTrackingRef(pbr, localOid);
          var pushOut = ['To ' + pushUrl];
          pushOut.push(remoteOid
            ? '   ' + remoteOid.slice(0, 7) + '..' + localOid.slice(0, 7) + '  ' + pbr + ' -> ' + pbr
            : ' * [new branch]      ' + pbr + ' -> ' + pbr);
          if (upNote) pushOut.push(upNote);
          return { out: pushOut.join('\n'), ok: true };
        }

        case 'fetch': {
          var fetchUrl = await originUrl();
          if (!fetchUrl) return { out: "fatal: 'origin' does not appear to be a git repository", ok: false };
          var rnames = await listRemoteBranchNames();
          await copyObjects(remoteGitdir, dir + '/.git');
          var updated = [];
          for (var fi = 0; fi < rnames.length; fi++) {
            var rOid = await remoteBranchOid(rnames[fi]);
            var cur = await refOid('refs/remotes/origin/' + rnames[fi]);
            if (cur === rOid) continue;
            await setTrackingRef(rnames[fi], rOid);
            updated.push(cur
              ? '   ' + cur.slice(0, 7) + '..' + rOid.slice(0, 7) + '  ' + rnames[fi] + '       -> origin/' + rnames[fi]
              : ' * [new branch]      ' + rnames[fi] + '       -> origin/' + rnames[fi]);
          }
          // like git 2.48+, the first fetch also records which branch is the
          // remote's default, as origin/HEAD (silently)
          if (!(await originHead())) {
            var rhead = await remoteDefault();
            if (rhead && rnames.indexOf(rhead) !== -1) {
              await gitlib.writeRef(opts({ ref: 'refs/remotes/origin/HEAD', value: 'refs/remotes/origin/' + rhead, symbolic: true, force: true }));
            }
          }
          if (!updated.length) return { out: '', ok: true };
          return { out: ['From ' + fetchUrl].concat(updated).join('\n'), ok: true };
        }

        case 'pull': {
          var pullUrl = await originUrl();
          if (!pullUrl) return { out: "fatal: 'origin' does not appear to be a git repository", ok: false };
          if (rest.indexOf('--rebase') !== -1 || rest.indexOf('-r') !== -1) {
            return { out: 'This sandbox has no rebase, so `git pull` always merges.\nRun `git pull` without --rebase.', ok: false };
          }
          var unfinished2 = mergeBlocker(await statusModel(), 'Pulling');
          if (unfinished2) return unfinished2;
          var lbr = await currentBranch();
          if (!lbr) return { out: 'fatal: you are not currently on a branch.', ok: false };
          var pwords = rest.filter(function (a) { return a.charAt(0) !== '-'; });
          if (pwords[0] && pwords[0] !== 'origin') {
            return { out: "fatal: '" + pwords[0] + "' does not appear to be a git repository\n" +
              'fatal: Could not read from remote repository.\n\n' +
              'Please make sure you have the correct access rights\nand the repository exists.', ok: false };
          }
          // `git pull origin <branch>` names the branch; plain `git pull`
          // takes the upstream that `push -u`, `clone` or `--track` set
          var fromBranch = pwords[1] || await upstreamOf(lbr);
          var fetched = await gitCommand(['fetch']);
          var prefix2 = fetched.out ? fetched.out + '\n' : '';
          if (!fromBranch) {
            return {
              out: prefix2 + (pwords[0]
                ? "You asked to pull from the remote 'origin', but did not specify\n" +
                  'a branch. Because this is not the default configured remote\n' +
                  'for your current branch, you must specify a branch on the command line.'
                : 'There is no tracking information for the current branch.\n' +
                  'Please specify which branch you want to merge with.\n' +
                  'See git-pull(1) for details.\n\n' +
                  '    git pull <remote> <branch>\n\n' +
                  'If you wish to set tracking information for this branch you can do so with:\n\n' +
                  '    git branch --set-upstream-to=origin/<branch> ' + lbr),
              ok: false
            };
          }
          var theirOid = await remoteBranchOid(fromBranch);
          if (!theirOid) return { out: prefix2 + "fatal: couldn't find remote ref " + fromBranch, ok: false };
          var oursOid = await gitlib.resolveRef(opts({ ref: lbr }));
          if (theirOid === oursOid) return { out: prefix2 + 'Already up to date.', ok: true };
          var pres;
          try {
            pres = await mergeInto(lbr, 'refs/remotes/origin/' + fromBranch, 'origin/' + fromBranch,
              "Merge branch '" + fromBranch + "' of " + pullUrl);
          } catch (e) {
            return { out: prefix2 + 'fatal: ' + e.message, ok: false };
          }
          if (pres.conflict) {
            pres.conflict.out = prefix2 + pres.conflict.out;
            return pres.conflict;
          }
          if (pres.alreadyMerged) return { out: prefix2 + 'Already up to date.', ok: true };
          if (pres.fastForward) return { out: prefix2 + 'Updating ' + oursOid.slice(0, 7) + '..' + theirOid.slice(0, 7) + '\nFast-forward', ok: true };
          return { out: prefix2 + "Merge made by the 'ort' strategy.", ok: true };
        }

        case 'diff': {
          var st3 = await statusModel();
          // a conflicted file shows its markers against the last commit
          var diffFiles = st3.modified.concat(st3.conflicted
            .filter(function (c) { return c.kind === 'both modified'; })
            .map(function (c) { return c.file; })).sort();
          if (!diffFiles.length) return { out: '', ok: true };
          var chunks = [];
          for (var d = 0; d < diffFiles.length; d++) {
            var file = diffFiles[d];
            var headOid = await gitlib.resolveRef(opts({ ref: 'HEAD' }));
            var blob = await gitlib.readBlob(opts({ oid: headOid, filepath: file }));
            var oldTxt = new TextDecoder().decode(blob.blob);
            var newTxt = await fs.promises.readFile(dir + '/' + file, 'utf8');
            chunks.push('{w}diff --git a/' + file + ' b/' + file + '{/}');
            chunks.push(simpleDiff(oldTxt, newTxt));
          }
          return { out: chunks.join('\n'), ok: true };
        }

        case 'reset': {
          var mode = null;
          var before = [], after = [], seenDashes = false;
          for (var ra = 0; ra < rest.length; ra++) {
            var a1 = rest[ra];
            if (seenDashes) { after.push(a1); continue; }
            if (a1 === '--') { seenDashes = true; continue; }
            if (a1 === '--soft' || a1 === '--mixed' || a1 === '--hard') { mode = a1.slice(2); continue; }
            if (a1 === '--merge' || a1 === '--keep') { mode = 'hard'; continue; }
            if (a1.charAt(0) === '-') continue;
            before.push(a1);
          }
          // the first word may name a commit; everything else is a path
          var resetTo = null;
          if (before.length) {
            resetTo = await resolveCommit(before[0]);
            if (resetTo) before.shift();
          }
          var resetPaths = before.concat(after);
          var headNow = await refOid('HEAD');
          if (resetPaths.length) {
            // a word before `--` that is neither a commit nor a known path
            if (!seenDashes && !(await knownPath(before[0] || resetPaths[0]))) return ambiguous(before[0] || resetPaths[0]);
            if (mode === 'soft' || mode === 'hard') {
              return { out: 'fatal: Cannot do ' + mode + ' reset with paths.', ok: false };
            }
            return unstagePaths(resetPaths, resetTo || headNow, 'reset');
          }
          if (!headNow) {
            // nothing committed yet: emptying the staging area is all a reset can do
            var staged0 = await gitlib.listFiles(opts());
            for (var s0 = 0; s0 < staged0.length; s0++) await gitlib.remove(opts({ filepath: staged0[s0] }));
            return { out: '', ok: true };
          }
          return resetTo2(resetTo || headNow, mode || 'mixed');
        }

        case 'restore': {
          var staged = false, worktree = false, source = null, rPaths = [], dashes2 = false;
          for (var rs = 0; rs < rest.length; rs++) {
            var a2 = rest[rs];
            if (dashes2) { rPaths.push(a2); continue; }
            if (a2 === '--') { dashes2 = true; continue; }
            if (a2 === '--staged' || a2 === '-S') staged = true;
            else if (a2 === '--worktree' || a2 === '-W') worktree = true;
            else if (a2 === '-SW' || a2 === '-WS') { staged = true; worktree = true; }
            else if (a2 === '-s' || a2 === '--source') source = rest[++rs];
            else if (a2.indexOf('--source=') === 0) source = a2.slice(9);
            else if (a2.indexOf('-s') === 0 && a2.length > 2) source = a2.slice(2);
            else if (a2.charAt(0) !== '-') rPaths.push(a2);
          }
          if (!staged) worktree = true;
          if (!rPaths.length) return { out: 'fatal: you must specify path(s) to restore', ok: false };
          var sourceOid = null;
          if (source) {
            sourceOid = await resolveCommit(source);
            if (!sourceOid) return { out: 'fatal: could not resolve ' + source, ok: false };
          }
          var unresolved = (await statusModel()).conflicted.map(function (c) { return c.file; });
          var headOid2 = await refOid('HEAD');
          if (staged) {
            // before the first commit, unstaging takes the file out of the index
            var unstaged = await unstagePaths(rPaths, sourceOid || headOid2, 'restore');
            if (!unstaged.ok || !worktree) return unstaged.ok ? { out: '', ok: true } : unstaged;
          }
          // the working copy comes back from the source commit if one was
          // given (or with --staged, from HEAD), else from the staging area
          var fromCommit = sourceOid || (staged ? headOid2 : null);
          var known = fromCommit ? await flatTree(fromCommit) : await indexEntries();
          var inIndexNow = await indexEntries();
          var targets = [];
          for (var rp = 0; rp < rPaths.length; rp++) {
            var rm2 = pathspec(rPaths[rp]);
            var pool = Object.keys(known);
            // with a source, files the source lacks are removed again
            if (fromCommit) Object.keys(inIndexNow).forEach(function (f) { if (pool.indexOf(f) === -1) pool.push(f); });
            var rh = rm2 ? pool.filter(rm2) : [];
            if (!rh.length) return { out: "error: pathspec '" + rPaths[rp] + "' did not match any file(s) known to git", ok: false };
            for (var u = 0; u < rh.length; u++) {
              if (unresolved.indexOf(rh[u]) !== -1) return { out: "error: path '" + rh[u] + "' is unmerged", ok: false };
              if (targets.indexOf(rh[u]) === -1) targets.push(rh[u]);
            }
          }
          for (var t = 0; t < targets.length; t++) {
            var where = dir + '/' + targets[t];
            if (!known[targets[t]]) { await removeFileAndEmptyParents(where); continue; }
            var bytes = (await gitlib.readBlob(opts({ oid: known[targets[t]] }))).blob;
            await fs.promises.mkdir(fs._dirname(where), { recursive: true });
            await fs.promises.writeFile(where, bytes);
          }
          return { out: '', ok: true };
        }

        case 'help':
          return { out: usageGit(), ok: true };

        default:
          return { out: "git: '" + sub + "' is not supported in this sandbox.\n" + usageGit(), ok: false };
      }
    }

    // Line-by-line diff as data: [{ t: ' '|'+'|'-', text, a, b }] where a/b
    // are 1-based line numbers in the old/new file (absent on the other side).
    function diffLines(oldTxt, newTxt) {
      var a = oldTxt.split('\n'), b = newTxt.split('\n');
      var out = [];
      var i = 0, j = 0;
      while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ t: ' ', text: a[i], a: i + 1, b: j + 1 }); i++; j++; }
        else if (j < b.length && (i >= a.length || a.indexOf(b[j], i) === -1)) { out.push({ t: '+', text: b[j], b: j + 1 }); j++; }
        else if (i < a.length) { out.push({ t: '-', text: a[i], a: i + 1 }); i++; }
        else break;
      }
      return out;
    }

    // A commit's date as `git log` prints it: "Thu Oct 22 21:36:29 2026 +0000",
    // in the author's own timezone. isomorphic-git stores the offset the way
    // Date#getTimezoneOffset does, in minutes and with the sign flipped.
    function gitDate(who) {
      var off = -(who.timezoneOffset || 0);
      var d = new Date((who.timestamp + off * 60) * 1000);
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var a = Math.abs(off);
      return days[d.getUTCDay()] + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCDate() + ' ' +
        pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' ' +
        d.getUTCFullYear() + ' ' + (off < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + pad(a % 60);
    }

    function simpleDiff(oldTxt, newTxt) {
      return diffLines(oldTxt, newTxt).map(function (l) {
        if (l.t === '+') return '{g}+' + l.text + '{/}';
        if (l.t === '-') return '{r}-' + l.text + '{/}';
        return ' ' + l.text;
      }).join('\n');
    }

    // Working directory vs the last commit, structured for rendering:
    // { files: [{ file, kind: 'new'|'modified'|'deleted', lines: [...] }] }
    // or null when there is no repository yet.
    async function diffModel() {
      if (!(await isRepo())) return null;
      var headOid = await refOid('HEAD');
      var matrix = await gitlib.statusMatrix(opts());
      var files = [];
      for (var r = 0; r < matrix.length; r++) {
        var file = matrix[r][0], head = matrix[r][1], workdir = matrix[r][2];
        if (head === workdir) continue;                       // unchanged or absent
        var kind = head === 0 ? 'new' : (workdir === 0 ? 'deleted' : 'modified');
        var oldTxt = '', newTxt = '';
        if (head === 1 && headOid) {
          var blob = await gitlib.readBlob(opts({ oid: headOid, filepath: file }));
          oldTxt = new TextDecoder().decode(blob.blob);
        }
        if (workdir !== 0) newTxt = await fs.promises.readFile(dir + '/' + file, 'utf8');
        files.push({ file: file, kind: kind, lines: fileDiff(kind, oldTxt, newTxt) });
      }
      return { files: files };
    }

    // One file's lines for the diff views; kind is 'new', 'modified' or
    // 'deleted'. One trailing newline per side is dropped so the panel never
    // shows a phantom blank last line.
    function fileDiff(kind, oldTxt, newTxt) {
      oldTxt = oldTxt.replace(/\n$/, '');
      newTxt = newTxt.replace(/\n$/, '');
      if (kind === 'new') return newTxt.split('\n').map(function (t, k) { return { t: '+', text: t, b: k + 1 }; });
      if (kind === 'deleted') return oldTxt.split('\n').map(function (t, k) { return { t: '-', text: t, a: k + 1 }; });
      return diffLines(oldTxt, newTxt);
    }

    // path -> blob oid for every file in a commit's tree
    async function flatTree(commitOid) {
      var out = {};
      async function walkTree(treeOid, prefix) {
        var t = await gitlib.readTree(opts({ oid: treeOid }));
        for (var i = 0; i < t.tree.length; i++) {
          var e = t.tree[i];
          if (e.type === 'tree') await walkTree(e.oid, prefix + e.path + '/');
          else if (e.type === 'blob') out[prefix + e.path] = e.oid;
        }
      }
      var c = await gitlib.readCommit(opts({ oid: commitOid }));
      await walkTree(c.commit.tree, '');
      return out;
    }

    async function blobText(oid) {
      var b = await gitlib.readBlob(opts({ oid: oid }));
      if (b.blob.indexOf(0) !== -1) return null;
      try { return new TextDecoder('utf-8', { fatal: true }).decode(b.blob); }
      catch (e) { return null; }
    }

    // What `git show` would tell you about one commit: who, when, the full
    // message, and what it changed. A merge commit is compared with its
    // first parent, as `git show --first-parent` does, so it lists what the
    // merge brought in. files: [{ file, kind, lines, binary }].
    async function commitDetails(oid) {
      var c = await gitlib.readCommit(opts({ oid: oid }));
      var parents = c.commit.parent || [];
      var mine = await flatTree(oid);
      var theirs = parents.length ? await flatTree(parents[0]) : {};
      var paths = {};
      Object.keys(mine).concat(Object.keys(theirs)).forEach(function (p) { paths[p] = true; });
      var files = [];
      var sorted = Object.keys(paths).sort();
      for (var i = 0; i < sorted.length; i++) {
        var f = sorted[i];
        if (mine[f] === theirs[f]) continue;
        var kind = !theirs[f] ? 'new' : (!mine[f] ? 'deleted' : 'modified');
        var oldTxt = theirs[f] ? await blobText(theirs[f]) : '';
        var newTxt = mine[f] ? await blobText(mine[f]) : '';
        if (oldTxt === null || newTxt === null) { files.push({ file: f, kind: kind, lines: [], binary: true }); continue; }
        files.push({ file: f, kind: kind, lines: fileDiff(kind, oldTxt, newTxt) });
      }
      var a = c.commit.author;
      return {
        oid: oid, short: oid.slice(0, 7), parents: parents,
        author: a.name, email: a.email, timestamp: a.timestamp,
        message: (c.commit.message || '').replace(/\n+$/, ''),
        files: files
      };
    }

    function usageGit() {
      return [
        'Supported git commands in this sandbox:',
        '  git init                      git status',
        '  git add <file> | .            git commit [-a] -m "message"',
        '  git restore [--staged] <file> git reset [<file>]',
        '  git reset [--hard] <commit>',
        '  git rm [--cached] <file>      git check-ignore <file>',
        '  git log [--oneline]           git diff',
        '  git branch [name] [-d name]   git checkout [-b] <branch>',
        '  git checkout <commit>         git switch --detach <commit>',
        '  git switch [-c] <branch>      git merge <branch> | --abort',
        '  git remote add origin <url>   git push [-u origin <branch>]',
        '  git fetch                     git pull',
        '  git clone <url>',
        '  git config user.name "..."'
      ].join('\n');
    }

    /* ------------------------- shell commands ---------------------- */

    async function shellCommand(cmd, args, redirect, target) {
      switch (cmd) {
        case 'ls': {
          var showAll = args.indexOf('-a') !== -1 || args.indexOf('-la') !== -1 || args.indexOf('-al') !== -1;
          var lsArgs = args.filter(function (a) { return a.charAt(0) !== '-'; });
          if (!lsArgs.length) lsArgs = [null];
          // like ls: files named on the line first, then each folder's contents
          var lsFiles = [], lsDirs = [], lsErrs = [];
          for (var la = 0; la < lsArgs.length; la++) {
            var ls1;
            try { ls1 = await fs.promises.stat(abs(lsArgs[la])); }
            catch (e) { lsErrs.push('ls: ' + lsArgs[la] + ': No such file or directory'); continue; }
            if (ls1.isDirectory()) lsDirs.push(lsArgs[la]); else lsFiles.push(lsArgs[la]);
          }
          var blocks = lsFiles.length ? [lsFiles.join('  ')] : [];
          for (var ld = 0; ld < lsDirs.length; ld++) {
            var lsDir = abs(lsDirs[ld]);
            var entries = await fs.promises.readdir(lsDir);
            if (!showAll) entries = entries.filter(function (e) { return e.charAt(0) !== '.'; });
            var marked = [];
            for (var i = 0; i < entries.length; i++) {
              var s = await fs.promises.stat(lsDir + '/' + entries[i]);
              marked.push(s.isDirectory() ? '{b}' + entries[i] + '/{/}' : entries[i]);
            }
            var heading = lsArgs.length > 1 ? lsDirs[ld] + ':\n' : '';
            if (heading || marked.length) blocks.push(heading + marked.join('  '));
          }
          var lsOut = lsErrs.concat(blocks).join('\n\n');
          return { out: lsOut, ok: !lsErrs.length };
        }
        case 'cat': {
          if (!args.length) return { out: 'usage: cat <file>', ok: false };
          var txt = '';
          for (var ci = 0; ci < args.length; ci++) {
            try { txt += await fs.promises.readFile(abs(args[ci]), 'utf8'); }
            catch (e) { return { out: (txt ? txt.replace(/\n$/, '') + '\n' : '') + 'cat: ' + args[ci] + ': No such file or directory', ok: false }; }
          }
          return { out: txt.replace(/\n$/, ''), ok: true };
        }
        case 'echo': {
          var text = args.join(' ');
          if (redirect && target) {
            var p = abs(target);
            var prev = '';
            if (redirect === '>>') { try { prev = await fs.promises.readFile(p, 'utf8'); } catch (e) {} }
            await fs.promises.writeFile(p, prev + text + '\n');
            return { out: '', ok: true, silentNote: 'wrote ' + rel(target) };
          }
          return { out: text, ok: true };
        }
        case 'touch': {
          if (!args.length) return { out: 'usage: touch <file>', ok: false };
          for (var t = 0; t < args.length; t++) {
            var pt = abs(args[t]);
            try { await fs.promises.stat(pt); }
            catch (e) { await fs.promises.writeFile(pt, ''); }
          }
          return { out: '', ok: true, silentNote: 'touched ' + args.join(' ') };
        }
        case 'rm': {
          var rmFlags = args.filter(function (a) { return /^-[a-zA-Z]+$/.test(a); }).join('');
          var rmRecursive = /[rR]/.test(rmFlags), rmForce = /f/.test(rmFlags);
          var files = args.filter(function (a) { return a.charAt(0) !== '-'; });
          if (!files.length) return rmForce ? { out: '', ok: true } : { out: 'usage: rm [-rf] <file>...', ok: false };
          var rmErrs = [];
          for (var r = 0; r < files.length; r++) {
            var rp = abs(files[r]);
            // the project folder itself, or anything outside it (where the
            // mock remote lives), is off limits
            if (rp === dir || !insideProject(rp)) { rmErrs.push("rm: refusing to remove '" + files[r] + "'"); continue; }
            var rst = null;
            try { rst = await fs.promises.stat(rp); } catch (e) {}
            if (!rst) { if (!rmForce) rmErrs.push("rm: cannot remove '" + files[r] + "': No such file or directory"); continue; }
            if (rst.isDirectory() && !rmRecursive) { rmErrs.push("rm: cannot remove '" + files[r] + "': Is a directory"); continue; }
            await fs.promises.rm(rp, { recursive: true });
          }
          return { out: rmErrs.join('\n'), ok: !rmErrs.length };
        }
        case 'mkdir': {
          if (!args.length) return { out: 'usage: mkdir <dir>', ok: false };
          await fs.promises.mkdir(abs(args[args.length - 1]), { recursive: true });
          return { out: '', ok: true };
        }
        case 'pwd':
          return { out: displayCwd(), ok: true };
        case 'cd': {
          var to = args[0];
          var dest;
          // `~` is the project root: the prompt shows it as ~/project, and
          // there is nothing above it to visit.
          if (!to || to === '~' || to === '~/') dest = dir;
          else if (to === '-') dest = prevCwd;
          else if (to.indexOf('~/') === 0) dest = fs._norm(dir + '/' + to.slice(2));
          else dest = abs(to);
          if (!insideProject(dest)) {
            return { out: 'cd: ' + to + ': this sandbox only has the project folder.\nUse `cd ~` to get back to its top.', ok: false };
          }
          var dst;
          try { dst = await fs.promises.stat(dest); }
          catch (e) { return { out: 'cd: ' + to + ': No such file or directory', ok: false }; }
          if (!dst.isDirectory()) return { out: 'cd: ' + to + ': Not a directory', ok: false };
          prevCwd = cwd;
          cwd = dest;
          return { out: to === '-' ? displayCwd() : '', ok: true };
        }
        // Authoring helper for seeds: move the current branch back n commits
        // (first parent), so a previously-pushed commit exists only on the
        // remote — the "colleague pushed while you were away" setup.
        case 'rewind': {
          var back = parseInt(args[0] || '1', 10);
          if (!(back > 0)) return { out: 'usage: rewind <n>', ok: false };
          var rbr = await currentBranch();
          if (!rbr) return { out: 'rewind: not on a branch', ok: false };
          var roid = await gitlib.resolveRef(opts({ ref: rbr }));
          for (var rw = 0; rw < back; rw++) {
            var rc = await gitlib.readCommit(opts({ oid: roid }));
            var rp = rc.commit.parent || [];
            if (!rp.length) return { out: 'rewind: not enough history to rewind ' + back, ok: false };
            roid = rp[0];
          }
          await gitlib.writeRef(opts({ ref: 'refs/heads/' + rbr, value: roid, force: true }));
          // keep the tracking ref in step so the learner discovers the newer
          // remote commits with `git fetch`, not automatically
          if (await trackingOid(rbr)) await setTrackingRef(rbr, roid);
          await gitlib.checkout(opts({ ref: rbr, force: true }));
          return { out: '', ok: true, silentNote: 'rewound ' + rbr + ' by ' + back };
        }
        case 'whoami':
          return { out: author.name + ' <' + author.email + '>', ok: true };
        default:
          return null;
      }
    }

    /* ---------------------------- dispatch -------------------------- */

    async function run(line) {
      line = String(line || '').trim();
      if (!line) return { out: '', ok: true, kind: 'empty' };

      var words;
      try { words = tokenizeWords(line); }
      catch (e) { return { out: 'sh: ' + e.message, ok: false, kind: 'error' }; }

      await ensureWorkdir();
      await ensureCwd();

      var tokens = [];
      for (var w = 0; w < words.length; w++) {
        var afterRedirect = w > 0 && (words[w - 1].text === '>' || words[w - 1].text === '>>');
        var expanded = words[w].glob && !afterRedirect ? await expandGlob(words[w].text) : null;
        if (expanded) tokens = tokens.concat(expanded);
        else tokens.push(words[w].text);
      }

      var parsed = splitRedirect(tokens);
      var args = parsed.args;
      var cmd = args[0];

      try {
        if (cmd === 'git') {
          var r = await gitCommand(args.slice(1));
          r.kind = 'git';
          // a checkout or merge may have removed the folder we are in
          await ensureCwd();
          return await redirectOutput(r, parsed);
        }
        var sh = await shellCommand(cmd, args.slice(1), parsed.redirect, parsed.target);
        if (sh) {
          sh.kind = 'shell';
          return cmd === 'echo' ? sh : await redirectOutput(sh, parsed);
        }
        return {
          out: cmd + ': command not found\nType `help` to see what this sandbox supports.',
          ok: false, kind: 'error'
        };
      } catch (e) {
        return { out: 'error: ' + (e && e.message ? e.message : String(e)), ok: false, kind: 'error' };
      }
    }

    // `command > file` / `>> file`: what the command printed goes into the
    // file instead of the terminal, as in a shell. Errors stay on screen,
    // as stderr would; `echo` handles its own redirection.
    async function redirectOutput(r, parsed) {
      if (!parsed.redirect || r.editor) return r;
      if (!parsed.target) return { out: 'sh: syntax error near unexpected token `newline\'', ok: false, kind: 'error' };
      if (!r.ok) return r;
      var p = abs(parsed.target);
      var text = r.out ? String(r.out).replace(/\{[gryb\/w]\}/g, '') + '\n' : '';
      var prev = '';
      if (parsed.redirect === '>>') { try { prev = await fs.promises.readFile(p, 'utf8'); } catch (e) {} }
      try { await fs.promises.writeFile(p, prev + text); }
      catch (e) { return { out: 'sh: ' + parsed.target + ': No such file or directory', ok: false, kind: r.kind }; }
      return { out: '', ok: true, kind: r.kind, silentNote: 'wrote ' + rel(parsed.target) };
    }

    /* ------------------------- undo snapshots ------------------------ */

    // Everything a command can change lives in the in-memory store (working
    // files, .git, the bare mock remote) plus a few closure variables, so a
    // full state snapshot is a clone of both. Repos here are a few KB, so
    // cloning per command is cheap.
    function cloneStore(src) {
      var out = new Map();
      src.forEach(function (node, key) {
        var copy = {};
        for (var k in node) copy[k] = node[k];
        if (node.content instanceof Uint8Array) copy.content = new Uint8Array(node.content);
        out.set(key, copy);
      });
      return out;
    }

    function snapshot() {
      return {
        store: cloneStore(fs._store),
        remoteUrl: remoteUrl,
        prevHead: prevHead,
        merges: mergesDone.map(function (m) { return { from: m.from, into: m.into }; }),
        author: { name: author.name, email: author.email },
        globalConfig: JSON.parse(JSON.stringify(globalConfig)),
        repoReady: repoReady,
        cwd: cwd,
        prevCwd: prevCwd
      };
    }

    function restore(snap) {
      var cloned = cloneStore(snap.store);
      // mutate the existing store so every closure holding `fs` stays valid
      fs._store.clear();
      cloned.forEach(function (v, k) { fs._store.set(k, v); });
      remoteUrl = snap.remoteUrl;
      prevHead = snap.prevHead || null;
      mergesDone = snap.merges.map(function (m) { return { from: m.from, into: m.into }; });
      author = { name: snap.author.name, email: snap.author.email };
      globalConfig = JSON.parse(JSON.stringify(snap.globalConfig || {}));
      repoReady = snap.repoReady;
      cwd = snap.cwd || dir;
      prevCwd = snap.prevCwd || dir;
    }

    // Did anything meaningful change since the snapshot? Compares content,
    // not mtimes, so rewriting a file with identical bytes does not count.
    function changedSince(snap) {
      if (remoteUrl !== snap.remoteUrl) return true;
      if (mergesDone.length !== snap.merges.length) return true;
      if (author.name !== snap.author.name || author.email !== snap.author.email) return true;
      if (JSON.stringify(globalConfig) !== JSON.stringify(snap.globalConfig || {})) return true;
      if (fs._store.size !== snap.store.size) return true;
      var diff = false;
      fs._store.forEach(function (node, key) {
        if (diff) return;
        var old = snap.store.get(key);
        if (!old || old.type !== node.type) { diff = true; return; }
        var a = node.content, b = old.content;
        if (!a !== !b) { diff = true; return; }
        if (a && b) {
          if (a.length !== b.length) { diff = true; return; }
          for (var i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) { diff = true; return; }
          }
        }
      });
      return diff;
    }

    async function reset(seed) {
      fs = createMemFS();
      repoReady = false;
      remoteUrl = null;
      prevHead = null;
      mergesDone = [];
      author = { name: 'Your Name', email: 'you@example.com' };
      globalConfig = {};
      cwd = dir;
      prevCwd = dir;
      await ensureWorkdir();
      if (seed) {
        await seed(api);
        // seeds may `cd` to set things up; the learner always starts at the top
        cwd = dir;
        prevCwd = dir;
      }
    }

    var api = {
      run: run,
      finishCommit: finishCommit,
      reset: reset,
      snapshot: snapshot,
      restore: restore,
      changedSince: changedSince,
      graphModel: graphModel,
      statusModel: statusModel,
      diffModel: diffModel,
      commitDetails: commitDetails,
      remoteModel: remoteModel,
      pwd: displayCwd,
      // cwd relative to the project folder: '' at its top, 'src/lib' below
      cwdPath: function () { return cwd === dir ? '' : cwd.slice(dir.length + 1); },
      isRepo: isRepo,
      currentBranch: currentBranch,
      // { from, into, files, unresolved } while a merge is stopped on
      // conflicts, else null
      mergeState: mergeState,
      listFiles: listFiles,
      listTree: listTree,
      // The file API below takes paths from the project's top folder, not
      // from the shell's cwd: callers (the editor, `file x` conditions) hold
      // project-relative paths, just as git status reports them, and must
      // not change meaning when the learner runs `cd`.
      readFile: function (p) { return fs.promises.readFile(fromRoot(p), 'utf8'); },
      readBytes: function (p) { return fs.promises.readFile(fromRoot(p)); },
      // Creates missing parent folders, so the editor can make `data/notes.md`
      // without a separate mkdir.
      writeFile: function (p, c) {
        var target = fromRoot(p);
        return ensureWorkdir()
          .then(function () { return fs.promises.mkdir(fs._dirname(target), { recursive: true }); })
          .then(function () { return fs.promises.writeFile(target, c); });
      },
      get fs() { return fs; },
      get dir() { return dir; },
      git: gitlib
    };
    return api;
  }

  return {
    createSandbox: createSandbox,
    createMemFS: createMemFS,
    tokenize: tokenize,
    tokenizeWords: tokenizeWords,
    splitRedirect: splitRedirect
  };
});
