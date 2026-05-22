import { resolveCaptureWindowId } from './src/background-utils.mjs';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'SZ_ANNOTATE_CAPTURE_VISIBLE_TAB') return false;

  const windowId = resolveCaptureWindowId(message, sender, chrome);
  chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    if (!dataUrl) {
      sendResponse({ ok: false, error: 'Chrome returned an empty screenshot.' });
      return;
    }
    sendResponse({ ok: true, dataUrl });
  });

  return true;
});
