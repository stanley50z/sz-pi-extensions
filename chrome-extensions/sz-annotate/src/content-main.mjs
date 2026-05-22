import { writePromptAndImageToClipboard } from './clipboard.mjs';
import { formatAnnotationPrompt } from './formatter.mjs';
import { collectElementMetadata } from './metadata.mjs';
import { getAnnotationCursorCss, isExtensionUiElement, isInViewport, shouldShowAnnotationChrome, shouldSubmitCommentKey } from './dom-utils.mjs';

if (!globalThis.__szAnnotateRuntimeLoaded) {
  globalThis.__szAnnotateRuntimeLoaded = true;

  const state = {
    active: false,
    annotations: [],
    hoveredElement: null,
    root: null,
    shadow: null,
    highlight: null,
    toolbar: null,
    modal: null,
    markerLayer: null,
    screenshotLayer: null,
    screenshotMode: false,
    cursorStyle: null,
  };

  function ensureOverlay() {
    if (state.shadow) return;
    state.root = document.createElement('div');
    state.root.setAttribute('data-sz-annotate-root', 'true');
    state.root.style.position = 'fixed';
    state.root.style.inset = '0';
    state.root.style.zIndex = '2147483647';
    state.root.style.pointerEvents = 'none';
    document.documentElement.appendChild(state.root);
    state.shadow = state.root.attachShadow({ mode: 'open' });
    state.shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .highlight, .shot-outline { position: fixed; border: 2px solid #38bdf8; background: rgba(56, 189, 248, 0.12); border-radius: 4px; box-sizing: border-box; pointer-events: none; }
        .highlight { box-shadow: 0 0 0 99999px rgba(15, 23, 42, 0.08); }
        .marker, .shot-badge { position: fixed; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; background: #2563eb; color: white; font: 700 13px/1 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.35); pointer-events: auto; }
        .toolbar { position: fixed; right: 16px; bottom: 16px; display: flex; gap: 8px; align-items: center; border: 1px solid #334155; border-radius: 12px; background: #0f172a; color: #e2e8f0; padding: 8px; font: 13px system-ui, sans-serif; pointer-events: auto; box-shadow: 0 10px 28px rgba(0,0,0,.35); }
        .toolbar button, .modal button { border: 1px solid #475569; border-radius: 8px; background: #1e293b; color: #e2e8f0; cursor: pointer; font: inherit; padding: 6px 9px; }
        .toolbar button:hover, .modal button:hover { background: #334155; }
        .modal { position: fixed; z-index: 2; display: grid; gap: 8px; width: min(320px, calc(100vw - 32px)); border: 1px solid #334155; border-radius: 12px; background: #0f172a; color: #e2e8f0; padding: 12px; font: 13px system-ui, sans-serif; pointer-events: auto; box-shadow: 0 16px 42px rgba(0,0,0,.45); }
        .modal textarea { min-height: 90px; resize: vertical; border: 1px solid #475569; border-radius: 8px; background: #020617; color: #e2e8f0; padding: 8px; font: inherit; }
        .modal .row { display: flex; justify-content: flex-end; gap: 8px; }
        .shot-outline { border-color: #22c55e; background: rgba(34, 197, 94, .14); }
        .shot-badge { background: #22c55e; color: #052e16; }
      </style>
      <div class="highlight" hidden></div>
      <div class="marker-layer"></div>
      <div class="screenshot-layer"></div>
      <div class="toolbar" hidden></div>
    `;
    state.highlight = state.shadow.querySelector('.highlight');
    state.markerLayer = state.shadow.querySelector('.marker-layer');
    state.screenshotLayer = state.shadow.querySelector('.screenshot-layer');
    state.toolbar = state.shadow.querySelector('.toolbar');
  }

  function targetFromEvent(event) {
    const path = event.composedPath?.() || [];
    const target = path.find((node) => node?.nodeType === 1 && node instanceof Element && !isExtensionUiElement(node));
    return target && target !== document.documentElement && target !== document.body ? target : null;
  }

  function positionBox(el, rect) {
    el.style.left = `${Math.max(0, rect.left)}px`;
    el.style.top = `${Math.max(0, rect.top)}px`;
    el.style.width = `${Math.max(0, rect.width)}px`;
    el.style.height = `${Math.max(0, rect.height)}px`;
  }

  function updateHighlight(element) {
    ensureOverlay();
    if (!element || state.modal) {
      state.highlight.hidden = true;
      return;
    }
    positionBox(state.highlight, element.getBoundingClientRect());
    state.highlight.hidden = false;
  }

  function refreshMarkerPositions() {
    if (!state.shadow) return;
    for (const marker of state.markerLayer.querySelectorAll('.marker')) {
      const annotation = state.annotations.find((item) => String(item.index) === marker.dataset.index);
      if (!annotation) continue;
      const live = findAnnotatedElement(annotation);
      const rect = live?.getBoundingClientRect?.() || annotation.rect;
      marker.style.left = `${Math.max(4, rect.left - 10)}px`;
      marker.style.top = `${Math.max(4, rect.top - 10)}px`;
    }
  }

  function renderToolbar() {
    ensureOverlay();
    state.toolbar.hidden = !shouldShowAnnotationChrome(state.active);
    state.toolbar.innerHTML = `
      <strong>SZ Annotate · ${state.annotations.length} item${state.annotations.length === 1 ? '' : 's'}</strong>
      <button data-action="copy">Copy Prompt</button>
      <button data-action="clear">Clear</button>
      <button data-action="exit">Exit</button>
    `;
    state.toolbar.querySelector('[data-action="copy"]').addEventListener('click', () => {
      void copyPromptFromToolbar();
    });
    state.toolbar.querySelector('[data-action="clear"]').addEventListener('click', clearAnnotations);
    state.toolbar.querySelector('[data-action="exit"]').addEventListener('click', stopAnnotationMode);
  }

  function renderMarkers() {
    ensureOverlay();
    state.markerLayer.hidden = !shouldShowAnnotationChrome(state.active);
    state.markerLayer.innerHTML = '';
    for (const annotation of state.annotations) {
      const marker = document.createElement('div');
      marker.className = 'marker';
      marker.dataset.index = String(annotation.index);
      marker.textContent = String(annotation.index);
      state.markerLayer.appendChild(marker);
    }
    refreshMarkerPositions();
    renderToolbar();
  }

  function openCommentModal(target) {
    ensureOverlay();
    closeModal();
    const rect = target.getBoundingClientRect();
    state.modal = document.createElement('form');
    state.modal.className = 'modal';
    const left = Math.min(Math.max(16, rect.left), window.innerWidth - 336);
    const top = Math.min(Math.max(16, rect.bottom + 8), window.innerHeight - 180);
    state.modal.style.left = `${left}px`;
    state.modal.style.top = `${top}px`;
    state.modal.innerHTML = `
      <label>Annotation for &lt;${target.localName}&gt;</label>
      <textarea placeholder="Describe what should change…" autofocus></textarea>
      <div class="row"><button type="button" data-cancel>Cancel</button><button type="submit">Save</button></div>
    `;
    state.shadow.appendChild(state.modal);
    const textarea = state.modal.querySelector('textarea');
    queueMicrotask(() => textarea.focus());
    state.modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
    function saveComment() {
      const comment = textarea.value.trim();
      if (!comment) return;
      state.annotations.push(collectElementMetadata(target, { index: state.annotations.length + 1, comment }));
      closeModal();
      renderMarkers();
    }
    textarea.addEventListener('keydown', (event) => {
      if (!shouldSubmitCommentKey(event)) return;
      event.preventDefault();
      saveComment();
    });
    state.modal.addEventListener('submit', (event) => {
      event.preventDefault();
      saveComment();
    });
  }

  function closeModal() {
    state.modal?.remove();
    state.modal = null;
  }

  function onMouseMove(event) {
    if (!state.active) return;
    const target = targetFromEvent(event);
    state.hoveredElement = target;
    updateHighlight(target);
  }

  function onClick(event) {
    if (!state.active) return;
    const target = targetFromEvent(event);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openCommentModal(target);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') stopAnnotationMode();
  }

  function enableAnnotationCursor() {
    if (state.cursorStyle) return;
    state.cursorStyle = document.createElement('style');
    state.cursorStyle.setAttribute('data-sz-annotate-cursor', 'true');
    state.cursorStyle.textContent = getAnnotationCursorCss();
    document.documentElement.appendChild(state.cursorStyle);
  }

  function disableAnnotationCursor() {
    state.cursorStyle?.remove();
    state.cursorStyle = null;
  }

  function startAnnotationMode() {
    ensureOverlay();
    if (state.active) return;
    state.active = true;
    enableAnnotationCursor();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', refreshMarkerPositions, true);
    window.addEventListener('resize', refreshMarkerPositions, true);
    renderMarkers();
    renderToolbar();
  }

  function stopAnnotationMode() {
    state.active = false;
    state.hoveredElement = null;
    state.highlight && (state.highlight.hidden = true);
    closeModal();
    disableAnnotationCursor();
    if (state.markerLayer) state.markerLayer.hidden = true;
    if (state.toolbar) state.toolbar.hidden = true;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', refreshMarkerPositions, true);
    window.removeEventListener('resize', refreshMarkerPositions, true);
  }

  function clearAnnotations() {
    state.annotations = [];
    closeModal();
    state.markerLayer && (state.markerLayer.innerHTML = '');
    state.screenshotLayer && (state.screenshotLayer.innerHTML = '');
    if (state.toolbar) state.toolbar.hidden = true;
  }

  function findAnnotatedElement(annotation) {
    try {
      return annotation.selector ? document.querySelector(annotation.selector) : null;
    } catch {
      return null;
    }
  }

  function buildPrompt(screenshotIncluded, screenshotError) {
    return formatAnnotationPrompt({
      url: location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      screenshotIncluded,
      screenshotError,
      annotations: state.annotations,
    });
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }

  async function copyPromptFromToolbar() {
    let screenshotIncluded = false;
    let screenshotError = '';
    if (state.annotations.length > 0) {
      try {
        prepareScreenshot();
        const captured = await runtimeMessage({ type: 'SZ_ANNOTATE_CAPTURE_VISIBLE_TAB' });
        if (!captured?.ok) throw new Error(captured?.error || 'Screenshot capture failed');
        await writePromptAndImageToClipboard(buildPrompt(true), captured.dataUrl);
        screenshotIncluded = true;
      } catch (error) {
        screenshotError = error.message;
      } finally {
        finishScreenshot();
      }
    }
    if (!screenshotIncluded) {
      await navigator.clipboard?.writeText?.(buildPrompt(false, screenshotError));
    }
  }

  function prepareScreenshot() {
    ensureOverlay();
    const warnings = [];
    state.screenshotLayer.innerHTML = '';
    state.screenshotMode = true;
    if (state.toolbar) state.toolbar.hidden = true;
    if (state.highlight) state.highlight.hidden = true;
    if (state.markerLayer) state.markerLayer.style.display = 'none';
    for (const annotation of state.annotations) {
      const live = findAnnotatedElement(annotation);
      const rect = live?.getBoundingClientRect?.() || annotation.rect;
      if (!live) warnings.push(`Annotation ${annotation.index}: element no longer found; using saved position.`);
      if (!isInViewport(rect, window)) warnings.push(`Annotation ${annotation.index}: outside current viewport.`);

      const outline = document.createElement('div');
      outline.className = 'shot-outline';
      positionBox(outline, rect);
      state.screenshotLayer.appendChild(outline);

      const badge = document.createElement('div');
      badge.className = 'shot-badge';
      badge.textContent = String(annotation.index);
      badge.style.left = `${Math.max(4, rect.left - 12)}px`;
      badge.style.top = `${Math.max(4, rect.top - 12)}px`;
      state.screenshotLayer.appendChild(badge);
    }
    return warnings;
  }

  function finishScreenshot() {
    state.screenshotMode = false;
    state.screenshotLayer && (state.screenshotLayer.innerHTML = '');
    if (state.markerLayer) state.markerLayer.style.display = '';
    if (state.toolbar) state.toolbar.hidden = state.annotations.length === 0;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type?.startsWith?.('SZ_ANNOTATE_')) return false;
    try {
      if (message.type === 'SZ_ANNOTATE_STATUS') sendResponse({ ok: true, active: state.active, count: state.annotations.length });
      else if (message.type === 'SZ_ANNOTATE_START') { startAnnotationMode(); sendResponse({ ok: true, active: true, count: state.annotations.length }); }
      else if (message.type === 'SZ_ANNOTATE_STOP') { stopAnnotationMode(); sendResponse({ ok: true, active: false, count: state.annotations.length }); }
      else if (message.type === 'SZ_ANNOTATE_CLEAR') { clearAnnotations(); sendResponse({ ok: true, active: state.active, count: 0 }); }
      else if (message.type === 'SZ_ANNOTATE_GET_PROMPT') sendResponse({ ok: true, count: state.annotations.length, markdown: buildPrompt(Boolean(message.screenshotIncluded), message.screenshotError) });
      else if (message.type === 'SZ_ANNOTATE_PREPARE_SCREENSHOT') sendResponse({ ok: true, count: state.annotations.length, warnings: prepareScreenshot() });
      else if (message.type === 'SZ_ANNOTATE_FINISH_SCREENSHOT') { finishScreenshot(); sendResponse({ ok: true }); }
      else return false;
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return true;
  });
}
