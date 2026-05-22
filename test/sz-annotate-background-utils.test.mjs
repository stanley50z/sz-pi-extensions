import test from 'node:test';
import assert from 'node:assert/strict';
import { TOGGLE_ANNOTATION_COMMAND, isRestrictedUrl, resolveCaptureWindowId } from '../chrome-extensions/sz-annotate/src/background-utils.mjs';

test('uses explicit popup-provided window id for screenshot capture', () => {
  const windowId = resolveCaptureWindowId(
    { windowId: 42 },
    {},
    { windows: { WINDOW_ID_CURRENT: -2 } },
  );

  assert.equal(windowId, 42);
});

test('falls back to sender tab window id for content-script messages', () => {
  const windowId = resolveCaptureWindowId(
    {},
    { tab: { windowId: 7 } },
    { windows: { WINDOW_ID_CURRENT: -2 } },
  );

  assert.equal(windowId, 7);
});

test('falls back to Chrome current window constant when no tab sender exists', () => {
  const windowId = resolveCaptureWindowId(
    {},
    {},
    { windows: { WINDOW_ID_CURRENT: -2 } },
  );

  assert.equal(windowId, -2);
});

test('exports the annotation toggle command name', () => {
  assert.equal(TOGGLE_ANNOTATION_COMMAND, 'toggle-annotation');
});

test('detects restricted browser pages for shortcut toggling', () => {
  assert.equal(isRestrictedUrl('chrome://extensions'), true);
  assert.equal(isRestrictedUrl('chrome-extension://abc/popup.html'), true);
  assert.equal(isRestrictedUrl('https://example.com'), false);
});
