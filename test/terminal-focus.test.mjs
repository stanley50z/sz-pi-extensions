import test from 'node:test';
import assert from 'node:assert/strict';
import { trackTerminalFocus } from '../lib/terminal-focus.ts';

// Both footer and editor observe the same fullscreen stream and may be replaced in either order.
for (const first of [0, 1]) {
  test(`focus readers survive reader ${first} being disposed first`, () => {
    const calls = [];
    const prototype = { handleViewportInput(data) { calls.push([this, data]); return { consume: true }; } };
    const tui = Object.create(prototype);
    const readers = [trackTerminalFocus(tui), trackTerminalFocus(tui)];
    assert.deepEqual(tui.handleViewportInput('\x1b[O'), { consume: true });
    assert.ok(readers.every(reader => !reader.focused));
    readers[first].dispose();
    readers[first].dispose();
    tui.handleViewportInput('\x1b[I');
    assert.equal(readers[1 - first].focused, true);
    readers[1 - first].dispose();
    assert.equal(Object.hasOwn(tui, 'handleViewportInput'), false);
    assert.deepEqual(calls, [[tui, '\x1b[O'], [tui, '\x1b[I']]);
  });
}

test('replacement readers inherit the current unfocused state', () => {
  const tui = { handleViewportInput() {} };
  const first = trackTerminalFocus(tui);
  tui.handleViewportInput('\x1b[O');
  const second = trackTerminalFocus(tui);
  assert.equal(second.focused, false);
  first.dispose();
  second.dispose();
});
