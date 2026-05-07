# Error Reference

Common pi-braid errors, their causes, and resolutions.

## Compaction Errors

### Context Window Exceeds Limit (400 / 413)

```
Context window would exceed 2013 tokens
```

**Cause**: Compaction retries were previously creating hidden turns (~200 tokens each), accelerating a positive feedback cascade into overflow. Fixed in v0.14.0.

**Resolution**:

- If seen: restart the session (context is too bloated to recover)
- Prevention: compaction retries now use `display:false` messages and concurrency guards
- Emergency rotation triggers at 75% context threshold

### Compaction Timeout

```
Compaction timed out after 30s
```

**Cause**: LLM summarization on very large contexts (>200K tokens) stalls.

**Resolution**: Automatically retried once (v0.14.0+). If persistent, the context is likely too fragmented — session restart advised.

---

## Tool Execution Errors

### Tool Not Found

```
No tool registered: <tool_name>
```

**Cause**: Tool name misspelled in agent output, or extension not registered in `src/index.ts`.

**Resolution**: Check `src/index.ts` for the extension import + registerTool() call. Run `/tools` to verify tool is enabled.

### Tool Execution Timeout

```
Tool call timed out after <N>s
```

**Cause**: Default tool timeout varies by tool. Browser navigation, web-fetch, and REPL may exceed default 30s.

**Resolution**: Most tools accept a `timeout` parameter. Increase if needed.

---

## Session / Context Errors

### Session Not Found (session_search / session_query)

```
Session file not found: <path>
```

**Cause**: Session file may have been rotated/deleted, or the session path is stale.

**Resolution**: Use `session_search` first to find active sessions, then `session_query` with the returned path.

### Context Prune Fails Silently

**Cause**: `context_prune` with `dryRun:false` in early versions claimed to prune but did nothing — SessionManager is append-only.

**Resolution** (v0.8.0+): `context_prune` is analysis-only. Real pruning happens automatically on every LLM call via the `context` event handler.

### Goal / Plan State Lost

**Cause**: Session-scoped state reset due to `getExtensionState` WeakMap key changing between calls.

**Resolution**: Ensure `getExtensionState` is called with the same `ctx` object throughout a session. Fixed in v0.8.0+ with stable key derivation.

---

## Compilation / Build Errors

### Build Error: Could not resolve "fs"

```
error: Could not resolve "fs"
```

**Cause**: Build tool configured for browser instead of Node.

**Resolution**: Use `tsc` (Node by default):

```bash
npm run build
```

### TypeScript: Property 'xxx' does not exist on type

**Cause**: Undocumented pi SDK events/properties. The pi types don't include all internal APIs used by pi-braid.

**Resolution**: Use `(ctx as any).xxx` for undocumented properties. This is by design — pi SDK types lag behind internal APIs.

---

## Extension-Specific Errors

### Vision: No vision-capable model found

```
No vision model available
```

**Cause**: No provider configured with vision support.

**Resolution**: Use `/models` to list available models. Configure a vision-capable model via settings.

### Browser: Chrome not found

```
Could not connect to Chrome. Is Chrome running with --remote-debugging-port=9222?
```

**Cause**: Chrome not running, or debugging port not exposed.

**Resolution**: Run `/browser-start` to spawn Chrome automatically, or start Chrome manually:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

### Web-fetch: Secret detected

```
Request blocked: embedded API key/token detected in URL
```

**Cause**: URL contains what looks like an API key, token, or secret.

**Resolution**: Remove the secret from the URL. Use environment variables or headers for authentication instead.

### Web-fetch: Binary content rejected

```
Binary content detected. Use browser_navigate or read_document instead
```

**Cause**: The URL points to a PDF, image, or other binary file.

**Resolution**: Use the appropriate tool: `read_document` for PDFs/DOCX, `browser_navigate` for HTML pages containing the content.

### Timer: Timeout exceeds limit

```
Timer delay must be between 1 and 3600 seconds
```

**Cause**: Attempted to set a timer longer than 1 hour.

**Resolution**: Use shorter timers or chain multiple timers for longer durations.

---

## Retry / Recovery

### Auto-Retry Stacked

**Cause** (pre-v0.14.0): Consecutive compaction retries accelerated context bloat.

**Resolution**: v0.14.0+ has concurrency guards (`compactionRetryActive`, `overflowRetryActive` flags) preventing stacked retries. Single retry with exponential backoff (2s base).

### Stale Retry State

**Cause**: Previous retry cycle didn't clean up state (flags, counters).

**Resolution**: `registerContextCleanupHandler` now resets all retry guards on context cleanup. `rotation.ts` finalize handler also resets guards.

---

## Diagnostics

To diagnose active errors:

```bash
# List recent errors
error_list --limit 10

# Get error details
error_get --id <error_id>

# Error statistics by source/type
error_stats
```

For session-level diagnostics:

```
context_audit --detailLevel full
```
