import { clipText } from './dom-utils.mjs';
import { generateSelector } from './selector.mjs';

const USEFUL_ATTRIBUTES = ['role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'data-testid', 'data-test', 'data-cy', 'href', 'type', 'name', 'placeholder', 'alt', 'title'];
const USEFUL_STYLES = ['display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'padding', 'margin', 'borderRadius', 'width', 'height'];

function collectAttributes(element) {
  const attributes = {};
  for (const name of USEFUL_ATTRIBUTES) {
    const value = element.getAttribute?.(name);
    if (value) attributes[name] = value;
  }
  return attributes;
}

function collectStyles(element) {
  const styles = {};
  const computed = globalThis.getComputedStyle?.(element);
  if (!computed) return styles;
  for (const name of USEFUL_STYLES) {
    const value = computed[name] || computed.getPropertyValue?.(name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
    if (value) styles[name] = value;
  }
  return styles;
}

function rectToObject(rect) {
  return {
    x: Math.round(rect.x ?? rect.left ?? 0),
    y: Math.round(rect.y ?? rect.top ?? 0),
    top: Math.round(rect.top ?? rect.y ?? 0),
    left: Math.round(rect.left ?? rect.x ?? 0),
    right: Math.round(rect.right ?? 0),
    bottom: Math.round(rect.bottom ?? 0),
    width: Math.round(rect.width ?? 0),
    height: Math.round(rect.height ?? 0),
  };
}

export function collectElementMetadata(element, { index, comment }) {
  const rect = element.getBoundingClientRect();
  return {
    id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    index,
    url: globalThis.location?.href || '',
    selector: generateSelector(element),
    tagName: element.localName || element.tagName?.toLowerCase() || 'unknown',
    idAttribute: element.id || '',
    classes: Array.from(element.classList || []).slice(0, 12),
    text: clipText(element.innerText || element.textContent || ''),
    rect: rectToObject(rect),
    attributes: collectAttributes(element),
    styles: collectStyles(element),
    comment: comment || '',
    createdAt: new Date().toISOString(),
  };
}
