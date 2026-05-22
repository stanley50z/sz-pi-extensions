// extensions/sz-git-view/template.ts

import { readFileSync } from "node:fs";

function getGitViewCss(): string {
  return readFileSync(new URL("./dist/git-view.css", import.meta.url), "utf-8");
}

export function getHtmlTemplate(): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SZ Git View</title>
<style>
${getGitViewCss()}
</style>
</head>
<body>
  <main class="flex h-screen flex-col bg-background">
    <header class="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card/70 px-5 backdrop-blur">
      <div class="flex min-w-0 items-center gap-3">
        <div class="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-secondary text-primary">⌁</div>
        <div class="min-w-0">
          <div id="repo-name" class="truncate text-sm font-semibold text-foreground">—</div>
          <div class="text-[11px] text-muted-foreground">SZ Git View</div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span id="connection-status" class="rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive">● disconnected</span>
      </div>
    </header>

    <div id="sections" class="grid min-h-0 flex-1 grid-rows-[minmax(0,1.35fr)_minmax(0,1fr)_auto] gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.42fr)] lg:grid-rows-[minmax(0,1fr)_auto]">
    </div>
  </main>
  <div class="tooltip" id="tooltip"></div>

<script>
${getClientJs()}
</script>
</body>
</html>`;
}

function getClientJs(): string {
  return `
// ── State ──────────────────────────────────────────────────────────────
let ws = null;
let commitData = [];
let statusData = [];
let worktreeData = [];
let errorState = null;
let sectionCollapsed = { commits: false, changes: false, worktrees: false };
let expandedDiffs = {};
let expandedDiffDirs = {};

// ── Init ──────────────────────────────────────────────────────────────
function init() {
  buildSections();
  connect();
}

// ── WebSocket ─────────────────────────────────────────────────────────
function connect() {
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);

  ws.onopen = function() {
    var el = document.getElementById('connection-status');
    el.textContent = '\u25cf connected';
    el.className = 'rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300';
  };

  ws.onmessage = function(e) {
    try {
      var msg = JSON.parse(e.data);
      handleMessage(msg);
    } catch (err) { console.error('Parse error:', err); }
  };

  ws.onclose = function() {
    var el = document.getElementById('connection-status');
    el.textContent = '\u25cf disconnected';
    el.className = 'rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive';
    setTimeout(connect, 2000);
  };

  ws.onerror = function() { ws.close(); };
}

function send(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: type, payload: payload }));
  }
}

function handleMessage(msg) {
  if (msg.type === 'full') {
    errorState = msg.error || null;
    commitData = msg.commits || [];
    statusData = msg.status || [];
    worktreeData = msg.worktrees || [];
    document.getElementById('repo-name').textContent = msg.repoName || '\u2014';
    renderAll();
  } else if (msg.type === 'diff') {
    renderDiffInline(msg.path, msg.content);
  }
}

// ── Build Sections ────────────────────────────────────────────────────
function buildSections() {
  var container = document.getElementById('sections');
  container.innerHTML = '';

  var commits = createSection('commits', 'Commits', renderCommits, 'lg:row-span-2');
  var changes = createSection('changes', 'Changes', renderDiffTree, '');
  var worktrees = createSection('worktrees', 'Worktrees', renderWorktrees, '');

  container.appendChild(commits);
  container.appendChild(changes);
  container.appendChild(worktrees);
}

function createSection(id, title, renderFn, extraClass) {
  var div = document.createElement('section');
  div.className = 'section-shell ' + (extraClass || '');
  div.id = id + '-section';

  var header = document.createElement('div');
  header.className = 'git-card-header';
  header.innerHTML = '<div class="git-card-title"><button class="section-toggle" type="button"><span class="toggle">\\u25bc</span></button><span>' + title + '</span></div><span class="stat-pill" id="' + id + '-stats"></span>';
  header.onclick = function() {
    sectionCollapsed[id] = !sectionCollapsed[id];
    var body = div.querySelector('.git-card-body');
    body.style.display = sectionCollapsed[id] ? 'none' : '';
    header.querySelector('.toggle').textContent = sectionCollapsed[id] ? '\\u25b6' : '\\u25bc';
  };

  var body = document.createElement('div');
  body.className = 'git-card-body';
  body._renderFn = renderFn;

  div.appendChild(header);
  div.appendChild(body);
  return div;
}

function renderAll() {
  if (errorState) {
    document.querySelectorAll('.git-card-body').forEach(function(b) {
      b.innerHTML = '<div class="error-state">' + escapeHtml(errorState) + '</div>';
    });
    return;
  }
  document.querySelectorAll('.git-card-body').forEach(function(b) {
    if (b._renderFn) b._renderFn(b);
  });
  updateStats();
}

function updateStats() {
  var statEl = document.getElementById('commits-stats');
  if (statEl) statEl.textContent = commitData.length + ' commits';

  statEl = document.getElementById('changes-stats');
  if (statEl) statEl.textContent = statusData.length === 0 ? 'clean' : statusData.length + ' files';

  statEl = document.getElementById('worktrees-stats');
  if (statEl) statEl.textContent = worktreeData.length + ' worktrees';
}

function escapeHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function statusClasses(status) {
  if (status === 'A') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (status === 'D') return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  if (status === 'R') return 'border-violet-500/30 bg-violet-500/10 text-violet-300';
  if (status === '??') return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
}

// ── Commit Graph Renderer ─────────────────────────────────────────────
var ROW_HEIGHT = 34;
var LANE_WIDTH = 28;
var NODE_RADIUS = 4;

function renderCommits(container) {
  if (commitData.length === 0) {
    container.innerHTML = '<div class="empty-state">No commits yet</div>';
    return;
  }

  var maxLane = 0;
  commitData.forEach(function(c) { if (c.lane > maxLane) maxLane = c.lane; });
  var svgWidth = Math.max(80, (maxLane + 1) * LANE_WIDTH + 18);
  var cy = ROW_HEIGHT / 2;
  var html = '';

  commitData.forEach(function(commit, idx) {
    var hash = escapeHtml(commit.fullHash);
    var shortHash = escapeHtml(commit.hash);
    var color = commit.color || '#a1a1aa';
    var msg = escapeHtml(commit.message);
    var body = escapeHtml(commit.body || '');
    var author = escapeHtml(commit.author);
    var date = escapeHtml(commit.relativeDate);

    html += '<div class="commit-row" onclick="toggleCommitDetail(\\'' + hash + '\\')">';
    html += '<div class="shrink-0" style="width:' + svgWidth + 'px"><svg width="' + svgWidth + '" height="' + ROW_HEIGHT + '">';
    var nx = commit.lane * LANE_WIDTH + LANE_WIDTH / 2 + 8;

    commit.children.forEach(function(childHash) {
      var child = null;
      for (var ci = 0; ci < commitData.length; ci++) {
        if (commitData[ci].fullHash === childHash) { child = commitData[ci]; break; }
      }
      if (!child) return;
      var cx = child.lane * LANE_WIDTH + LANE_WIDTH / 2 + 8;
      var childColor = child.color || '#a1a1aa';
      html += '<line x1="' + nx + '" y1="0" x2="' + cx + '" y2="' + cy + '" stroke="' + childColor + '" stroke-width="1.5" opacity="0.8"/>';
    });

    html += '<circle cx="' + nx + '" cy="' + cy + '" r="' + NODE_RADIUS + '" fill="' + color + '" stroke="hsl(var(--background))" stroke-width="2" ' +
      'onmouseenter="showTooltip(event,\\'' + hash + '\\',\\'' + author + '\\',\\'' + date + '\\')" ' +
      'onmouseleave="hideTooltip()"/>';

    if (idx < commitData.length - 1) {
      var nextNx = commitData[idx + 1].lane * LANE_WIDTH + LANE_WIDTH / 2 + 8;
      html += '<line x1="' + nx + '" y1="' + cy + '" x2="' + nextNx + '" y2="' + ROW_HEIGHT + '" stroke="' + color + '" stroke-width="1.5" opacity="0.8"/>';
    }
    html += '</svg></div>';

    html += '<div class="min-w-0 flex-1">';
    html += '<div class="flex min-w-0 items-center gap-1"><span class="commit-hash" style="color:' + color + '">' + shortHash + '</span>';
    if (commit.isMerge) html += '<span class="rounded border border-amber-500/30 bg-amber-500/10 px-1 text-[9px] text-amber-300">merge</span>';
    html += '<span class="commit-msg truncate">' + msg + '</span></div>';
    html += '<div class="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground"><span>' + author + '</span><span>·</span><span>' + date + '</span>';

    if (commit.refs.length > 0) {
      commit.refs.forEach(function(ref) {
        var cls = 'ref-branch';
        var display = ref;
        if (ref.startsWith('tag:')) { cls = 'ref-tag'; display = ref.slice(4).trim(); }
        else if (ref.includes('/')) cls = 'ref-remote';
        html += '<span class="commit-ref ' + cls + '">' + escapeHtml(display) + '</span>';
      });
    }
    html += '</div></div></div>';

    html += '<div class="commit-detail" id="detail-' + hash + '">' + body + '</div>';
  });

  html += '<button id="commits-sentinel" class="m-3 w-[calc(100%-1.5rem)] rounded-lg border border-border bg-secondary px-3 py-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground" onclick="loadMoreCommits()">Load older commits...</button>';
  container.innerHTML = html;
  setupInfiniteScroll(container);
}

function toggleCommitDetail(hash) {
  var el = document.getElementById('detail-' + hash);
  if (el) el.classList.toggle('open');
}

function showTooltip(event, hash, author, date) {
  var tip = document.getElementById('tooltip');
  tip.innerHTML = hash + '<br>' + author + '<br>' + date;
  tip.style.display = 'block';
  tip.style.left = (event.clientX + 10) + 'px';
  tip.style.top = (event.clientY - 30) + 'px';
}

function hideTooltip() {
  document.getElementById('tooltip').style.display = 'none';
}

function loadMoreCommits() {
  send('load-more', {});
}

function setupInfiniteScroll(container) {
  var sentinel = container.querySelector('#commits-sentinel');
  if (!sentinel) return;
  var observer = new IntersectionObserver(function(entries) {
    if (entries[0].isIntersecting) {
      sentinel.textContent = 'Loading...';
      send('load-more', {});
    }
  }, { root: container, threshold: 0.1 });
  observer.observe(sentinel);
}

// ── Diff Tree Renderer ─────────────────────────────────────────────────
function renderDiffTree(container) {
  if (statusData.length === 0) {
    container.innerHTML = '<div class="empty-state"><div><div class="mb-2 text-lg">✓</div><div>Working tree clean</div></div></div>';
    return;
  }

  var root = { name: '', path: '', type: 'directory', children: [] };
  statusData.forEach(function(entry) {
    var parts = entry.path.split('/');
    var current = root;
    for (var i = 0; i < parts.length; i++) {
      var isFile = i === parts.length - 1;
      var name = parts[i];
      var found = null;
      for (var ci = 0; ci < current.children.length; ci++) {
        if (current.children[ci].name === name) { found = current.children[ci]; break; }
      }
      if (!found) {
        found = {
          name: name,
          path: parts.slice(0, i + 1).join('/'),
          type: isFile ? 'file' : 'directory',
          children: isFile ? undefined : [],
          status: isFile ? entry.status : undefined,
        };
        current.children.push(found);
      }
      current = found;
    }
  });

  sortNodes(root.children);
  container.innerHTML = '<div class="py-2">' + renderDiffNodes(root.children) + '</div>';
}

function sortNodes(nodes) {
  nodes.sort(function(a, b) {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  nodes.forEach(function(n) { if (n.children) sortNodes(n.children); });
}

function renderDiffNodes(nodes, depth) {
  depth = depth || 0;
  var html = '';
  nodes.forEach(function(node) {
    var indent = depth * 24;
    if (node.type === 'directory') {
      var isDirOpen = expandedDiffDirs[node.path] === true;
      html += '<div class="diff-item" style="padding-left:' + (12 + indent) + 'px" data-path="' + escapeHtml(node.path) + '" onclick="toggleDiffDir(this)">';
      html += '<span class="diff-tree-toggle">' + (isDirOpen ? '\\u25bc' : '\\u25b6') + '</span>';
      html += '<span class="diff-path text-muted-foreground">' + escapeHtml(node.name) + '/</span>';
      html += '</div>';
      html += '<div class="diff-dir-children"' + (isDirOpen ? '' : ' style="display:none"') + '>' + renderDiffNodes(node.children, depth + 1) + '</div>';
    } else {
      html += '<div class="diff-item" style="padding-left:' + (12 + indent) + 'px" data-path="' + escapeHtml(node.path) + '" onclick="toggleDiff(this)">';
      html += '<span class="diff-path diff-file-path">' + escapeHtml(node.name) + '</span>';
      html += '<span class="diff-status ' + statusClasses(node.status) + '">' + escapeHtml(node.status) + '</span>';
      html += '</div>';
      var safeId = node.path.replace(/[^a-zA-Z0-9]/g, '_');
      html += '<div class="diff-preview" id="diff-' + safeId + '"></div>';
    }
  });
  return html;
}

function toggleDiffDir(el) {
  var path = el.dataset.path;
  var toggle = el.querySelector('.diff-tree-toggle');
  var children = el.nextElementSibling;
  var isOpen = children.style.display !== 'none';
  children.style.display = isOpen ? 'none' : '';
  toggle.textContent = isOpen ? '\\u25b6' : '\\u25bc';
  if (isOpen) delete expandedDiffDirs[path];
  else expandedDiffDirs[path] = true;
}

function toggleDiff(el) {
  var path = el.dataset.path;
  var safeId = path.replace(/[^a-zA-Z0-9]/g, '_');
  var diffEl = document.getElementById('diff-' + safeId);
  if (!diffEl) return;

  if (diffEl.classList.contains('open')) {
    diffEl.classList.remove('open');
    delete expandedDiffs[path];
  } else {
    diffEl.classList.add('open');
    expandedDiffs[path] = true;
    if (!diffEl.textContent.trim()) {
      diffEl.textContent = 'Loading diff...';
      send('get-diff', { path: path });
    }
  }
}

function renderDiffInline(path, content) {
  var safeId = path.replace(/[^a-zA-Z0-9]/g, '_');
  var diffEl = document.getElementById('diff-' + safeId);
  if (!diffEl) return;

  if (!content) {
    diffEl.textContent = '(no diff)';
    return;
  }

  var html = '';
  content.split('\\n').forEach(function(line) {
    var cls = 'diff-line-ctx';
    if (line.startsWith('@@')) cls = 'diff-hunk-header';
    else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-line-add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-line-del';
    html += '<div class="' + cls + '">' + escapeHtml(line) + '</div>';
  });
  diffEl.innerHTML = html;
}

// ── Worktree Renderer ──────────────────────────────────────────────────
function renderWorktrees(container) {
  if (worktreeData.length === 0) {
    container.innerHTML = '<div class="empty-state">No worktrees found</div>';
    return;
  }

  var html = '';
  worktreeData.forEach(function(wt) {
    html += '<div class="worktree-item">';
    html += '<span class="wt-dot ' + (wt.dirty ? 'dirty' : 'clean') + '">\\u25cf</span>';
    html += '<div class="min-w-0 flex-1">';
    html += '<div class="wt-path">' + escapeHtml(wt.path) + (wt.bare ? ' (bare)' : '') + '</div>';
    html += '<div class="wt-branch">' + escapeHtml(wt.branch) + '</div>';
    html += '</div></div>';
  });
  container.innerHTML = html;
}

// ── Expose functions to onclick handlers ──────────────────────────────
window.toggleCommitDetail = toggleCommitDetail;
window.showTooltip = showTooltip;
window.hideTooltip = hideTooltip;
window.loadMoreCommits = loadMoreCommits;
window.toggleDiffDir = toggleDiffDir;
window.toggleDiff = toggleDiff;

// ── Start ─────────────────────────────────────────────────────────────
init();
`;
}
