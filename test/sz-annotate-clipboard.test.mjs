import test from 'node:test';
import assert from 'node:assert/strict';
import { dataUrlToBlob, buildClipboardItemData } from '../chrome-extensions/sz-annotate/src/clipboard.mjs';

test('converts PNG data URLs into image blobs', async () => {
  const blob = await dataUrlToBlob('data:image/png;base64,AAEC');

  assert.equal(blob.type, 'image/png');
  assert.equal(blob.size, 3);
});

test('builds clipboard data with plain text and PNG image', async () => {
  const data = await buildClipboardItemData('# UI Annotations', 'data:image/png;base64,AAEC');

  assert.deepEqual(Object.keys(data), ['text/plain', 'image/png']);
  assert.equal(data['text/plain'].type, 'text/plain');
  assert.equal(data['image/png'].type, 'image/png');
});
