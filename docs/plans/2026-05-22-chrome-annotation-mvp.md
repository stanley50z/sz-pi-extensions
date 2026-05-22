# Chrome Annotation MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Priority rule:** Tasks tagged `[USER-REQ]` implement non-negotiable user requirements. Tasks tagged `[AGENT-DECISION]` implement flexible agent design decisions. If a conflict arises during implementation, agent decisions yield to user requirements. If a user requirement cannot be met, stop and surface to the user.

**Goal:** Build a standalone Chrome-only annotation MVP for local dev pages that lets the user select DOM elements, add comments, copy a structured Markdown prompt, and capture one combined highlighted screenshot.

**Architecture:** Add a sideloadable Manifest V3 extension under `chrome-extensions/sz-annotate/`, separate from Pi extensions. Use popup controls, dynamically imported content-script modules for annotation UI/state, and a background service worker for visible-tab screenshot capture. Keep persistence, Pi direct-send, native messaging, full-page screenshots, and page-DOM APIs out of the MVP.

**Tech Stack:** Chrome Extension Manifest V3, vanilla JavaScript ES modules, Shadow DOM for overlay isolation, Chrome `tabs`/`scripting`/`activeTab` APIs, Node built-in test runner for formatter and selector tests.

---

## File Structure

Create these files:

- `chrome-extensions/sz-annotate/manifest.json` — Manifest V3 metadata, permissions, popup, background service worker, content bootstrap, web-accessible module resources.
- `chrome-extensions/sz-annotate/background.js` — screenshot capture and message handling using `chrome.tabs.captureVisibleTab`.
- `chrome-extensions/sz-annotate/popup/popup.html` — popup layout with Start, Stop, Copy Prompt, Screenshot, Clear controls and status area.
- `chrome-extensions/sz-annotate/popup/popup.css` — compact popup styling.
- `chrome-extensions/sz-annotate/popup/popup.js` — active-tab messaging, content-script injection fallback, copy/download orchestration, error display.
- `chrome-extensions/sz-annotate/content/bootstrap.js` — classic content script loaded by the manifest; dynamically imports `src/content-main.mjs`.
- `chrome-extensions/sz-annotate/src/content-main.mjs` — annotation-mode runtime: state, hover targeting, click interception, modal, markers, toolbar, screenshot overlay prep.
- `chrome-extensions/sz-annotate/src/formatter.mjs` — pure Markdown formatter.
- `chrome-extensions/sz-annotate/src/selector.mjs` — best-effort selector generation.
- `chrome-extensions/sz-annotate/src/metadata.mjs` — element metadata extraction.
- `chrome-extensions/sz-annotate/src/dom-utils.mjs` — shared DOM helpers: clipping text, viewport checks, extension UI exclusion.
- `chrome-extensions/sz-annotate/README.md` — load-unpacked instructions and MVP usage.
- `test/sz-annotate-formatter.test.mjs` — Node tests for Markdown output.
- `test/sz-annotate-selector.test.mjs` — Node/linkedom tests for selector generation.

Modify these files:

- `README.md` — add a short section pointing to the Chrome annotation extension and load-unpacked workflow.

Do not modify:

- `package.json` unless tests require no existing dependency changes. Existing `linkedom` is enough for selector tests.
- `pi.extensions` config. This MVP is not a Pi extension.

---

## Task 1: Add pure Markdown formatter [USER-REQ]

**Requirement:** Implements "Copy/paste is acceptable for MVP" and "Copy Markdown prompt" behavior from the Chrome-only MVP.

**Files:**
- Create: `chrome-extensions/sz-annotate/src/formatter.mjs`
- Create: `test/sz-annotate-formatter.test.mjs`

- [ ] **Step 1: Write failing formatter tests**

Create `test/sz-annotate-formatter.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAnnotationPrompt } from '../chrome-extensions/sz-annotate/src/formatter.mjs';

test('formats numbered UI annotations as Markdown', () => {
  const markdown = formatAnnotationPrompt({
    url: 'http://localhost:3000/dashboard',
    viewport: { width: 1440, height: 900 },
    screenshotIncluded: true,
    annotations: [
      {
        index: 1,
        tagName: 'button',
        selector: 'button[data-testid="save"]',
        text: 'Save changes',
        comment: 'Make this the primary action.',
        idAttribute: '',
        classes: ['btn', 'ghost'],
        attributes: { 'data-testid': 'save', type: 'button' },
        styles: { display: 'inline-flex', backgroundColor: 'rgba(0, 0, 0, 0)' },
      },
    ],
  });

  assert.match(markdown, /^# UI Annotations/);
  assert.match(markdown, /URL: http:\/\/localhost:3000\/dashboard/);
  assert.match(markdown, /Viewport: 1440x900/);
  assert.match(markdown, /Screenshot: Combined screenshot contains numbered highlights/);
  assert.match(markdown, /## Annotation 1/);
  assert.match(markdown, /Comment: Make this the primary action\./);
  assert.match(markdown, /Element: `<button>`/);
  assert.match(markdown, /Selector: `button\[data-testid="save"\]`/);
  assert.match(markdown, /Text: "Save changes"/);
  assert.match(markdown, /Classes: `btn`, `ghost`/);
  assert.match(markdown, /Attributes: data-testid="save", type="button"/);
});

test('formats empty annotations with a useful message', () => {
  const markdown = formatAnnotationPrompt({
    url: 'http://localhost:3000',
    viewport: { width: 390, height: 844 },
    screenshotIncluded: false,
    annotations: [],
  });

  assert.match(markdown, /No annotations captured/);
});
```

- [ ] **Step 2: Run formatter tests to verify they fail**

Run:

```bash
node --test test/sz-annotate-formatter.test.mjs
```

Expected: FAIL because `formatter.mjs` does not exist.

- [ ] **Step 3: Implement formatter**

Create `chrome-extensions/sz-annotate/src/formatter.mjs`:

```js
function escapeInline(value) {
  return String(value ?? '').replace(/`/g, '\\`').trim();
}

function quoteText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? `"${text.replace(/"/g, '\\"')}"` : '""';
}

function formatAttributes(attributes = {}) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, '\\"')}"`)
    .join(', ');
}

function formatStyles(styles = {}) {
  return Object.entries(styles)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('; ');
}

export function formatAnnotationPrompt({ url, viewport, annotations, screenshotIncluded }) {
  const lines = [
    '# UI Annotations',
    '',
    `URL: ${url || 'unknown'}`,
    `Viewport: ${viewport?.width ?? '?'}x${viewport?.height ?? '?'}`,
    screenshotIncluded
      ? 'Screenshot: Combined screenshot contains numbered highlights matching the annotations below.'
      : 'Screenshot: Not included or capture failed.',
    '',
  ];

  if (!annotations?.length) {
    lines.push('No annotations captured.');
    return lines.join('\n');
  }

  for (const annotation of annotations) {
    lines.push(`## Annotation ${annotation.index}`);
    lines.push(`Comment: ${annotation.comment || '(no comment)'}`);
    lines.push(`Element: \`<${escapeInline(annotation.tagName || 'unknown')}>\``);
    lines.push(`Selector: \`${escapeInline(annotation.selector || '')}\``);

    if (annotation.text) lines.push(`Text: ${quoteText(annotation.text)}`);
    if (annotation.idAttribute) lines.push(`ID: \`${escapeInline(annotation.idAttribute)}\``);
    if (annotation.classes?.length) lines.push(`Classes: ${annotation.classes.map((c) => `\`${escapeInline(c)}\``).join(', ')}`);

    const attrs = formatAttributes(annotation.attributes);
    if (attrs) lines.push(`Attributes: ${attrs}`);

    const styles = formatStyles(annotation.styles);
    if (styles) lines.push(`Key styles: ${styles}`);

    if (annotation.warning) lines.push(`Warning: ${annotation.warning}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
```

- [ ] **Step 4: Run formatter tests to verify they pass**

Run:

```bash
node --test test/sz-annotate-formatter.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extensions/sz-annotate/src/formatter.mjs test/sz-annotate-formatter.test.mjs
git commit -m "feat: add annotation prompt formatter"
```

---

## Task 2: Add selector generation [USER-REQ]

**Requirement:** Implements element metadata capture for selected web elements, including CSS selectors.

**Files:**
- Create: `chrome-extensions/sz-annotate/src/selector.mjs`
- Create: `test/sz-annotate-selector.test.mjs`

- [ ] **Step 1: Write failing selector tests**

Create `test/sz-annotate-selector.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { generateSelector } from '../chrome-extensions/sz-annotate/src/selector.mjs';

test('prefers id selector when unique', () => {
  const { document } = parseHTML('<main><button id="save">Save</button></main>');
  assert.equal(generateSelector(document.querySelector('button')), '#save');
});

test('prefers data-testid when available and unique', () => {
  const { document } = parseHTML('<main><button data-testid="save-button">Save</button></main>');
  assert.equal(generateSelector(document.querySelector('button')), 'button[data-testid="save-button"]');
});

test('falls back to class and nth-of-type path', () => {
  const { document } = parseHTML('<main><section><button class="btn primary">One</button><button class="btn primary">Two</button></section></main>');
  const selector = generateSelector(document.querySelectorAll('button')[1]);
  assert.match(selector, /button/);
  assert.equal(document.querySelector(selector)?.textContent, 'Two');
});
```

- [ ] **Step 2: Run selector tests to verify they fail**

Run:

```bash
node --test test/sz-annotate-selector.test.mjs
```

Expected: FAIL because `selector.mjs` does not exist.

- [ ] **Step 3: Implement selector generation**

Create `chrome-extensions/sz-annotate/src/selector.mjs` with:

- `cssEscape(value)` helper that uses `CSS.escape` when available and a minimal fallback for tests.
- `isUnique(element, selector)` helper using `ownerDocument.querySelectorAll`.
- Preference order:
  1. unique `#id`,
  2. unique `tag[data-testid="..."]`, `tag[data-test="..."]`, `tag[data-cy="..."]`,
  3. unique `tag[aria-label="..."]` or `tag[name="..."]`,
  4. unique `tag.class1.class2` using up to three stable classes,
  5. ancestor path with `:nth-of-type()`.

Implementation skeleton:

```js
const PREFERRED_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name'];

export function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function attrEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isUnique(element, selector) {
  try {
    const matches = element.ownerDocument.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

function stableClasses(element) {
  return Array.from(element.classList || [])
    .filter((className) => !/^(hover|focus|active|disabled|selected|open|closed)$/.test(className))
    .filter((className) => !className.includes(':'))
    .slice(0, 3);
}

function nthOfType(element) {
  let index = 1;
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (sibling.localName === element.localName) index += 1;
    sibling = sibling.previousElementSibling;
  }
  return `${element.localName}:nth-of-type(${index})`;
}

export function generateSelector(element) {
  if (!element?.ownerDocument || !element.localName) return '';

  if (element.id) {
    const selector = `#${cssEscape(element.id)}`;
    if (isUnique(element, selector)) return selector;
  }

  for (const attr of PREFERRED_ATTRIBUTES) {
    const value = element.getAttribute?.(attr);
    if (!value) continue;
    const selector = `${element.localName}[${attr}="${attrEscape(value)}"]`;
    if (isUnique(element, selector)) return selector;
  }

  const classes = stableClasses(element);
  if (classes.length) {
    const selector = `${element.localName}.${classes.map(cssEscape).join('.')}`;
    if (isUnique(element, selector)) return selector;
  }

  const parts = [];
  let current = element;
  while (current && current.nodeType === 1 && current.localName !== 'html') {
    let part = current.localName;
    const currentClasses = stableClasses(current);
    if (current.id) {
      part = `#${cssEscape(current.id)}`;
      parts.unshift(part);
      break;
    }
    if (currentClasses.length) part += `.${currentClasses.map(cssEscape).join('.')}`;
    if (!isUnique(current, parts.length ? `${part} > ${parts.join(' > ')}` : part)) {
      part = nthOfType(current);
    }
    parts.unshift(part);
    const selector = parts.join(' > ');
    if (isUnique(element, selector)) return selector;
    current = current.parentElement;
  }

  return parts.join(' > ') || element.localName;
}
```

- [ ] **Step 4: Run selector tests to verify they pass**

Run:

```bash
node --test test/sz-annotate-selector.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extensions/sz-annotate/src/selector.mjs test/sz-annotate-selector.test.mjs
git commit -m "feat: add annotation selector generation"
```

---

## Task 3: Add metadata extraction [USER-REQ]

**Requirement:** Implements basic metadata capture for each selected element.

**Files:**
- Create: `chrome-extensions/sz-annotate/src/dom-utils.mjs`
- Create: `chrome-extensions/sz-annotate/src/metadata.mjs`
- Modify: `test/sz-annotate-selector.test.mjs` or create `test/sz-annotate-metadata.test.mjs`

- [ ] **Step 1: Write failing metadata tests**

Create `test/sz-annotate-metadata.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { collectElementMetadata } from '../chrome-extensions/sz-annotate/src/metadata.mjs';

test('collects useful element metadata', () => {
  const { document, window } = parseHTML('<button id="save" class="btn primary" data-testid="save" aria-label="Save form" type="button"> Save changes </button>');
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  const element = document.querySelector('button');
  element.getBoundingClientRect = () => ({ x: 10, y: 20, width: 120, height: 40, top: 20, left: 10, right: 130, bottom: 60 });

  const metadata = collectElementMetadata(element, { index: 1, comment: 'Use primary styling.' });

  assert.equal(metadata.index, 1);
  assert.equal(metadata.tagName, 'button');
  assert.equal(metadata.idAttribute, 'save');
  assert.deepEqual(metadata.classes, ['btn', 'primary']);
  assert.equal(metadata.attributes['data-testid'], 'save');
  assert.equal(metadata.attributes['aria-label'], 'Save form');
  assert.equal(metadata.comment, 'Use primary styling.');
  assert.equal(metadata.rect.width, 120);
});
```

- [ ] **Step 2: Run metadata tests to verify they fail**

Run:

```bash
node --test test/sz-annotate-metadata.test.mjs
```

Expected: FAIL because `metadata.mjs` does not exist.

- [ ] **Step 3: Implement DOM utilities and metadata extraction**

Create `chrome-extensions/sz-annotate/src/dom-utils.mjs`:

```js
export function clipText(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function isInViewport(rect, viewport = globalThis.window) {
  return rect.bottom > 0 && rect.right > 0 && rect.top < viewport.innerHeight && rect.left < viewport.innerWidth;
}

export function isExtensionUiElement(element) {
  return Boolean(element?.closest?.('[data-sz-annotate-root]'));
}
```

Create `chrome-extensions/sz-annotate/src/metadata.mjs`:

```js
import { clipText } from './dom-utils.mjs';
import { generateSelector } from './selector.mjs';

const USEFUL_ATTRIBUTES = ['role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'data-testid', 'data-test', 'data-cy', 'href', 'type', 'name', 'placeholder', 'alt', 'title'];
const USEFUL_STYLES = ['display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'padding', 'margin', 'borderRadius', 'width', 'height'];

function collectAttributes(element) {
  const attributes = {};
  for (const name of USEFUL_ATTRIBUTES) {
    const value = element.getAttribute?.(name);
    if (value) attributes[name] = value;
  }
  return attributes;
}

function collectStyles(element) {
  const styles = {};
  const computed = globalThis.getComputedStyle?.(element);
  if (!computed) return styles;
  for (const name of USEFUL_STYLES) {
    const value = computed[name] || computed.getPropertyValue?.(name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
    if (value) styles[name] = value;
  }
  return styles;
}

function rectToObject(rect) {
  return {
    x: Math.round(rect.x ?? rect.left ?? 0),
    y: Math.round(rect.y ?? rect.top ?? 0),
    top: Math.round(rect.top ?? rect.y ?? 0),
    left: Math.round(rect.left ?? rect.x ?? 0),
    right: Math.round(rect.right ?? 0),
    bottom: Math.round(rect.bottom ?? 0),
    width: Math.round(rect.width ?? 0),
    height: Math.round(rect.height ?? 0),
  };
}

export function collectElementMetadata(element, { index, comment }) {
  const rect = element.getBoundingClientRect();
  return {
    id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    index,
    url: globalThis.location?.href || '',
    selector: generateSelector(element),
    tagName: element.localName || element.tagName?.toLowerCase() || 'unknown',
    idAttribute: element.id || '',
    classes: Array.from(element.classList || []).slice(0, 12),
    text: clipText(element.innerText || element.textContent || ''),
    rect: rectToObject(rect),
    attributes: collectAttributes(element),
    styles: collectStyles(element),
    comment: comment || '',
    createdAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run metadata and existing tests**

Run:

```bash
node --test test/sz-annotate-metadata.test.mjs test/sz-annotate-selector.test.mjs test/sz-annotate-formatter.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extensions/sz-annotate/src/dom-utils.mjs chrome-extensions/sz-annotate/src/metadata.mjs test/sz-annotate-metadata.test.mjs
git commit -m "feat: capture annotation element metadata"
```

---

## Task 4: Add Chrome extension manifest and shell UI [USER-REQ]

**Requirement:** Implements Chrome-only MVP, browser extension injection, and not building annotation mode into the target web app.

**Files:**
- Create: `chrome-extensions/sz-annotate/manifest.json`
- Create: `chrome-extensions/sz-annotate/background.js`
- Create: `chrome-extensions/sz-annotate/content/bootstrap.js`
- Create: `chrome-extensions/sz-annotate/popup/popup.html`
- Create: `chrome-extensions/sz-annotate/popup/popup.css`
- Create: `chrome-extensions/sz-annotate/popup/popup.js`

- [ ] **Step 1: Create manifest**

Create `chrome-extensions/sz-annotate/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "SZ Annotate",
  "version": "0.1.0",
  "description": "Chrome-only visual annotation MVP for local dev pages.",
  "permissions": ["activeTab", "scripting", "tabs", "downloads"],
  "host_permissions": ["http://localhost/*", "http://127.0.0.1/*", "http://0.0.0.0/*", "http://[::1]/*", "https://localhost/*", "<all_urls>"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_title": "SZ Annotate",
    "default_popup": "popup/popup.html"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/bootstrap.js"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["src/*.mjs"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

- [ ] **Step 2: Create background service worker stub**

Create `chrome-extensions/sz-annotate/background.js`:

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'SZ_ANNOTATE_CAPTURE_VISIBLE_TAB') return false;

  chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: 'png' }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    sendResponse({ ok: true, dataUrl });
  });

  return true;
});
```

- [ ] **Step 3: Create content bootstrap stub**

Create `chrome-extensions/sz-annotate/content/bootstrap.js`:

```js
(() => {
  if (globalThis.__szAnnotateBootstrapLoaded) return;
  globalThis.__szAnnotateBootstrapLoaded = true;

  import(chrome.runtime.getURL('src/content-main.mjs')).catch((error) => {
    console.error('[SZ Annotate] Failed to load content module', error);
  });
})();
```

Temporarily create `chrome-extensions/sz-annotate/src/content-main.mjs` with a no-op message responder until Task 5 replaces it:

```js
if (!globalThis.__szAnnotateRuntimeLoaded) {
  globalThis.__szAnnotateRuntimeLoaded = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SZ_ANNOTATE_STATUS') {
      sendResponse({ ok: true, active: false, count: 0 });
      return true;
    }
    return false;
  });
}
```

- [ ] **Step 4: Create popup HTML/CSS/JS shell**

Create `chrome-extensions/sz-annotate/popup/popup.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="popup.css">
  </head>
  <body>
    <main>
      <h1>SZ Annotate</h1>
      <p id="status">Checking tab…</p>
      <button id="start">Start annotation</button>
      <button id="stop">Stop</button>
      <button id="copy">Copy prompt</button>
      <button id="screenshot">Download screenshot</button>
      <button id="clear">Clear</button>
      <textarea id="fallback" hidden readonly></textarea>
    </main>
    <script type="module" src="popup.js"></script>
  </body>
</html>
```

Create minimal `popup.css` and `popup.js` with status lookup and disabled buttons until content runtime exists.

- [ ] **Step 5: Validate manifest shape manually**

Run:

```bash
node -e "const m=require('node:fs').readFileSync('chrome-extensions/sz-annotate/manifest.json','utf8'); JSON.parse(m); console.log('manifest ok')"
```

Expected: `manifest ok`.

- [ ] **Step 6: Commit**

```bash
git add chrome-extensions/sz-annotate/manifest.json chrome-extensions/sz-annotate/background.js chrome-extensions/sz-annotate/content/bootstrap.js chrome-extensions/sz-annotate/src/content-main.mjs chrome-extensions/sz-annotate/popup/popup.html chrome-extensions/sz-annotate/popup/popup.css chrome-extensions/sz-annotate/popup/popup.js
git commit -m "feat: add annotation Chrome extension shell"
```

---

## Task 5: Implement annotation mode overlay [USER-REQ]

**Requirement:** Implements hover selection, click interception, comment entry, numbered markers, and clear/exit behavior.

**Files:**
- Modify: `chrome-extensions/sz-annotate/src/content-main.mjs`
- Modify: `chrome-extensions/sz-annotate/popup/popup.js`

- [ ] **Step 1: Implement content runtime state and Shadow DOM root**

In `content-main.mjs`, create one runtime object:

```js
const state = {
  active: false,
  annotations: [],
  hoveredElement: null,
  root: null,
  shadow: null,
  highlight: null,
  toolbar: null,
  modal: null,
  screenshotMode: false,
};
```

Create `ensureOverlay()` that appends a fixed host element with `data-sz-annotate-root="true"`, attaches Shadow DOM, and injects CSS for highlight, markers, toolbar, and modal.

- [ ] **Step 2: Implement start/stop listeners**

Add capture-phase listeners when active:

- `mousemove` updates hover target and highlight rectangle.
- `click` calls `event.preventDefault()`, `event.stopPropagation()`, `event.stopImmediatePropagation()`, then opens comment modal for the target.
- `keydown` exits on Escape.

Ignore elements inside `[data-sz-annotate-root]`.

- [ ] **Step 3: Implement comment modal and marker creation**

On click, show a textarea modal. On Save:

- call `collectElementMetadata(target, { index: state.annotations.length + 1, comment })`,
- append to `state.annotations`,
- render a numbered marker positioned at the element rect,
- close modal,
- update toolbar count.

- [ ] **Step 4: Implement marker and toolbar rendering**

Toolbar shows:

- `SZ Annotate · N items`,
- Copy Prompt button,
- Clear button,
- Exit button.

Markers should be visible fixed-position numbered badges. Recompute positions on scroll and resize.

- [ ] **Step 5: Implement content-script message API**

Handle messages:

- `SZ_ANNOTATE_STATUS` → `{ ok, active, count }`
- `SZ_ANNOTATE_START` → start mode
- `SZ_ANNOTATE_STOP` → stop mode but keep current annotations visible or hidden? For MVP: remove hover/listeners but keep markers until clear.
- `SZ_ANNOTATE_CLEAR` → clear annotations and overlays
- `SZ_ANNOTATE_GET_PROMPT` → return Markdown using `formatAnnotationPrompt`
- `SZ_ANNOTATE_PREPARE_SCREENSHOT` → force marker/highlight overlay visibility and return warnings
- `SZ_ANNOTATE_FINISH_SCREENSHOT` → restore normal state

- [ ] **Step 6: Wire popup controls to content messages**

In `popup.js`, implement:

- active tab lookup,
- message send helper,
- injection fallback using `chrome.scripting.executeScript` for `content/bootstrap.js`,
- button handlers for start/stop/clear/copy.

- [ ] **Step 7: Manual smoke test in Chrome**

Load unpacked extension from `chrome-extensions/sz-annotate/`, open `http://localhost:<any>`, then verify:

- Start annotation activates hover highlight.
- Clicking a link/button does not trigger the page action.
- Comment save creates numbered marker.
- Escape exits annotation mode.
- Clear removes markers.

Expected: all smoke checks pass.

- [ ] **Step 8: Commit**

```bash
git add chrome-extensions/sz-annotate/src/content-main.mjs chrome-extensions/sz-annotate/popup/popup.js
git commit -m "feat: add browser annotation overlay"
```

---

## Task 6: Implement copy prompt workflow [USER-REQ]

**Requirement:** Implements one-click copy prompt for manual paste-back into Pi.

**Files:**
- Modify: `chrome-extensions/sz-annotate/popup/popup.js`
- Modify: `chrome-extensions/sz-annotate/src/content-main.mjs`

- [ ] **Step 1: Implement copy handler in popup**

When Copy Prompt is clicked:

1. Request `SZ_ANNOTATE_GET_PROMPT` from content script.
2. If no annotations, show "No annotations to copy."
3. Attempt `navigator.clipboard.writeText(markdown)`.
4. On success, show "Prompt copied."
5. On failure, reveal fallback textarea with the Markdown selected.

- [ ] **Step 2: Ensure content formatter includes current viewport**

`SZ_ANNOTATE_GET_PROMPT` should pass:

```js
{
  url: location.href,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  screenshotIncluded: false,
  annotations: state.annotations,
}
```

The screenshot flag becomes true in Task 7 when capture succeeds.

- [ ] **Step 3: Manual test copy behavior**

In Chrome:

- create two annotations,
- click Copy Prompt,
- paste into a text editor,
- verify numbered Markdown matches markers.

Expected: prompt text copies; fallback textarea appears only if clipboard fails.

- [ ] **Step 4: Run automated tests**

Run:

```bash
npm test
```

Expected: all Node tests pass.

- [ ] **Step 5: Commit**

```bash
git add chrome-extensions/sz-annotate/popup/popup.js chrome-extensions/sz-annotate/src/content-main.mjs
git commit -m "feat: copy annotation prompt from Chrome extension"
```

---

## Task 7: Implement combined screenshot capture [USER-REQ]

**Requirement:** Implements "Each annotation automatically contributes to a screenshot" and "Use one combined screenshot."

**Files:**
- Modify: `chrome-extensions/sz-annotate/background.js`
- Modify: `chrome-extensions/sz-annotate/popup/popup.js`
- Modify: `chrome-extensions/sz-annotate/src/content-main.mjs`

- [ ] **Step 1: Implement screenshot preparation in content runtime**

`SZ_ANNOTATE_PREPARE_SCREENSHOT` should:

- ensure overlay is visible,
- render marker badges and outline rectangles for all annotations whose elements can still be found by selector,
- mark annotations outside viewport with warnings,
- return `{ ok: true, warnings: [...] }`.

Use saved rects if the live element cannot be found, but include a warning.

- [ ] **Step 2: Implement capture in background service worker**

Ensure `background.js` returns `{ ok: true, dataUrl }` or `{ ok: false, error }` for `SZ_ANNOTATE_CAPTURE_VISIBLE_TAB`.

- [ ] **Step 3: Implement screenshot download in popup**

When Screenshot button is clicked:

1. Send `SZ_ANNOTATE_PREPARE_SCREENSHOT`.
2. Send runtime message `SZ_ANNOTATE_CAPTURE_VISIBLE_TAB`.
3. Send `SZ_ANNOTATE_FINISH_SCREENSHOT`.
4. If capture succeeds, download `sz-annotate-YYYYMMDD-HHMMSS.png` using `chrome.downloads.download` with a data URL.
5. Show warnings if any annotations are outside the viewport.

- [ ] **Step 4: Integrate screenshot with Copy Prompt action**

Copy Prompt should:

- prepare screenshot,
- capture screenshot,
- download the screenshot automatically or enable a "Download screenshot" button with captured data,
- copy Markdown with `screenshotIncluded: true` when capture succeeds,
- copy Markdown with `screenshotIncluded: false` and show error when capture fails.

- [ ] **Step 5: Manual screenshot smoke test**

In Chrome:

- create multiple annotations visible in viewport,
- click Copy Prompt,
- verify downloaded/captured PNG includes numbered highlights,
- verify pasted Markdown says screenshot contains numbered highlights.

Expected: one combined viewport screenshot contains all visible numbered annotations.

- [ ] **Step 6: Test outside viewport warning**

Create one annotation, scroll so it is outside the viewport, then copy.

Expected: UI warns that screenshot may omit some annotations; Markdown still includes metadata.

- [ ] **Step 7: Commit**

```bash
git add chrome-extensions/sz-annotate/background.js chrome-extensions/sz-annotate/popup/popup.js chrome-extensions/sz-annotate/src/content-main.mjs
git commit -m "feat: capture combined annotation screenshot"
```

---

## Task 8: Add restricted-page and failure handling [USER-REQ]

**Requirement:** Implements separate extension behavior on supported pages and clear errors for restricted pages, clipboard failures, screenshot failures, and no annotations.

**Files:**
- Modify: `chrome-extensions/sz-annotate/popup/popup.js`
- Modify: `chrome-extensions/sz-annotate/src/content-main.mjs`

- [ ] **Step 1: Add restricted URL detection in popup**

Add helper:

```js
function isRestrictedUrl(url = '') {
  return /^(chrome|edge|about|devtools|chrome-extension):/.test(url) || url.startsWith('https://chrome.google.com/webstore');
}
```

Disable action buttons and show a clear message when restricted.

- [ ] **Step 2: Harden content-script message failures**

In popup message helper:

- catch `chrome.runtime.lastError`,
- try bootstrap injection once,
- if still failing, show "Cannot inject annotation script on this page."

- [ ] **Step 3: Add no-annotations handling**

If prompt/screenshot requested with zero annotations, show "No annotations to copy" and do not capture screenshot.

- [ ] **Step 4: Add clipboard fallback**

Ensure fallback textarea appears, receives markdown, and calls `.select()` when clipboard write fails.

- [ ] **Step 5: Manual error tests**

Verify:

- Popup on `chrome://extensions` reports restricted page.
- Copy with no annotations reports no annotations.
- Clearing while inactive does not throw.
- Screenshot failure still leaves Markdown available.

Expected: clear visible errors, no uncaught exceptions in service worker/content console.

- [ ] **Step 6: Commit**

```bash
git add chrome-extensions/sz-annotate/popup/popup.js chrome-extensions/sz-annotate/src/content-main.mjs
git commit -m "fix: handle annotation extension error states"
```

---

## Task 9: Add documentation [AGENT-DECISION]

**Requirement:** Serves sideloadable Chrome extension and local dev workflow decisions.

**Files:**
- Create: `chrome-extensions/sz-annotate/README.md`
- Modify: `README.md`

- [ ] **Step 1: Write extension README**

Create `chrome-extensions/sz-annotate/README.md` with:

- What SZ Annotate does.
- MVP scope and non-goals.
- Load-unpacked installation steps:
  1. Open `chrome://extensions`.
  2. Enable Developer mode.
  3. Click Load unpacked.
  4. Select `chrome-extensions/sz-annotate/`.
- Usage steps:
  1. Open local dev page.
  2. Click extension icon.
  3. Start annotation.
  4. Select elements and comment.
  5. Copy prompt and use downloaded screenshot.
- Known limitations: viewport screenshot only, session-only annotations, no Pi direct send yet.

- [ ] **Step 2: Update root README**

Add a short section near Features or Tools:

```markdown
## Chrome Annotation MVP

This repo includes a standalone Chrome extension at `chrome-extensions/sz-annotate/` for local UI annotation. It is not a Pi extension yet. Load it unpacked in Chrome, annotate localhost pages, copy the generated Markdown prompt, and attach the combined highlighted screenshot manually.
```

- [ ] **Step 3: Commit**

```bash
git add chrome-extensions/sz-annotate/README.md README.md
git commit -m "docs: document Chrome annotation MVP"
```

---

## Task 10: Final verification [USER-REQ]

**Requirement:** Verifies the full Chrome-only MVP workflow and protects deferred Pi integration/non-persistence boundaries.

**Files:**
- Modify only if fixes are found during verification.

- [ ] **Step 1: Run full automated test suite**

Run:

```bash
npm test
```

Expected: all tests pass, including existing repo tests and new `sz-annotate` tests.

- [ ] **Step 2: Validate manifest JSON**

Run:

```bash
node -e "JSON.parse(require('node:fs').readFileSync('chrome-extensions/sz-annotate/manifest.json','utf8')); console.log('manifest ok')"
```

Expected: `manifest ok`.

- [ ] **Step 3: Manual end-to-end test**

In Chrome:

1. Load unpacked extension from `chrome-extensions/sz-annotate/`.
2. Open a local dev page.
3. Start annotation.
4. Hover an element and confirm highlight tracks pointer.
5. Click an app button/link and confirm the app action is blocked.
6. Save annotation #1.
7. Save annotation #2.
8. Click Copy Prompt.
9. Paste prompt into a text editor.
10. Open the downloaded screenshot.
11. Verify markers in screenshot match annotation numbers in Markdown.
12. Clear annotations.
13. Refresh page and verify persistence is not expected.

Expected: workflow matches the spec.

- [ ] **Step 4: Check git status**

Run:

```bash
git status --short
```

Expected: clean or only intentional verification artifacts. Do not commit screenshots/downloads.

- [ ] **Step 5: Commit any verification fixes**

If fixes were needed:

```bash
git add <changed-files>
git commit -m "fix: complete Chrome annotation MVP verification"
```

If no fixes were needed, skip commit.

---

## Requirement Traceability

- Build Chrome-only MVP first → Tasks 1-10.
- Defer Pi integration → Tasks 4, 9, 10 keep project outside `pi.extensions`; future integration documented only.
- Do not build annotator mode into target app → Tasks 4-8 use Chrome content scripts and overlays only.
- Use for local dev pages → Tasks 4, 9, 10 document and test localhost workflow.
- Use browser extension injection rather than wrapper/iframe → Tasks 4-8.
- Copy/paste acceptable for MVP → Tasks 1, 6, 7.
- Annotation screenshot with component highlighted → Task 7.
- One combined screenshot → Task 7.
- Persistence later → Tasks 5, 9, 10 maintain session-only behavior and document limitation.

## Execution Notes

- Do not add a Pi extension in this implementation.
- Do not add native messaging.
- Do not add server-side routing, auth, or sync.
- Prefer small focused commits after each task.
- If Chrome content-script ES module loading fails in manual testing, stop and adapt the bootstrap/module loading pattern before continuing; do not silently bundle or add a build system without updating the plan/spec.
