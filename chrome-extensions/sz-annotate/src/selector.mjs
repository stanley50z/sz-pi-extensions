const PREFERRED_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name'];

export function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function attrEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isUnique(element, selector) {
  try {
    const matches = element.ownerDocument.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

function stableClasses(element) {
  return Array.from(element.classList || [])
    .filter((className) => !/^(hover|focus|active|disabled|selected|open|closed)$/.test(className))
    .filter((className) => !className.includes(':'))
    .slice(0, 3);
}

function nthOfType(element) {
  let index = 1;
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (sibling.localName === element.localName) index += 1;
    sibling = sibling.previousElementSibling;
  }
  return `${element.localName}:nth-of-type(${index})`;
}

export function generateSelector(element) {
  if (!element?.ownerDocument || !element.localName) return '';

  if (element.id) {
    const selector = `#${cssEscape(element.id)}`;
    if (isUnique(element, selector)) return selector;
  }

  for (const attr of PREFERRED_ATTRIBUTES) {
    const value = element.getAttribute?.(attr);
    if (!value) continue;
    const selector = `${element.localName}[${attr}="${attrEscape(value)}"]`;
    if (isUnique(element, selector)) return selector;
  }

  const classes = stableClasses(element);
  if (classes.length) {
    const selector = `${element.localName}.${classes.map(cssEscape).join('.')}`;
    if (isUnique(element, selector)) return selector;
  }

  const parts = [];
  let current = element;
  while (current && current.nodeType === 1 && current.localName !== 'html') {
    let part = current.localName;
    const currentClasses = stableClasses(current);
    if (current.id) {
      part = `#${cssEscape(current.id)}`;
      parts.unshift(part);
      break;
    }
    if (currentClasses.length) part += `.${currentClasses.map(cssEscape).join('.')}`;
    if (!isUnique(current, parts.length ? `${part} > ${parts.join(' > ')}` : part)) {
      part = nthOfType(current);
    }
    parts.unshift(part);
    const selector = parts.join(' > ');
    if (isUnique(element, selector)) return selector;
    current = current.parentElement;
  }

  return parts.join(' > ') || element.localName;
}
