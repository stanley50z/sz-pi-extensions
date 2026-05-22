import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSubmitCommentKey } from '../chrome-extensions/sz-annotate/src/dom-utils.mjs';

test('plain Enter submits annotation comments', () => {
  assert.equal(shouldSubmitCommentKey({ key: 'Enter', shiftKey: false }), true);
});

test('Shift+Enter keeps textarea newline behavior', () => {
  assert.equal(shouldSubmitCommentKey({ key: 'Enter', shiftKey: true }), false);
});

test('other keys do not submit annotation comments', () => {
  assert.equal(shouldSubmitCommentKey({ key: 'a', shiftKey: false }), false);
});
