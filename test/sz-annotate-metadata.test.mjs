import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { collectElementMetadata } from '../chrome-extensions/sz-annotate/src/metadata.mjs';

test('collects useful element metadata', () => {
  const { document } = parseHTML('<button id="save" class="btn primary" data-testid="save" aria-label="Save form" type="button"> Save changes </button>');
  globalThis.getComputedStyle = () => ({
    display: 'inline-flex',
    position: 'static',
    color: 'rgb(0, 0, 0)',
    getPropertyValue: () => '',
  });
  const element = document.querySelector('button');
  element.getBoundingClientRect = () => ({ x: 10, y: 20, width: 120, height: 40, top: 20, left: 10, right: 130, bottom: 60 });

  const metadata = collectElementMetadata(element, { index: 1, comment: 'Use primary styling.' });

  assert.equal(metadata.index, 1);
  assert.equal(metadata.tagName, 'button');
  assert.equal(metadata.idAttribute, 'save');
  assert.deepEqual(metadata.classes, ['btn', 'primary']);
  assert.equal(metadata.attributes['data-testid'], 'save');
  assert.equal(metadata.attributes['aria-label'], 'Save form');
  assert.equal(metadata.comment, 'Use primary styling.');
  assert.equal(metadata.rect.width, 120);
});
