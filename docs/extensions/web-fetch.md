# Extension: web-fetch

**Status**: ✅ Working
**Tests**: None
**Version**: v0.10.x

## Purpose

Web page fetching — the `web_fetch` tool fetches URLs and returns clean markdown content optimized for LLM consumption. Includes prompt injection detection and secret scanning.

## Architecture

Uses native `fetch()` with browser-like headers to bypass anti-bot protections. HTML-to-markdown conversion strips navigation, ads, and boilerplate. Security layer detects API keys/tokens and prompt injection attempts.

## Events Handled

| Event                  | Handler                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `tool_execution_start` | Scan URL for secrets (API keys, tokens) before fetching — blocks request if detected |

## Tools

| Tool        | Description                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_fetch` | Fetch URL → clean markdown. Params: `url`, `raw` (skip conversion), `minimal` (LLM-optimized, default true), `headers` (custom), `timeout`, `injection_action` (warn/redact/tag/none) |

## Key Patterns

- **Anti-bot headers**: Uses Chrome-like user-agent + common browser headers to avoid being blocked.
- **Size reduction**: HTML-to-markdown conversion reduces content by ~50-99% depending on page complexity.
- **Secret scanning**: Pre-fetch scan of URL for embedded secrets. Blocks request with error message if detected.
- **Prompt injection detection**: Classifies response content as trusted/untrusted/redacted. `injection_action` param controls response behavior.
- **Binary rejection**: PDFs, images, and other binary content are rejected with a helpful error suggesting the appropriate tool (read_document, browser_navigate).
