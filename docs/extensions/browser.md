# Extension: browser

**Status**: ✅ Working
**Tests**: None (CDP integration, hard to unit test)
**Version**: v0.11.x

## Purpose

Native CDP (Chrome DevTools Protocol) browser automation with zero external dependencies. Provides full browser tool suite — navigate, snapshot, evaluate JS, screenshot, cookies, readability extraction. Commands for interactive element picking and connection management.

## Architecture

Direct CDP-over-WebSocket communication with Chrome. Auto-starts Chrome if not already running (port scanning 9222/9225). Connection state is a module-level singleton (`cdp`, `connectedTabId`). All tools share the same connection.

## Events Handled

| Event | Handler |
|-------|---------|
| `session_end` | Disconnect CDP, kill spawned Chrome process |

## Tools

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to URL (auto-connects if needed). Returns page title + URL |
| `browser_snapshot` | DOM accessibility snapshot. `interactive:true` shows only buttons/inputs/links |
| `browser_eval` | Execute JavaScript in page context, returns structured key-value output |
| `browser_screenshot` | Capture viewport as PNG/JPEG, saves to `~/.pi/screenshots/` |
| `browser_cookies` | List all cookies for current page |
| `browser_content` | Extract readable text via Readability algorithm, strips navigation |

## Commands

| Command | Description |
|---------|-------------|
| `/browser-pick` | Interactive element picker — user clicks elements in the browser; returns CSS selector + element text |
| `/browser-connect` | Connect to existing Chrome at port 9222 (auto-starts if absent) |
| `/browser-disconnect` | Disconnect and clean up session |
| `/browser-start` | Spawn Chrome with remote debugging (`--profile` for cookie sync) |

## State

Module-level singleton:
- `cdp: CdpClient | null` — WebSocket client to Chrome
- `connectedTabId`, `connectedUrl` — current tab
- `autoStartDone` — only auto-spawn once per session
- `connectLock` — prevents concurrent connection attempts

## Key Patterns

- **Auto-connect**: First tool call auto-starts Chrome via `ensureConnected()`. Uses a lock (`connectLock`) to prevent concurrent connection races.
- **Content extraction**: `extractReadableContent()` uses Mozilla's Readability algorithm to strip navigation/ads from page text.
- **Interactive picker**: `/browser-pick` injects a click-listener into the page, captures the clicked element's selector + text, then removes the listener.
- **Graceful cleanup**: Session end disconnects CDP and kills Chrome if it was spawned by the extension.
- **No external deps**: Pure CDP-over-WebSocket — no Puppeteer/Playwright dependencies.
