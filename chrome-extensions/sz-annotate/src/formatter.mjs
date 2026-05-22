function escapeInline(value) {
  return String(value ?? '').replace(/`/g, '\\`').trim();
}

function quoteText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? `"${text.replace(/"/g, '\\"')}"` : '""';
}

function formatAttributes(attributes = {}) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, '\\"')}"`)
    .join(', ');
}

function formatStyles(styles = {}) {
  return Object.entries(styles)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('; ');
}

export function formatAnnotationPrompt({ url, viewport, annotations, screenshotIncluded }) {
  const lines = [
    '# UI Annotations',
    '',
    `URL: ${url || 'unknown'}`,
    `Viewport: ${viewport?.width ?? '?'}x${viewport?.height ?? '?'}`,
    screenshotIncluded
      ? 'Screenshot: Combined screenshot contains numbered highlights matching the annotations below.'
      : 'Screenshot: Not included or capture failed.',
    '',
  ];

  if (!annotations?.length) {
    lines.push('No annotations captured.');
    return lines.join('\n');
  }

  for (const annotation of annotations) {
    lines.push(`## Annotation ${annotation.index}`);
    lines.push(`Comment: ${annotation.comment || '(no comment)'}`);
    lines.push(`Element: \`<${escapeInline(annotation.tagName || 'unknown')}>\``);
    lines.push(`Selector: \`${escapeInline(annotation.selector || '')}\``);

    if (annotation.text) lines.push(`Text: ${quoteText(annotation.text)}`);
    if (annotation.idAttribute) lines.push(`ID: \`${escapeInline(annotation.idAttribute)}\``);
    if (annotation.classes?.length) lines.push(`Classes: ${annotation.classes.map((c) => `\`${escapeInline(c)}\``).join(', ')}`);

    const attrs = formatAttributes(annotation.attributes);
    if (attrs) lines.push(`Attributes: ${attrs}`);

    const styles = formatStyles(annotation.styles);
    if (styles) lines.push(`Key styles: ${styles}`);

    if (annotation.warning) lines.push(`Warning: ${annotation.warning}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
