# SZ Annotate

Chrome-only visual annotation MVP for local dev pages.

Use it to hover-select DOM elements, add comments, copy a structured Markdown prompt, and download one combined viewport screenshot with numbered highlights.

## MVP Scope

Included:

- Toggle annotation mode from the Chrome extension popup
- Hover highlight for the element under the cursor
- Click interception while annotation mode is active
- Comment box for selected elements
- Numbered markers on saved annotations
- Markdown prompt export for paste-back into Pi or another coding agent
- One combined visible-viewport screenshot with numbered highlights

Not included yet:

- Pi extension integration
- Direct send into a Pi conversation
- Native messaging
- Persistent annotations after refresh/restart
- Full-page stitched screenshots
- Per-annotation screenshots
- Proxy, iframe, or wrapper URL mode

## Install from source

1. Open `chrome://extensions` in Chrome or Chromium.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this directory: `chrome-extensions/sz-annotate/`.

## Usage

1. Open a local dev page, for example `http://localhost:3000`.
2. Click the **SZ Annotate** extension icon.
3. Click **Start annotation**.
4. Hover over the page to highlight elements.
5. Click an element. The extension blocks the page click and opens a comment box.
6. Enter feedback and save. A numbered marker appears.
7. Repeat for more elements.
8. Click **Copy prompt**.
9. Paste the Markdown into Pi and attach/use the downloaded combined screenshot.

## Limitations

- Screenshots are visible-viewport only. If an annotated element is outside the viewport, the Markdown still includes the annotation, but the screenshot may not show it.
- Annotations are session-only. Refreshing the page clears them.
- Chrome blocks injection on restricted pages such as `chrome://`, extension pages, and the Chrome Web Store.
