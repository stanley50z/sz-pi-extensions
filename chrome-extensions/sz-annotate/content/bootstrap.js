(() => {
  if (globalThis.__szAnnotateBootstrapLoaded) return;
  globalThis.__szAnnotateBootstrapLoaded = true;

  import(chrome.runtime.getURL('src/content-main.mjs')).catch((error) => {
    console.error('[SZ Annotate] Failed to load content module', error);
  });
})();
