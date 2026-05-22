export function clipText(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function isInViewport(rect, viewport = globalThis.window) {
  return rect.bottom > 0 && rect.right > 0 && rect.top < viewport.innerHeight && rect.left < viewport.innerWidth;
}

export function isExtensionUiElement(element) {
  if (!element) return false;
  if (element.closest?.('[data-sz-annotate-root]')) return true;
  const root = element.getRootNode?.();
  return Boolean(root?.host?.closest?.('[data-sz-annotate-root]'));
}

export function shouldSubmitCommentKey(event) {
  return event?.key === 'Enter' && !event.shiftKey;
}

export function getAnnotationCursorCss() {
  return '* { cursor: default !important; }';
}

export function shouldShowAnnotationChrome(active) {
  return Boolean(active);
}
