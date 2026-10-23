type Viewport = { handleViewportInput?: (data: string) => unknown };

type FocusState = {
  focused: boolean;
  readers: number;
  restore: () => void;
};

const states = new WeakMap<object, FocusState>();

/** Shares fullscreen focus reports between modifier pollers; the last reader restores Pi's handler. */
export function trackTerminalFocus(tui: object) {
  let state = states.get(tui);
  if (!state) {
    const viewport = tui as Viewport;
    const original = viewport.handleViewportInput;
    const descriptor = Object.getOwnPropertyDescriptor(viewport, "handleViewportInput");
    state = { focused: true, readers: 0, restore() {} };
    if (original) {
      const current = state;
      const observe = (data: string) => {
        if (data === "\x1b[I" || data === "\x1b[O") current.focused = data === "\x1b[I";
        return original.call(tui, data);
      };
      viewport.handleViewportInput = observe;
      state.restore = () => {
        if (viewport.handleViewportInput !== observe) return;
        if (descriptor) Object.defineProperty(viewport, "handleViewportInput", descriptor);
        else delete viewport.handleViewportInput;
      };
    }
    states.set(tui, state);
  }
  const current = state;
  current.readers++;
  let disposed = false;
  return {
    get focused() { return current.focused; },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (--current.readers === 0) {
        current.restore();
        states.delete(tui);
      }
    },
  };
}
