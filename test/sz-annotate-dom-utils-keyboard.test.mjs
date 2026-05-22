import test from 'node:test';
import assert from 'node:assert/strict';
import { getAnnotationCursorCss, shouldShowAnnotationChrome, shouldSubmitCommentKey } from '../chrome-extensions/sz-annotate/src/dom-utils.mjs';

test('plain Enter submits annotation comments', () => {
  assert.equal(shouldSubmitCommentKey({ key: 'Enter', shiftKey: false }), true);
});

test('Shift+Enter keeps textarea newline behavior', () => {
  assert.equal(shouldSubmitCommentKey({ key: 'Enter', shiftKey: true }), false);
});

test('other keys do not submit annotation comments', () => {
  assert.equal(shouldSubmitCommentKey({ key: 'a', shiftKey: false }), false);
});

test('annotation cursor CSS forces page cursor to default while active', () => {
  const css = getAnnotationCursorCss();

  assert.match(css, /cursor:\s*default\s*!important/);
  assert.match(css, /\*/);
});

test('annotation markers and toolbar only show while annotation mode is active', () => {
  assert.equal(shouldShowAnnotationChrome(true), true);
  assert.equal(shouldShowAnnotationChrome(false), false);
});
