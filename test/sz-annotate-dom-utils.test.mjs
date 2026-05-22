import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { isExtensionUiElement } from '../chrome-extensions/sz-annotate/src/dom-utils.mjs';

test('identifies controls inside the annotation shadow root as extension UI', () => {
  const { document } = parseHTML('<html><body></body></html>');
  const host = document.createElement('div');
  host.setAttribute('data-sz-annotate-root', 'true');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<form><button type="submit">Save</button></form>';

  assert.equal(isExtensionUiElement(shadow.querySelector('button')), true);
});

test('does not identify normal page buttons as extension UI', () => {
  const { document } = parseHTML('<html><body><button>Save</button></body></html>');

  assert.equal(isExtensionUiElement(document.querySelector('button')), false);
});
