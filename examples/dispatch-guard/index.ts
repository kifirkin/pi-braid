/**
 * Dispatch guard: a `herdr_agent prompt` is a dispatch, and a dispatch does not wait.
 *
 * `herdr_agent prompt` waits for the target's lifecycle to settle unless the
 * call says otherwise, and a working agent does not settle: the dispatching
 * turn blocks inside the call until the target's whole run ends. The standing
 * rule already says to pass `wait: false`; this extension is the instrument
 * that makes it true at the call site instead of leaving it to the caller's
 * memory.
 *
 * The hook is `tool_call`: pi hands the handler the same argument object it
 * executes the tool with, so mutating it here is the call that runs. No other
 * action is touched and nothing is refused.
 *
 * Escape hatch: `wait: "settle"` is a string rather than a boolean and passes
 * through untouched, for a caller that really means to block.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** The tool whose dispatch waits. */
const DISPATCH_TOOL = "herdr_agent";

/** The custom entry type this extension writes into the session record. */
const RECORD = "dispatch-guard";

/** The one line an operator sees when the guard fires. */
export const NOTICE = "dispatch guard: wait forced to false on prompt";

/**
 * Rewrites counted per session, keyed by the session manager: that object lives
 * as long as the session does, so a new session starts the count at zero. Braid
 * extensions hold this in `getExtensionState`; this one loads standalone.
 */
const sessionCounts = new WeakMap<object, { rewrites: number }>();

function countFor(ctx: ExtensionContext): { rewrites: number } {
  const key = ctx.sessionManager as unknown as object;
  let count = sessionCounts.get(key);
  if (!count) {
    count = { rewrites: 0 };
    sessionCounts.set(key, count);
  }
  return count;
}

export default function dispatchGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== DISPATCH_TOOL) return;
    if (event.input.action !== "prompt") return;
    if (typeof event.input.wait === "string") return;
    if (event.input.wait === false) return;

    event.input.wait = false;

    const count = countFor(ctx);
    count.rewrites += 1;
    // The record carries the running count; the notice rides on the first entry
    // alone, so a session holds one line while the counter keeps counting. The
    // notify is the same line where a human reads it: a custom entry renders in
    // the transcript only when an entry renderer is registered, and this
    // example keeps its surface to one hook.
    pi.appendEntry(RECORD, {
      rewrites: count.rewrites,
      ...(count.rewrites === 1 ? { notice: NOTICE } : {}),
    });
    if (count.rewrites === 1) ctx.ui.notify(NOTICE, "info");
  });
}
