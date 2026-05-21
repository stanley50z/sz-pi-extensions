// extensions/sz-git-view/template.ts

export function getHtmlTemplate(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SZ Git View</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%;
    background: #0a0a14;
    color: #bdc3c7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    font-size: 12px;
    overflow: hidden;
  }
  body {
    display: flex;
    flex-direction: column;
  }

  /* ── Top Bar ──────────────────────────────── */
  #topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: #0d0d1a;
    border-bottom: 1px solid #1a1a2e;
    flex-shrink: 0;
    font-size: 11px;
  }
  #repo-name { color: #7f8c8d; }
  #connection-status {
    color: #2ecc71;
    font-size: 10px;
    transition: opacity 0.3s;
  }
  #connection-status.pulse { opacity: 0.4; }

  /* ── Sections Container ───────────────────── */
  #sections {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Section ──────────────────────────────── */
  .section {
    border-bottom: 1px solid #1a1a2e;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 12px;
    font-size: 10px;
    font-weight: 600;
    color: #7f8c8d;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    background: #0d0d1a;
    flex-shrink: 0;
    cursor: pointer;
    user-select: none;
  }
  .section-header:hover { background: #111128; }
  .section-header .toggle { font-size: 9px; margin-right: 4px; }
  .section-header .section-stats {
    font-size: 9px;
    font-weight: 400;
  }
  .section-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    background: #0a0a14;
  }

  /* ── Commits Section ──────────────────────── */
  #commits-section { flex: 2; }
  .commit-row {
    display: flex;
    align-items: flex-start;
    padding: 3px 8px;
    min-height: 24px;
    cursor: pointer;
    border-bottom: 1px solid #0d0d1a;
  }
  .commit-row:hover { background: #111128; }
  .commit-graph {
    width: 100px;
    flex-shrink: 0;
    position: relative;
  }
  .commit-info { flex: 1; overflow: hidden; }
  .commit-hash { font-size: 10px; font-weight: 600; }
  .commit-msg { color: #bdc3c7; margin-left: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit-refs { margin-left: 6px; font-size: 9px; }
  .commit-ref {
    display: inline-block;
    padding: 0 4px;
    border-radius: 3px;
    margin-right: 3px;
    font-size: 9px;
  }
  .ref-branch { background: #1a3a1a; color: #2ecc71; }
  .ref-tag { background: #1a1a3a; color: #3498db; }
  .ref-remote { background: #3a1a1a; color: #e74c3c; }

  .commit-detail {
    padding: 6px 12px 8px 108px;
    background: #06060f;
    font-size: 10px;
    color: #95a5a6;
    border-bottom: 1px solid #0d0d1a;
    display: none;
    white-space: pre-wrap;
    max-height: 120px;
    overflow-y: auto;
  }
  .commit-detail.open { display: block; }

  #commits-sentinel {
    text-align: center;
    padding: 8px;
    color: #7f8c8d;
    font-size: 10px;
    cursor: pointer;
  }
  #commits-sentinel:hover { color: #bdc3c7; }

  /* ── Diff Tree Section ────────────────────── */
  #diff-section { flex: 1; }
  .diff-item {
    display: flex;
    align-items: center;
    padding: 2px 12px;
    cursor: pointer;
    font-size: 10px;
  }
  .diff-item:hover { background: #111128; }
  .diff-tree-toggle { width: 14px; color: #7f8c8d; font-size: 9px; flex-shrink: 0; }
  .diff-status {
    width: 16px;
    flex-shrink: 0;
    text-align: center;
    font-size: 9px;
    font-weight: 700;
  }
  .status-M { color: #f39c12; }
  .status-A { color: #2ecc71; }
  .status-D { color: #e74c3c; }
  .status-R { color: #9b59b6; }
  .status-?? { color: #e74c3c; }
  .diff-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .diff-stats { margin-left: 6px; font-size: 9px; }
  .diff-adds { color: #2ecc71; }
  .diff-dels { color: #e74c3c; }

  .diff-preview {
    display: none;
    margin: 0 12px 4px 46px;
    padding: 4px 8px;
    background: #06060f;
    border-radius: 4px;
    border-left: 2px solid #f39c12;
    font-family: "SF Mono", Menlo, Monaco, monospace;
    font-size: 9px;
    line-height: 1.5;
    overflow-x: auto;
    max-height: 150px;
    overflow-y: auto;
    white-space: pre;
  }
  .diff-preview.open { display: block; }
  .diff-hunk-header { color: #3498db; }
  .diff-line-add { color: #2ecc71; }
  .diff-line-del { color: #e74c3c; }
  .diff-line-ctx { color: #7f8c8d; }

  /* ── Worktree Section ─────────────────────── */
  #worktree-section { flex: 0 0 auto; max-height: 150px; }
  .worktree-item {
    display: flex;
    align-items: center;
    padding: 5px 12px;
    border-bottom: 1px solid #0d0d1a;
  }
  .wt-dot { margin-right: 8px; font-size: 8px; }
  .wt-dot.clean { color: #2ecc71; }
  .wt-dot.dirty { color: #f39c12; }
  .wt-info { flex: 1; }
  .wt-path { font-size: 11px; color: #bdc3c7; }
  .wt-branch { font-size: 9px; }

  /* ── Error / Empty States ─────────────────── */
  .empty-state {
    padding: 12px;
    color: #7f8c8d;
    font-size: 10px;
    text-align: center;
  }
  .error-state {
    padding: 20px;
    color: #e74c3c;
    text-align: center;
  }

  /* ── Tooltip ──────────────────────────────── */
  .tooltip {
    position: fixed;
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 10px;
    pointer-events: none;
    z-index: 100;
    display: none;
    max-width: 300px;
  }

  /* Scrollbar styling */
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: #0a0a14; }
  ::-webkit-scrollbar-thumb { background: #1a1a2e; border-radius: 2px; }
  ::-webkit-scrollbar-thumb:hover { background: #2a2a4a; }
</style>
</head>
<body>
  <div id="topbar">
    <span id="repo-name">—</span>
    <span id="connection-status">● disconnected</span>
  </div>
  <div id="sections">
  </div>
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
    document.getElementById('connection-status').textContent = '\\u25cf connected';
    document.getElementById('connection-status').style.color = '#2ecc71';
  };

  ws.onmessage = function(e) {
    try {
      var msg = JSON.parse(e.data);
      handleMessage(msg);
    } catch (err) { console.error('Parse error:', err); }
  };

  ws.onclose = function() {
    document.getElementById('connection-status').textContent = '\\u25cf disconnected';
    document.getElementById('connection-status').style.color = '#e74c3c';
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
    document.getElementById('repo-name').textContent = msg.repoName || '\\u2014';
    renderAll();
    pulseConnected();
  } else if (msg.type === 'diff') {
    renderDiffInline(msg.path, msg.content);
  }
}

function pulseConnected() {
  var el = document.getElementById('connection-status');
  el.style.opacity = '0.4';
  setTimeout(function() { el.style.opacity = '1'; }, 150);
}

// ── Build Sections ────────────────────────────────────────────────────
function buildSections() {
  var container = document.getElementById('sections');
  container.innerHTML = '';

  container.appendChild(createSection('commits', 'Commits', renderCommits));
  container.appendChild(createSection('changes', 'Changes', renderDiffTree));
  container.appendChild(createSection('worktrees', 'Worktrees', renderWorktrees));
}

function createSection(id, title, renderFn) {
  var div = document.createElement('div');
  div.className = 'section';
  div.id = id + '-section';

  var header = document.createElement('div');
  header.className = 'section-header';
  header.innerHTML = '<span class="toggle">\\u25bc</span><span>' + title + '</span><span class="section-stats" id="' + id + '-stats"></span>';
  header.onclick = function() {
    sectionCollapsed[id] = !sectionCollapsed[id];
    var body = div.querySelector('.section-body');
    body.style.display = sectionCollapsed[id] ? 'none' : '';
    header.querySelector('.toggle').textContent = sectionCollapsed[id] ? '\\u25b6' : '\\u25bc';
  };

  var body = document.createElement('div');
  body.className = 'section-body';
  body._renderFn = renderFn;

  div.appendChild(header);
  div.appendChild(body);
  return div;
}

function renderAll() {
  if (errorState) {
    document.querySelectorAll('.section-body').forEach(function(b) {
      b.innerHTML = '<div class="error-state">' + escapeHtml(errorState) + '</div>';
    });
    return;
  }
  document.querySelectorAll('.section-body').forEach(function(b) {
    if (b._renderFn) b._renderFn(b);
  });
  updateStats();
}

function updateStats() {
  var commitCount = commitData.length;
  var statEl = document.getElementById('commits-stats');
  if (statEl) statEl.textContent = commitCount + ' commits';

  statEl = document.getElementById('changes-stats');
  if (statEl) {
    if (statusData.length === 0) {
      statEl.textContent = 'clean';
    } else {
      var adds = 0, dels = 0;
      statEl.textContent = statusData.length + ' files';
    }
  }
}

function escapeHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Commit Graph Renderer ─────────────────────────────────────────────

var ROW_HEIGHT = 24;
var LANE_WIDTH = 30;
var NODE_RADIUS = 4;

function renderCommits(container) {
  if (commitData.length === 0) {
    container.innerHTML = '<div class="empty-state">No commits yet</div>';
    return;
  }

  var maxLane = 0;
  commitData.forEach(function(c) { if (c.lane > maxLane) maxLane = c.lane; });
  var svgWidth = (maxLane + 1) * LANE_WIDTH + 10;
  var cy = ROW_HEIGHT / 2;

  var html = '';

  commitData.forEach(function(commit, idx) {
    var hash = escapeHtml(commit.fullHash);
    var shortHash = escapeHtml(commit.hash);
    var color = commit.color || '#7f8c8d';
    var msg = escapeHtml(commit.message);
    var author = escapeHtml(commit.author);
    var date = escapeHtml(commit.relativeDate);

    html += '<div class="commit-row" onclick="toggleCommitDetail(\\'' + hash + '\\')">';

    // SVG graph lane
    html += '<div class="commit-graph"><svg width="' + svgWidth + '" height="' + ROW_HEIGHT + '">';

    var nx = commit.lane * LANE_WIDTH + LANE_WIDTH / 2;

    // Draw lines from this commit UP to its children (rendered above)
    commit.children.forEach(function(childHash) {
      var child = null;
      for (var ci = 0; ci < commitData.length; ci++) {
        if (commitData[ci].fullHash === childHash) { child = commitData[ci]; break; }
      }
      if (!child) return;
      var cx = child.lane * LANE_WIDTH + LANE_WIDTH / 2;
      var childColor = child.color || '#7f8c8d';
      html += '<line x1="' + nx + '" y1="0" x2="' + cx + '" y2="' + cy + '" stroke="' + childColor + '" stroke-width="1.5"/>';
    });

    // Draw node
    html += '<circle cx="' + nx + '" cy="' + cy + '" r="' + NODE_RADIUS + '" fill="' + color + '" ' +
      'onmouseenter="showTooltip(event,\\'' + hash + '\\',\\'' + author + '\\',\\'' + date + '\\')" ' +
      'onmouseleave="hideTooltip()"/>';

    // Draw line downward
    if (idx < commitData.length - 1) {
      var nextNx = commitData[idx + 1].lane * LANE_WIDTH + LANE_WIDTH / 2;
      html += '<line x1="' + nx + '" y1="' + cy + '" x2="' + nextNx + '" y2="' + ROW_HEIGHT + '" stroke="' + color + '" stroke-width="1.5"/>';
    }

    html += '</svg></div>';

    // Commit info
    html += '<div class="commit-info">';
    html += '<span class="commit-hash" style="color:' + color + '">' + shortHash + '</span>';
    if (commit.isMerge) html += '<span style="color:#f39c12;font-size:9px;"> M</span>';
    html += '<span class="commit-msg">' + msg + '</span>';

    if (commit.refs.length > 0) {
      html += '<span class="commit-refs">';
      commit.refs.forEach(function(ref) {
        var cls = 'ref-branch';
        var display = ref;
        if (ref.startsWith('tag:')) { cls = 'ref-tag'; display = ref.slice(4).trim(); }
        else if (ref.includes('/')) cls = 'ref-remote';
        html += '<span class="commit-ref ' + cls + '">' + escapeHtml(display) + '</span>';
      });
      html += '</span>';
    }

    html += '</div></div>';

    html += '<div class="commit-detail" id="detail-' + hash + '">' +
      'Full: ' + hash + '\\nAuthor: ' + author + '\\nDate: ' + escapeHtml(commit.date) + '\\n\\n' + msg +
      '</div>';
  });

  html += '<div id="commits-sentinel" onclick="loadMoreCommits()">Load older commits...</div>';

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
    container.innerHTML = '<div class="empty-state">Working tree clean</div>';
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
  container.innerHTML = renderDiffNodes(root.children);
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
    var indent = depth * 14;
    if (node.type === 'directory') {
      html += '<div class="diff-item" style="padding-left:' + (12 + indent) + 'px" onclick="toggleDiffDir(this)">';
      html += '<span class="diff-tree-toggle">\\u25b6</span>';
      html += '<span class="diff-path">' + escapeHtml(node.name) + '/</span>';
      html += '</div>';
      html += '<div class="diff-dir-children" style="display:none">';
      html += renderDiffNodes(node.children, depth + 1);
      html += '</div>';
    } else {
      var statusClass = 'status-' + node.status;
      html += '<div class="diff-item" style="padding-left:' + (12 + indent) + 'px" data-path="' + escapeHtml(node.path) + '" onclick="toggleDiff(this)">';
      html += '<span class="diff-tree-toggle"></span>';
      html += '<span class="diff-status ' + statusClass + '">' + escapeHtml(node.status) + '</span>';
      html += '<span class="diff-path">' + escapeHtml(node.name) + '</span>';
      html += '<span class="diff-stats"></span>';
      html += '</div>';
      var safeId = node.path.replace(/[^a-zA-Z0-9]/g, '_');
      html += '<div class="diff-preview" id="diff-' + safeId + '"></div>';
    }
  });
  return html;
}

function toggleDiffDir(el) {
  var toggle = el.querySelector('.diff-tree-toggle');
  var children = el.nextElementSibling;
  var isOpen = children.style.display !== 'none';
  children.style.display = isOpen ? 'none' : '';
  toggle.textContent = isOpen ? '\\u25b6' : '\\u25bc';
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
  var lines = content.split('\\n');
  lines.forEach(function(line) {
    var cls = 'diff-line-ctx';
    if (line.startsWith('@@')) cls = 'diff-hunk-header';
    else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-line-add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-line-del';
    html += '<span class="' + cls + '">' + escapeHtml(line) + '</span>\\n';
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
    html += '<div class="wt-info">';
    html += '<div class="wt-path">' + escapeHtml(wt.path) + (wt.bare ? ' (bare)' : '') + '</div>';
    html += '<div class="wt-branch" style="color:#3498db">' + escapeHtml(wt.branch) + '</div>';
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
