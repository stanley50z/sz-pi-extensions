const statusEl = document.querySelector('#status');
const fallbackEl = document.querySelector('#fallback');
const buttons = {
  start: document.querySelector('#start'),
  stop: document.querySelector('#stop'),
  copy: document.querySelector('#copy'),
  screenshot: document.querySelector('#screenshot'),
  clear: document.querySelector('#clear'),
};

let currentTab = null;

function setStatus(message) {
  statusEl.textContent = message;
}

function setDisabled(disabled) {
  for (const button of Object.values(buttons)) button.disabled = disabled;
}

function isRestrictedUrl(url = '') {
  return /^(chrome|edge|about|devtools|chrome-extension):/.test(url) || url.startsWith('https://chrome.google.com/webstore');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function ensureContentScript(tab) {
  try {
    return await sendMessage(tab.id, { type: 'SZ_ANNOTATE_STATUS' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/bootstrap.js'] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return await sendMessage(tab.id, { type: 'SZ_ANNOTATE_STATUS' });
  }
}

async function sendToActiveTab(message) {
  const tab = currentTab || await getActiveTab();
  if (!tab?.id) throw new Error('No active tab');
  if (isRestrictedUrl(tab.url)) throw new Error('Chrome blocks annotation on this page');
  await ensureContentScript(tab);
  const response = await sendMessage(tab.id, message);
  if (!response?.ok) throw new Error(response?.error || 'Annotation command failed');
  return response;
}

async function refreshStatus() {
  fallbackEl.hidden = true;
  setDisabled(true);
  try {
    currentTab = await getActiveTab();
    if (!currentTab?.id) throw new Error('No active tab');
    if (isRestrictedUrl(currentTab.url)) {
      setStatus('Chrome blocks annotation on this page. Open a localhost/dev page.');
      return;
    }
    const response = await ensureContentScript(currentTab);
    setStatus(response?.ok ? `${response.active ? 'Active' : 'Ready'} · ${response.count} annotation${response.count === 1 ? '' : 's'}` : 'Not ready');
    setDisabled(false);
  } catch (error) {
    setStatus(`Cannot inject annotation script on this page: ${error.message}`);
    buttons.start.disabled = false;
  }
}

async function copyText(markdown) {
  try {
    await navigator.clipboard.writeText(markdown);
    fallbackEl.hidden = true;
    return true;
  } catch {
    fallbackEl.hidden = false;
    fallbackEl.value = markdown;
    fallbackEl.focus();
    fallbackEl.select();
    return false;
  }
}

function downloadDataUrl(dataUrl, filename) {
  return chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

async function captureScreenshot() {
  const tab = currentTab || await getActiveTab();
  if (!tab?.windowId) throw new Error('No active Chrome window to capture.');
  const prepared = await sendToActiveTab({ type: 'SZ_ANNOTATE_PREPARE_SCREENSHOT' });
  if (!prepared.count) throw new Error('No annotations to capture.');
  try {
    const captured = await chrome.runtime.sendMessage({ type: 'SZ_ANNOTATE_CAPTURE_VISIBLE_TAB', windowId: tab.windowId });
    if (!captured?.ok) throw new Error(captured?.error || 'Screenshot capture failed');
    await downloadDataUrl(captured.dataUrl, `sz-annotate-${timestamp()}.png`);
    return prepared.warnings || [];
  } finally {
    await sendToActiveTab({ type: 'SZ_ANNOTATE_FINISH_SCREENSHOT' }).catch(() => {});
  }
}

buttons.start.addEventListener('click', async () => {
  try {
    const response = await sendToActiveTab({ type: 'SZ_ANNOTATE_START' });
    setStatus(`Active · ${response.count} annotations`);
  } catch (error) {
    setStatus(error.message);
  }
});

buttons.stop.addEventListener('click', async () => {
  try {
    const response = await sendToActiveTab({ type: 'SZ_ANNOTATE_STOP' });
    setStatus(`Stopped · ${response.count} annotations`);
  } catch (error) {
    setStatus(error.message);
  }
});

buttons.clear.addEventListener('click', async () => {
  try {
    await sendToActiveTab({ type: 'SZ_ANNOTATE_CLEAR' });
    setStatus('Cleared annotations.');
  } catch (error) {
    setStatus(error.message);
  }
});

buttons.copy.addEventListener('click', async () => {
  try {
    let screenshotIncluded = false;
    let warnings = [];
    const status = await sendToActiveTab({ type: 'SZ_ANNOTATE_STATUS' });
    if (!status.count) {
      setStatus('No annotations to copy.');
      return;
    }
    try {
      warnings = await captureScreenshot();
      screenshotIncluded = true;
    } catch (error) {
      setStatus(`Screenshot failed; copying prompt only. ${error.message}`);
    }
    const response = await sendToActiveTab({ type: 'SZ_ANNOTATE_GET_PROMPT', screenshotIncluded });
    const copied = await copyText(response.markdown);
    setStatus(`${copied ? 'Prompt copied' : 'Prompt shown below'}${warnings.length ? ` · ${warnings.length} warning(s)` : ''}`);
  } catch (error) {
    setStatus(error.message);
  }
});

buttons.screenshot.addEventListener('click', async () => {
  try {
    const warnings = await captureScreenshot();
    setStatus(`Screenshot downloaded${warnings.length ? ` · ${warnings.length} warning(s)` : ''}`);
  } catch (error) {
    setStatus(error.message);
  }
});

refreshStatus();
