const statusEl = document.querySelector('#status');
const buttons = {
  start: document.querySelector('#start'),
  stop: document.querySelector('#stop'),
  copy: document.querySelector('#copy'),
  screenshot: document.querySelector('#screenshot'),
  clear: document.querySelector('#clear'),
};

function setStatus(message) {
  statusEl.textContent = message;
}

function setDisabled(disabled) {
  for (const button of Object.values(buttons)) button.disabled = disabled;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(tabId, message) {
  return await chrome.tabs.sendMessage(tabId, message);
}

async function refreshStatus() {
  setDisabled(true);
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('No active tab');
    const response = await sendToTab(tab.id, { type: 'SZ_ANNOTATE_STATUS' });
    setStatus(response?.ok ? `Ready · ${response.count} annotations` : 'Not ready');
    setDisabled(false);
  } catch (error) {
    setStatus(`Cannot access this page yet: ${error.message}`);
    buttons.start.disabled = false;
  }
}

for (const [name, button] of Object.entries(buttons)) {
  button.addEventListener('click', () => setStatus(`${name} will be enabled by the annotation runtime.`));
}

refreshStatus();
