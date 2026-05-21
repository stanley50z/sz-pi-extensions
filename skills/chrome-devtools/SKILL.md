---
name: chrome-devtools
description: "Full Chrome DevTools browser automation via MCP. Use when the user asks to browse the web, capture network requests, inspect console logs, take screenshots, fill forms, click elements, run performance traces, or debug web applications."
---

# Chrome DevTools MCP

Full-featured browser automation and DevTools inspection via the Chrome DevTools MCP protocol. All tools are prefixed with `mcp_`. Tools auto-register when pi starts — no manual commands needed.

## Tool Categories

### Navigation
- `mcp_navigate_page` — Navigate to a URL
- `mcp_navigate_page_history` — Go back/forward
- `mcp_new_page` / `mcp_select_page` / `mcp_close_page` / `mcp_list_pages` — Tab management

### Interaction
- `mcp_click` — Click an element by selector or coordinates
- `mcp_type` — Type into an input field
- `mcp_press_key` — Press a specific keyboard key
- `mcp_wait_for` — Wait for text or element to appear
- `mcp_evaluate_script` — Execute JavaScript in the page
- `mcp_drag` / `mcp_hover` — Drag and hover interactions
- `mcp_handle_dialog` — Accept or dismiss browser dialogs

### Screenshots & Visual
- `mcp_take_screenshot` — Capture a screenshot of the current page (returns image)
- `mcp_take_snapshot` — Get an accessibility snapshot of the page (text-based DOM tree)

### Network
- `mcp_list_network_requests` — List all captured network requests since page load
- `mcp_get_network_request` — Get full request/response details for a specific request

### Console
- `mcp_list_console_messages` — List all captured console messages
- `mcp_get_console_message` — Get full details for a specific console message

### DOM & Elements
- `mcp_get_element_properties` — Get computed properties of a DOM element
- `mcp_get_dom_tree` — Get the DOM tree of the page or a specific node

### Emulation
- `mcp_emulate` — Emulate device, geolocation, or other features
- `mcp_resize_page` — Resize the browser viewport

### Performance
- `mcp_performance_start_trace` / `mcp_performance_stop_trace` — Record and analyze performance traces

## Critical Rules

1. **Take snapshots after state changes** — After navigating, clicking, or typing, use `mcp_take_snapshot` to get current page state. Refs/selectors can change.
2. **Network capture workflow** — Navigate first, then use `mcp_list_network_requests` to see all requests. Use `mcp_get_network_request` for details on specific requests.
3. **Console capture workflow** — Use `mcp_list_console_messages` after page interactions to see what the page logged.
4. **Screenshots are images** — `mcp_take_screenshot` returns image data directly, not a file path. The user can see it.
5. **Close pages when done** — Use `mcp_close_page` to clean up tabs you created.
6. **One interaction + snapshot per cycle** — Don't batch multiple interactions without checking state between them.

## Common Patterns

### Inspecting backend API calls
```
mcp_navigate_page → url="https://example.com"
mcp_list_network_requests → see all XHR/fetch requests
mcp_get_network_request → reqid=<id> → see request/response body
```

### Debugging console errors
```
mcp_navigate_page → url="https://example.com"
mcp_list_console_messages → see errors, warnings, logs
```

### Filling a form
```
mcp_navigate_page → url="https://example.com/form"
mcp_take_snapshot → get element refs
mcp_type → ref=<ref>, text="value"
mcp_click → ref=<submit-button-ref>
mcp_take_snapshot → verify result
```
