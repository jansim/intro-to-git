--[[--------------------------------------------------------------------
  git-sandbox.lua — turns

    ```git-sandbox
    title: Exercise 1
    tasks:
      - text: Make a commit
        when: commits >= 1
    ```

  into an interactive Git exercise, and injects the JavaScript and CSS the
  exercise needs exactly once per document.
----------------------------------------------------------------------]]

local script_dir = pandoc.path.directory(PANDOC_SCRIPT_FILE)
local yaml = dofile(pandoc.path.join({ script_dir, 'yaml.lua' }))

local counter = 0
local seen_ids = {}
-- `share:` targets, checked once the whole document has been read, since a
-- view may come before the exercise it shares
local shares = {}

------------------------------------------------------------------ messages

local function warn(msg)
  io.stderr:write('[git-sandbox] ' .. msg .. '\n')
end

-- A visible, styled error in the document. Authoring mistakes should be
-- impossible to miss, but they should not stop the rest of the page rendering.
local function error_block(lines)
  local items = {}
  for _, l in ipairs(lines) do
    items[#items + 1] = '<li>' .. l:gsub('&', '&amp;'):gsub('<', '&lt;'):gsub('>', '&gt;') .. '</li>'
  end
  return pandoc.RawBlock('html',
    '<div class="gs gs-config-error"><div class="gs-head">' ..
    '<span class="gs-eyebrow">Git sandbox — configuration error</span></div>' ..
    '<div class="gs-loading"><ul>' .. table.concat(items) .. '</ul></div></div>')
end

--------------------------------------------------------------- dependencies

local deps_added = false
local function res(f) return pandoc.path.join({ script_dir, 'resources', f }) end

local function add_dependencies()
  if deps_added then return end
  deps_added = true
  local scripts = {}
  -- isomorphic-git first, then the sandbox modules in dependency order; the
  -- last one mounts the exercises queued on the page. All after the body so
  -- a 260 KB library never blocks first paint.
  for _, f in ipairs({ 'isomorphic-git.bundle.js', 'sandbox-core.js', 'sandbox-when.js',
                       'sandbox-tree.js', 'sandbox-ui.js' }) do
    scripts[#scripts + 1] = { path = res(f), afterBody = true }
  end
  quarto.doc.addHtmlDependency({
    name = 'git-sandbox',
    version = '1.1.0',
    stylesheets = { res('git-sandbox.css') },
    scripts = scripts
  })
end

-------------------------------------------------------------------- helpers

local function is_array(t)
  return type(t) == 'table' and (#t > 0 or next(t) == nil)
end

local function as_array(v)
  if v == nil or v == '' then return {} end
  if is_array(v) then return v end
  return { v }
end

-- Render a short Markdown string as inline HTML, so authors can write
-- `git init` in backticks and get <code>git init</code>.
local function markdown_inline(str)
  if str == nil or str == '' then return '' end
  local ok, doc = pcall(pandoc.read, tostring(str), 'markdown')
  if not ok then return tostring(str) end
  local blocks = doc.blocks
  if #blocks == 1 and (blocks[1].t == 'Para' or blocks[1].t == 'Plain') then
    local html = pandoc.write(pandoc.Pandoc({ pandoc.Plain(blocks[1].content) }), 'html')
    return (html:gsub('%s+$', ''))
  end
  return (pandoc.write(pandoc.Pandoc(blocks), 'html'):gsub('%s+$', ''))
end

-- Terminal text must stay verbatim: it is escaped and then run through the
-- {y}…{/} colour markers by the browser, so no Markdown here.
local function text_lines(v)
  if v == nil or v == '' then return {} end
  if is_array(v) then
    local out = {}
    for _, x in ipairs(v) do out[#out + 1] = tostring(x) end
    return out
  end
  local out = {}
  for line in (tostring(v):gsub('\n$', '') .. '\n'):gmatch('([^\n]*)\n') do
    out[#out + 1] = line
  end
  return out
end

local function slugify(s)
  s = tostring(s or ''):lower():gsub('[^%w%-_]+', '-'):gsub('^%-+', ''):gsub('%-+$', '')
  return s
end

------------------------------------------------------------------ validation

local BLOCK_KEYS = {
  id = true, title = true, prompt = true, intro = true, hints = true,
  seed = true, tasks = true, ['done-note'] = true, ['tree-view'] = true,
  editor = true, panels = true, ['panel-tabs'] = true, share = true, script = true
}
local PANEL_NAMES = { 'files', 'changes', 'history', 'remote' }
local TASK_KEYS = { text = true, ['when'] = true, js = true }

-- `done_note` is read as `done-note`, and so on
local function dash_keys(tbl)
  for i, k in ipairs(tbl.__keys or {}) do
    local d = k:gsub('_', '-')
    if d ~= k then
      tbl[d], tbl[k], tbl.__keys[i] = tbl[k], nil, d
    end
  end
end

local function check_keys(tbl, allowed, where, problems)
  for _, k in ipairs(tbl.__keys or {}) do
    if not allowed[k] then
      problems[#problems + 1] = ('unknown option "%s" in %s'):format(k, where)
    end
  end
end

--------------------------------------------------------------------- config

local function build_config(cfg, problems)
  local out = {}

  out.title = markdown_inline(cfg.title or 'Git sandbox')
  out.prompt = tostring(cfg.prompt or '~/project $')
  out.intro = text_lines(cfg.intro)
  out.hints = {}
  for _, h in ipairs(as_array(cfg.hints)) do out.hints[#out.hints + 1] = tostring(h) end

  if cfg.seed ~= nil and cfg.seed ~= '' then out.seed = tostring(cfg.seed) end

  -- commands to play back one at a time, e.g. fragment by fragment on a
  -- reveal.js slide: a list, or a literal block with one per line
  if cfg.script ~= nil and cfg.script ~= '' then
    out.script = {}
    local items = is_array(cfg.script) and cfg.script or text_lines(cfg.script)
    for i, c in ipairs(items) do
      if type(c) == 'table' then
        problems[#problems + 1] = ('"script" line %d must be a command, like git status'):format(i)
      else
        local line = tostring(c):gsub('^%s+', ''):gsub('%s+$', '')
        if line ~= '' and line:sub(1, 1) ~= '#' then out.script[#out.script + 1] = line end
      end
    end
  end

  -- another view of an exercise's repository: same files and history, its
  -- own title, tasks and layout
  if cfg.share ~= nil and cfg.share ~= '' then
    out.share = slugify(cfg.share)
    if out.share == '' then
      problems[#problems + 1] = '"share" must name the id of another exercise'
    elseif out.seed then
      problems[#problems + 1] = '"seed" cannot be combined with "share": the shared repository is ' ..
        'set up by the seed of the exercise it shares'
    end
  end

  -- yaml.lua leaves scalars as strings, so spell out what counts as on.
  -- Returns true, false, 'toggle' (when allowed), or nil if unset or bad.
  local function switch(key, allow_toggle)
    local raw = cfg[key]
    if raw == nil or raw == '' then return nil end
    local v = tostring(raw):lower()
    if v == 'true' or v == 'yes' or v == 'on' then return true end
    if v == 'false' or v == 'no' or v == 'off' then return false end
    if allow_toggle and v == 'toggle' then return 'toggle' end
    problems[#problems + 1] = ('"%s" must be %s, got "%s"'):format(
      key, allow_toggle and 'true, false or toggle' or 'true or false', tostring(raw))
    return nil
  end

  -- left unset, the browser applies the defaults: tree-view and panels
  -- 'toggle', editor true
  local tree = switch('tree-view', true)
  if tree ~= nil then out.treeView = tree end
  local panels = switch('panels', true)
  if panels ~= nil then out.panels = panels end
  local editor = switch('editor', false)
  if editor ~= nil then out.editor = editor end

  local tabs = cfg['panel-tabs']
  if tabs ~= nil and tabs ~= '' then
    out.panelTabs = {}
    for _, t in ipairs(as_array(tabs)) do
      local name = tostring(t):lower()
      local known = false
      for _, n in ipairs(PANEL_NAMES) do if n == name then known = true end end
      if known then
        out.panelTabs[#out.panelTabs + 1] = name
      else
        problems[#problems + 1] = ('"panel-tabs" lists "%s"; the panels are %s'):format(
          tostring(t), table.concat(PANEL_NAMES, ', '))
      end
    end
  end

  local note = cfg['done-note']
  if note and note ~= '' then out.doneNote = markdown_inline(note) end

  out.tasks = {}
  local tasks = cfg.tasks
  if tasks ~= nil and tasks ~= '' then
    if not is_array(tasks) then
      problems[#problems + 1] = '"tasks" must be a list of items, each starting with "- text:"'
    else
      for i, t in ipairs(tasks) do
        if type(t) ~= 'table' then
          problems[#problems + 1] = ('task %d must have a "text:" and a "when:"'):format(i)
        else
          check_keys(t, TASK_KEYS, ('task %d'):format(i), problems)
          if t.text == nil or t.text == '' then
            problems[#problems + 1] = ('task %d has no "text:"'):format(i)
          end
          local has_when = t['when'] ~= nil and t['when'] ~= ''
          local has_js = t.js ~= nil and t.js ~= ''
          if not has_when and not has_js then
            problems[#problems + 1] =
              ('task %d needs a "when:" condition (or a "js:" expression)'):format(i)
          end
          if has_when and has_js then
            problems[#problems + 1] =
              ('task %d has both "when:" and "js:" — use one'):format(i)
          end
          local task = { text = markdown_inline(t.text) }
          if has_when then task['when'] = tostring(t['when']) end
          if has_js then task.js = tostring(t.js) end
          out.tasks[#out.tasks + 1] = task
        end
      end
    end
  end

  return out
end

----------------------------------------------------------------- non-HTML

-- In PDF, docx and friends there is no sandbox, so leave something honest and
-- readable behind instead of an empty hole.
local function static_fallback(cfg, config)
  local blocks = {}
  blocks[#blocks + 1] = pandoc.Para({ pandoc.Emph(pandoc.Inlines(
    pandoc.read('This exercise is interactive. Open the HTML version of this ' ..
                'lesson to work through it in a browser.', 'markdown').blocks[1].content)) })
  if #config.tasks > 0 then
    local items = {}
    for _, t in ipairs(config.tasks) do
      local ok, doc = pcall(pandoc.read, tostring(t.text), 'markdown')
      items[#items + 1] = ok and doc.blocks or { pandoc.Plain(pandoc.Str(tostring(t.text))) }
    end
    blocks[#blocks + 1] = pandoc.BulletList(items)
  end
  return pandoc.Div(blocks, pandoc.Attr('', { 'git-sandbox-static' }))
end

--------------------------------------------------------------------- filter

function CodeBlock(el)
  if not el.classes:includes('git-sandbox') then return nil end

  local problems = {}

  local cfg, parse_error = yaml.parse(el.text)
  if cfg == nil then
    warn('could not read the options: ' .. tostring(parse_error))
    return error_block({ 'Could not read the exercise options.', tostring(parse_error) })
  end
  if type(cfg) ~= 'table' or is_array(cfg) then
    return error_block({ 'The exercise options must be a set of "key: value" lines.' })
  end

  dash_keys(cfg)
  check_keys(cfg, BLOCK_KEYS, 'the exercise options', problems)
  local config = build_config(cfg, problems)

  if #problems > 0 then
    for _, p in ipairs(problems) do warn(p) end
    local lines = { 'This exercise was not created. Fix the options and render again:' }
    for _, p in ipairs(problems) do lines[#lines + 1] = p end
    return error_block(lines)
  end

  counter = counter + 1
  local id = slugify(cfg.id)
  if id == '' then id = 'git-sandbox-' .. counter end
  if seen_ids[id] then
    warn(('two exercises share the id "%s"; the second was renamed'):format(id))
    id = id .. '-' .. counter
  end
  seen_ids[id] = true

  if config.share then
    if config.share == id then
      warn(('exercise "%s" shares itself; drop the "share" option'):format(id))
      config.share = nil
    else
      shares[#shares + 1] = { from = id, to = config.share }
    end
  end

  if not quarto.doc.isFormat('html:js') then
    return static_fallback(cfg, config)
  end

  add_dependencies()

  local json = quarto.json.encode(config)
  -- The tree pane needs room beside the box, so let the exercise run on
  -- into the right margin, as Quarto's own wide figures do.
  -- (A tree that opens on demand drops below the box when there is no room.)
  local classes = config.treeView == true and 'git-sandbox column-page-right' or 'git-sandbox'
  -- On a slide each scripted command gets two reveal.js fragments: the
  -- first types it into the prompt, the second runs it. They sit outside
  -- the box, whose contents the browser replaces when it mounts, and are
  -- never seen; the box only watches which of them are visible.
  local steps = ''
  if config.script and #config.script > 0 and quarto.doc.isFormat('revealjs') then
    local spans = {}
    for i = 1, #config.script * 2 do
      spans[#spans + 1] = '<span class="fragment gs-step" data-gs-for="' .. id .. '"></span>'
    end
    steps = '<div class="gs-steps" hidden aria-hidden="true">' .. table.concat(spans) .. '</div>'
  end
  return pandoc.Blocks({
    pandoc.RawBlock('html',
      '<div class="' .. classes .. '" id="' .. id .. '">' ..
      '<div class="gs-loading">Loading the Git sandbox…</div></div>' .. steps),
    pandoc.RawBlock('html',
      '<script>(window.__gsPending=window.__gsPending||[]).push(["#' .. id .. '",' .. json .. ']);</script>')
  })
end

-- Runs after every block: a `share:` naming no exercise still works (the
-- view starts with an empty repository), but it is almost certainly a typo.
function Pandoc(doc)
  for _, sh in ipairs(shares) do
    if not seen_ids[sh.to] then
      warn(('exercise "%s" shares "%s", but no exercise has that id'):format(sh.from, sh.to))
    end
  end
  return nil
end
