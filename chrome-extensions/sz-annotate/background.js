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
