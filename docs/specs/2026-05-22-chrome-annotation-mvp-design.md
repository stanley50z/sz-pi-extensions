# Chrome Annotation MVP — Design Spec

## User Requirements

Items the user explicitly stated, chose, or confirmed during brainstorming.

- **Build a Chrome-only MVP first:** user asked to "create the chrome mvp for now" and confirmed Chrome extension is fine.
- **Defer Pi integration:** user stated Pi integration can come after the MVP and would send annotations directly to the Pi conversation.
- **Do not build annotator mode into the target web app:** user clarified they are not trying to create a built-in annotator mode for the page being annotated.
- **Use the feature for local dev pages:** user stated they are using it for local dev pages.
- **Use browser extension injection rather than a wrapper/iframe:** user accepted Chrome extension after discussing cross-origin wrapper limits.
- **Copy/paste is acceptable for MVP:** user asked when a Pi extension is needed and accepted that Chrome can do everything with one-click copy prompt.
- **Each annotation automatically contributes to a screenshot:** user specified that creating an annotation should include a screenshot of the webpage with the component highlighted.
- **Use one combined screenshot:** user chose one combined screenshot instead of one screenshot per annotation.
- **Persistence can wait:** user answered "later" when asked whether annotations should persist across refresh or tab close.

## Agent Design Decisions

Everything the agent inferred, recommended, or filled in to complete the design. Each decision notes which user requirement it serves.

- **Manifest V3 Chrome extension inside this repo:** serves Chrome-only MVP. Keeps the deliverable self-contained and sideloadable from `chrome://extensions`.
- **Popup + content script + background service worker split:** serves Chrome-only MVP. Popup controls user actions, content script owns annotation UI, and background captures screenshots via Chrome APIs.
- **No Pi extension, native messaging, or page DOM API in MVP:** serves deferred Pi integration and copy/paste MVP. Reduces implementation surface while preserving a future path to direct Pi send.
- **Session-only annotation state:** serves persistence-later requirement. Keeps state in the content script/background runtime and clears it on refresh or explicit clear.
- **Visible-page annotation overlay:** serves separate-from-app requirement. The extension draws hover highlights, markers, toolbar, and modals without modifying the target app source.
- **Click interception during annotation mode:** serves element-select-and-comment workflow. Prevents clicks from triggering page actions while the user is selecting elements.
- **Numbered markers for selected elements:** serves one combined screenshot requirement. Numbers in the prompt correspond to numbers drawn in the screenshot.
- **Viewport-based combined screenshot for MVP:** serves combined screenshot requirement. Uses `chrome.tabs.captureVisibleTab`, avoiding fragile full-page scrolling/stitching in the first version.
- **Warn when annotations are outside the viewport:** serves combined screenshot requirement. Metadata remains available, but the screenshot may not display every annotation.
- **Markdown prompt export:** serves one-click copy prompt requirement. Markdown is optimized for paste-back into Pi or another coding agent.
- **Separate screenshot copy/download from Markdown copy when necessary:** serves screenshot requirement. Browser clipboard support for text+image together is inconsistent, so MVP should reliably provide both artifacts even if separate actions are needed.

## Scope

### In Scope

- A sideloadable Chrome Manifest V3 extension.
- Toggle annotation mode from the extension popup.
- Hover highlight for the DOM element under the pointer.
- Click-to-annotate behavior that blocks the page's normal click action.
- A comment box/modal for each selected element.
- Numbered markers rendered on the page for saved annotations.
- A compact floating toolbar while annotation mode is active.
- Copy Markdown prompt.
- Capture one visible-viewport screenshot with numbered/highlighted annotations.
- Clear and exit controls.
- Basic metadata capture for each selected element.

### Out of Scope for MVP

- Pi extension integration.
- Native messaging.
- Direct send into Pi conversation.
- Persistent storage across page refresh or browser restart.
- Full-page stitched screenshots.
- Per-annotation screenshots.
- Cross-origin iframe annotation.
- Proxy/wrapper URL system.
- Hidden page DOM API for Chrome DevTools MCP.
- Team sync, server storage, issue tracker routing, or authentication.

## Reference Projects

- **AgentEcho:** closest MVP reference. It provides hover highlight, click annotation, numbered markers, and Markdown export for AI coding assistants.
- **DOM Review:** useful future reference for Chrome DevTools MCP-readable review data, but its hidden DOM/API approach is unnecessary for this MVP.
- **pi-annotate:** useful future reference for Pi-native direct submission, screenshots, and native messaging, but too integrated for the Chrome-only MVP.
- **ClawMark:** useful long-term reference for routing/webhooks, but server-heavy and outside the MVP.

## Architecture

### Components

1. **Manifest (`manifest.json`)**
   - Declares Manifest V3 extension metadata.
   - Grants `activeTab`, `scripting`, `tabs`, `storage`, and clipboard-related permissions as needed.
   - Registers popup, background service worker, and content script.

2. **Popup UI**
   - Shows current status for the active tab.
   - Buttons:
     - Start annotation
     - Stop annotation
     - Copy prompt
     - Copy/download screenshot
     - Clear
   - Sends messages to the active tab content script.

3. **Content Script**
   - Injected into supported pages.
   - Maintains session annotation state.
   - Handles hover targeting, element highlight, click interception, modal/comment UI, marker rendering, and toolbar rendering.
   - Captures element metadata at selection time.
   - Prepares screenshot overlay state before capture.

4. **Background Service Worker**
   - Receives screenshot capture requests.
   - Calls `chrome.tabs.captureVisibleTab` for the active window.
   - Returns the screenshot data URL to the popup/content script.
   - Optionally handles clipboard/download helpers if needed.

5. **Formatter Module**
   - Pure logic for converting annotation state into Markdown.
   - Keeps prompt generation testable without browser APIs.

6. **Selector Module**
   - Pure-ish logic for generating stable selectors.
   - Prefers IDs, `data-testid`, accessible labels, useful classes, and structural fallback as needed.

## User Workflow

1. User opens a local dev page, such as `http://localhost:3000`.
2. User clicks the extension icon.
3. User clicks **Start annotation**.
4. Content script enables annotate mode.
5. User hovers the page; the current DOM element is highlighted.
6. User clicks an element.
7. The extension prevents the target page click behavior.
8. A comment box appears.
9. User enters feedback and confirms.
10. A numbered marker appears on or near the element.
11. User repeats for more elements.
12. User clicks **Copy Prompt**.
13. Extension renders numbered highlights, captures one combined viewport screenshot, and generates Markdown.
14. User pastes the Markdown and attaches/copies/downloads the screenshot for Pi.

## Annotation Data Model

Each annotation should include:

- `id`: internal session identifier.
- `index`: 1-based number displayed in screenshot and prompt.
- `url`: current page URL.
- `selector`: best-effort CSS selector.
- `tagName`: selected element tag.
- `idAttribute`: element `id`, if present.
- `classes`: element classes, filtered/truncated.
- `text`: visible text snippet, truncated.
- `rect`: viewport-relative bounding rectangle at capture time.
- `attributes`: useful attributes, including `role`, `aria-*`, `data-testid`, `href`, `type`, `name`, and `placeholder`.
- `styles`: selected computed styles useful for UI fixes, including display, position, color, background color, font size, font weight, padding, margin, border radius, width, and height.
- `comment`: user's annotation text.
- `createdAt`: timestamp.

## Prompt Format

The copied Markdown should be concise and structured:

```markdown
# UI Annotations

URL: http://localhost:3000/example
Viewport: 1440x900
Screenshot: Combined screenshot contains numbered highlights matching the annotations below.

## Annotation 1
Comment: Make this card less tall and align the title left.
Element: <div>
Selector: `main .dashboard-card`
Text: "Quarterly revenue"
Classes: `dashboard-card`, `featured`
Key styles: display=flex; padding=24px; font-size=16px

## Annotation 2
Comment: This button should look like the primary action.
Element: <button>
Selector: `button[data-testid="save"]`
Text: "Save changes"
Attributes: data-testid="save", type="button"
Key styles: background-color=transparent; color=rgb(...)
```

## Screenshot Behavior

- MVP captures the visible viewport only.
- Before capture, content script ensures numbered markers/highlight rectangles are visible.
- Background service worker captures the visible tab.
- After capture, the UI returns to normal annotation mode.
- If some selected elements are outside the viewport, the UI warns the user before or during copy.
- If an element no longer exists, the prompt still includes its saved metadata and marks screenshot highlighting as unavailable.

## Error Handling

- **Restricted pages:** popup explains that Chrome blocks annotation on pages such as `chrome://`, Chrome Web Store, and extension pages.
- **No annotations:** Copy Prompt reports that there is nothing to copy.
- **Clipboard failure:** show generated Markdown in a selectable textarea as fallback.
- **Screenshot capture failure:** still produce Markdown and show a screenshot error.
- **Element removed:** retain saved annotation metadata, but skip live highlight and add a note.
- **Outside viewport:** warn that the combined screenshot may omit some annotations.
- **Content script missing:** popup attempts injection via `chrome.scripting.executeScript`; if that fails, show a clear error.

## Testing Strategy

### Manual Smoke Tests

- Load the extension unpacked from this repo.
- Start annotation on `http://localhost:*`.
- Verify hover highlight follows the cursor.
- Verify click interception prevents links/buttons from firing.
- Verify comment box saves annotations.
- Verify markers number annotations in order.
- Verify Clear removes markers and state.
- Verify Exit removes listeners/overlays.
- Verify Copy Prompt creates Markdown with correct annotation numbers.
- Verify combined screenshot contains visible numbered highlights.
- Verify outside-viewport warning.
- Verify restricted page error handling.

### Automated Tests

- Unit-test Markdown formatter with representative annotation data.
- Unit-test selector generation for ID, `data-testid`, class, text-like attributes, and structural fallback cases.
- Keep browser automation optional for MVP.

## Future Pi Integration

Later, a Pi extension can improve the workflow by:

- receiving the generated Markdown directly instead of relying on paste-back,
- receiving screenshot images as properly formatted attachments,
- optionally exposing a Pi command to request annotation on a URL,
- coordinating with the Chrome extension through native messaging or another local bridge.

This future integration should not require changing the target web app.
