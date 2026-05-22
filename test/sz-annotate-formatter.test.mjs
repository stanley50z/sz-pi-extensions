import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAnnotationPrompt } from '../chrome-extensions/sz-annotate/src/formatter.mjs';

test('formats numbered UI annotations as Markdown', () => {
  const markdown = formatAnnotationPrompt({
    url: 'http://localhost:3000/dashboard',
    viewport: { width: 1440, height: 900 },
    screenshotIncluded: true,
    annotations: [
      {
        index: 1,
        tagName: 'button',
        selector: 'button[data-testid="save"]',
        text: 'Save changes',
        comment: 'Make this the primary action.',
        idAttribute: '',
        classes: ['btn', 'ghost'],
        attributes: { 'data-testid': 'save', type: 'button' },
        styles: { display: 'inline-flex', backgroundColor: 'rgba(0, 0, 0, 0)' },
      },
    ],
  });

  assert.match(markdown, /^# UI Annotations/);
  assert.match(markdown, /URL: http:\/\/localhost:3000\/dashboard/);
  assert.match(markdown, /Viewport: 1440x900/);
  assert.match(markdown, /Screenshot: Combined screenshot contains numbered highlights/);
  assert.match(markdown, /## Annotation 1/);
  assert.match(markdown, /Comment: Make this the primary action\./);
  assert.match(markdown, /Element: `<button>`/);
  assert.match(markdown, /Selector: `button\[data-testid="save"\]`/);
  assert.match(markdown, /Text: "Save changes"/);
  assert.match(markdown, /Classes: `btn`, `ghost`/);
  assert.match(markdown, /Attributes: data-testid="save", type="button"/);
});

test('formats empty annotations with a useful message', () => {
  const markdown = formatAnnotationPrompt({
    url: 'http://localhost:3000',
    viewport: { width: 390, height: 844 },
    screenshotIncluded: false,
    annotations: [],
  });

  assert.match(markdown, /No annotations captured/);
});
