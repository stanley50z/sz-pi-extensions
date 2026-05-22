import { TOGGLE_ANNOTATION_COMMAND, isRestrictedUrl, resolveCaptureWindowId } from './src/background-utils.mjs';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'SZ_ANNOTATE_CAPTURE_VISIBLE_TAB') {
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
  }

  if (message?.type === 'SZ_ANNOTATE_DOWNLOAD_DATA_URL') {
    chrome.downloads.download({ url: message.dataUrl, filename: message.filename, saveAs: false }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    return await sendTabMessage(tabId, { type: 'SZ_ANNOTATE_STATUS' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/bootstrap.js'] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return await sendTabMessage(tabId, { type: 'SZ_ANNOTATE_STATUS' });
  }
}

async function toggleAnnotationForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || isRestrictedUrl(tab.url || '')) return;
  const status = await ensureContentScript(tab.id);
  await sendTabMessage(tab.id, { type: status?.active ? 'SZ_ANNOTATE_STOP' : 'SZ_ANNOTATE_START' });
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== TOGGLE_ANNOTATION_COMMAND) return;
  toggleAnnotationForActiveTab().catch((error) => {
    console.warn('[SZ Annotate] Failed to toggle annotation mode', error);
  });
});
