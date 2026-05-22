export function resolveCaptureWindowId(message = {}, sender = {}, chromeApi = globalThis.chrome) {
  if (Number.isInteger(message.windowId)) return message.windowId;
  if (Number.isInteger(sender.tab?.windowId)) return sender.tab.windowId;
  return chromeApi?.windows?.WINDOW_ID_CURRENT;
}
