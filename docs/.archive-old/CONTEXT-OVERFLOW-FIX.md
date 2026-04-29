# Context Overflow Fix Analysis

## Problem

The agent experiences a repeating cycle:

1. Agent stops responding mid-output
2. `Error: 400 status code (no body)` appears
3. `Context overflow recovery failed after one compact-and-retry attempt` message
4. Cycle repeats

## Root Cause Analysis

### Primary Issue: Single Overflow Retry Limit in pi-core

The upstream pi-core's `agent-session.js` limits overflow recovery to **ONE attempt**:

```javascript
// Line ~1402-1421
if (this._overflowRecoveryAttempted) {
  // Emit failure and return - NO MORE RETRIES
  return;
}
this._overflowRecoveryAttempted = true;
await this._runAutoCompaction("overflow", true);
return;
```

When the retry after compaction ALSO fails with 400, pi-core gives up permanently.

### Secondary Issues

1. **pi-braid's retry only handles compaction THROWS** - The `COMPACTION_RETRY_MAX_ATTEMPTS = 3` only applies when summarization fails to run, NOT when the post-compaction retry fails.

2. **Token estimation drift** - The `estimateTokens()` heuristic (`chars/4`) may differ from Cerebras's actual tokenizer, causing underestimation.

3. **400 "no body" is ambiguous** - Cerebras returns this for both overflow AND API configuration issues.

## Solution: Overflow Recovery Retry

Added overflow-specific retry mechanism in `context-manager` extension:

### Changes to `src/extensions/context-manager/index.ts`:

1. **New state tracking**:

   ```typescript
   const OVERFLOW_RETRY_MAX_ATTEMPTS = 3;
   const OVERFLOW_RETRY_BASE_DELAY_MS = 3000;
   const OVERFLOW_RETRY_KEEP_REDUCTION_FACTOR = 0.7;

   const overflowRetryState: OverflowRetryState = {
     attempt: 0,
     lastError: "",
     retryTimeout: null,
     aggressiveMode: false,
   };
   ```

2. **New functions**:
   - `getOverflowRetryDelay()` - exponential backoff
   - `clearOverflowRetry()` - cleanup pending retries
   - `resetOverflowRetry()` - reset state
   - `triggerOverflowRetry()` - trigger aggressive retry

3. **Modified `compaction_end` handler**:
   - Overflow failure now triggers retry instead of giving up
   - Each retry keeps 30% less context (exponential reduction)
   - Up to 3 attempts before permanent failure

4. **Modified `agent_end` handler**:
   - Detects overflow retry triggers
   - Resets overflow retry on success
   - Schedules next retry on failure

## How It Works Now

1. **First overflow** → pi-core compacts and retries
2. **Retry fails with 400** → pi-core emits `compaction_end` with overflow reason
3. **pi-braid catches this** → Starts overflow retry loop (up to 3 attempts)
4. **Each retry**:
   - Keeps 30% less context than previous attempt
   - Waits with exponential backoff
   - Shows progress to user
5. **Success** → Resets state, agent continues
6. **Exhausted retries** → Shows detailed error with manual intervention options

## Expected Behavior After Fix

```
## ⚠️ Context overflow recovery failed (attempt 1/3)
400 status code (no body)
Retrying with more aggressive compaction...
```

If it continues failing:

```
## ⚠️ Context overflow recovery failed (attempt 2/3)
400 status code (no body)
Retrying with keep ≤14000 tokens (attempt 2/3)...
```

If finally succeeds:

```
Overflow recovery succeeded on attempt 2!
```

If all retries fail:

```
## ⚠️ Context overflow recovery exhausted
400 status code (no body)
After 3 attempts, compaction cannot reduce context enough.
Possible API configuration issue (400 error):
- Check API key in ~/.pi/settings.json
- Verify model ID matches your API key
- Try `/model` to switch models
```

## Remaining Work

If the issue persists after this fix, the root cause might be:

1. **API key invalid** - Cerebras key is wrong or account suspended
2. **Model ID mismatch** - Model ID doesn't match API key
3. **Persistent token estimation drift** - Need to integrate Cerebras's tokenizer

## Testing

To test this fix, run a session that approaches context limit with Cerebras model and observe:

1. Compaction triggers automatically
2. If overflow retry needed, it shows progress
3. Either succeeds or fails with detailed error
