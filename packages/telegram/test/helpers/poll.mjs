/**
 * Polling helpers shared by the telegram test files.
 *
 * waitFor is the single home for "wait until the world reaches a state": a
 * predicate that throws is "not yet" (a state file read can land mid-write),
 * so it is retried — but the last error is kept and reported on timeout so a
 * genuinely broken predicate still fails informatively.
 */
import { readFileSync } from "node:fs";

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(predicate, timeoutMs, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const detail = lastError
    ? ` (last predicate error: ${lastError?.message ?? String(lastError)})`
    : "";
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms${detail}`, {
    cause: lastError,
  });
}

/**
 * Poll `path` until its parsed JSON satisfies `predicate`, then return the
 * parsed value. A read that races an async writer parses to a throw — waitFor
 * treats it as "not yet". Use for state files a writer may still be producing.
 */
export async function waitForJson(path, predicate, timeoutMs, intervalMs = 20) {
  let value;
  await waitFor(
    () => {
      value = JSON.parse(readFileSync(path, "utf8"));
      return predicate(value);
    },
    timeoutMs,
    intervalMs,
  );
  return value;
}
