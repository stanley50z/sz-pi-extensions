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
