import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { parseHTML } from 'linkedom';

const moduleUrl = new URL('../extensions/sz-git-view/template.ts', import.meta.url).href;

async function freshTemplateModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

function runClientTemplate(html) {
  const clientScript = html.split('<script>\n').at(-1)?.split('\n</script>')[0] ?? '';
  const { window, document } = parseHTML(html.replace(/<script>[\s\S]*?<\/script>/, ''));
  class FakeWebSocket {
    static OPEN = 1;
    static instance;

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      FakeWebSocket.instance = this;
    }

    send(message) {
      this.lastSent = message;
    }

    close() {}
  }

  window.window = window;
  window.document = document;
  window.console = console;
  window.WebSocket = FakeWebSocket;
  window.IntersectionObserver = class {
    observe() {}
  };
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { protocol: 'http:', host: '127.0.0.1:61589' },
  });

  new Script(clientScript).runInNewContext(window);

  return { window, document, FakeWebSocket };
}

test('Git View template uses local built Tailwind and shadcn-style static UI without React', async () => {
  const { getHtmlTemplate } = await freshTemplateModule();
  const html = getHtmlTemplate();

  assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
  assert.doesNotMatch(html, /tailwind\.config/);
  assert.match(html, /--background:/);
  assert.match(html, /--card:/);
  assert.match(html, /--primary:/);
  assert.match(html, /\.section-shell/);
  assert.match(html, /border-radius:var\(--radius\)/);
  assert.match(html, /\.border-border/);
  assert.match(html, /\.bg-card/);
  assert.match(html, /\.text-muted-foreground/);
  assert.match(html, /class="git-card-title"/);
  assert.doesNotMatch(html, /react/i);
});

test('Git View built CSS artifact exists and contains generated utilities', async () => {
  const css = await readFile(new URL('../extensions/sz-git-view/dist/git-view.css', import.meta.url), 'utf8');

  assert.match(css, /--background:/);
  assert.match(css, /\.section-shell/);
  assert.match(css, /border-radius:var\(--radius\)/);
  assert.match(css, /\.border-border/);
  assert.match(css, /\.bg-card/);
  assert.match(css, /\.text-muted-foreground/);
});

test('Git View template preserves WebSocket data and diff interactions', async () => {
  const { getHtmlTemplate } = await freshTemplateModule();
  const html = getHtmlTemplate();

  assert.match(html, /new WebSocket/);
  assert.match(html, /function handleMessage/);
  assert.match(html, /function renderCommits/);
  assert.match(html, /function renderDiffTree/);
  assert.match(html, /function renderWorktrees/);
  assert.match(html, /send\('get-diff'/);
});

test('Git View generated client script is valid JavaScript', async () => {
  const { getHtmlTemplate } = await freshTemplateModule();
  const html = getHtmlTemplate();
  const scriptBlocks = html.split('<script>\n');
  const clientScript = scriptBlocks.at(-1)?.split('\n</script>')[0];

  assert.ok(clientScript, 'client script not found');
  assert.doesNotThrow(() => new Script(clientScript));
});

test('Git View connection status does not flash on data refresh', async () => {
  const { getHtmlTemplate } = await freshTemplateModule();
  const html = getHtmlTemplate();
  const scriptBlocks = html.split('<script>\n');
  const clientScript = scriptBlocks.at(-1)?.split('\n</script>')[0] ?? '';

  assert.doesNotMatch(clientScript, /pulseConnected/);
  assert.doesNotMatch(clientScript, /style\.opacity/);
});

test('Git View renders expanded diffs line by line with preserved whitespace', async () => {
  const { getHtmlTemplate } = await freshTemplateModule();
  const html = getHtmlTemplate();
  const scriptBlocks = html.split('<script>\n');
  const clientScript = scriptBlocks.at(-1)?.split('\n</script>')[0] ?? '';
  const css = await readFile(new URL('../extensions/sz-git-view/dist/git-view.css', import.meta.url), 'utf8');

  assert.match(clientScript, /'<div class="' \+ cls \+ '">/);
  assert.doesNotMatch(clientScript, /'<span class="' \+ cls \+ '">/);
  assert.match(css, /\.diff-preview\{[^}]*white-space:pre/);
});

test('Git View changes folders stay expanded across data refreshes', async () => {
  const { getHtmlTemplate } = await freshTemplateModule();
  const { window, document, FakeWebSocket } = runClientTemplate(getHtmlTemplate());
  const payload = {
    type: 'full',
    repoName: 'repo',
    commits: [],
    status: [
      { status: 'M', path: 'extensions/sz-git-view/template.ts' },
      { status: 'M', path: 'extensions/sz-pi-footer.ts' },
    ],
    worktrees: [],
  };

  FakeWebSocket.instance.onmessage({ data: JSON.stringify(payload) });

  const folder = document.querySelector('#changes-section .diff-item[data-path="extensions"]');
  assert.ok(folder, 'expected extensions folder row');
  const children = folder.nextElementSibling;
  assert.equal(children.style.display, 'none');

  window.toggleDiffDir(folder);
  assert.equal(children.style.display, '');
  assert.equal(folder.querySelector('.diff-tree-toggle').textContent, '▼');

  FakeWebSocket.instance.onmessage({ data: JSON.stringify(payload) });

  const refreshedFolder = document.querySelector('#changes-section .diff-item[data-path="extensions"]');
  assert.notEqual(refreshedFolder.nextElementSibling.style.display, 'none');
  assert.equal(refreshedFolder.querySelector('.diff-tree-toggle').textContent, '▼');
});

test('Git View aligns tree levels with clear parent-child indentation', async () => {
  const { getHtmlTemplate } = await freshTemplateModule();
  const { document, FakeWebSocket } = runClientTemplate(getHtmlTemplate());

  FakeWebSocket.instance.onmessage({
    data: JSON.stringify({
      type: 'full',
      repoName: 'repo',
      commits: [],
      status: [
        { status: '??', path: 'test/sz-git-view.test.mjs' },
        { status: 'M', path: 'package.json' },
      ],
      worktrees: [],
    }),
  });

  const folderRow = document.querySelector('#changes-section .diff-item[data-path="test"]');
  const childFileRow = document.querySelector('#changes-section .diff-item[data-path="test/sz-git-view.test.mjs"]');
  const rootFileRow = document.querySelector('#changes-section .diff-item[data-path="package.json"]');
  assert.ok(folderRow, 'expected folder row');
  assert.ok(childFileRow, 'expected child file row');
  assert.ok(rootFileRow, 'expected root file row');

  assert.equal(folderRow.style.paddingLeft, '12px');
  assert.equal(rootFileRow.style.paddingLeft, '12px');
  assert.equal(childFileRow.style.paddingLeft, '36px');

  const rootFileChildClasses = Array.from(rootFileRow.children).map((child) => child.className);
  assert.equal(rootFileChildClasses[0], 'diff-path diff-file-path');
  assert.match(rootFileChildClasses[1], /diff-status/);
  assert.equal(rootFileRow.children.length, 2);

  const css = await readFile(new URL('../extensions/sz-git-view/dist/git-view.css', import.meta.url), 'utf8');
  assert.match(css, /\.diff-file-path\{[^}]*flex:none/);
});

test('Git View expanded commit detail shows only the commit body', async () => {
  const { getHtmlTemplate } = await freshTemplateModule();
  const html = getHtmlTemplate();
  const scriptBlocks = html.split('<script>\n');
  const clientScript = scriptBlocks.at(-1)?.split('\n</script>')[0] ?? '';

  assert.doesNotMatch(clientScript, /Full: /);
  assert.doesNotMatch(clientScript, /Author: /);
  assert.doesNotMatch(clientScript, /Date: /);
  assert.match(clientScript, /var body = escapeHtml\(commit\.body \|\| ''\)/);
  assert.match(clientScript, /'<div class="commit-detail" id="detail-' \+ hash \+ '">' \+\s*body \+/);
  assert.doesNotMatch(clientScript, /'<div class="commit-detail" id="detail-' \+ hash \+ '">' \+\s*msg \+/);
});
