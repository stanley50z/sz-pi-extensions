import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { generateSelector } from '../chrome-extensions/sz-annotate/src/selector.mjs';

test('prefers id selector when unique', () => {
  const { document } = parseHTML('<main><button id="save">Save</button></main>');
  assert.equal(generateSelector(document.querySelector('button')), '#save');
});

test('prefers data-testid when available and unique', () => {
  const { document } = parseHTML('<main><button data-testid="save-button">Save</button></main>');
  assert.equal(generateSelector(document.querySelector('button')), 'button[data-testid="save-button"]');
});

test('falls back to class and nth-of-type path', () => {
  const { document } = parseHTML('<main><section><button class="btn primary">One</button><button class="btn primary">Two</button></section></main>');
  const selector = generateSelector(document.querySelectorAll('button')[1]);
  assert.match(selector, /button/);
  assert.equal(document.querySelector(selector)?.textContent, 'Two');
});
