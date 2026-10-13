/**
 * Injection Detail Keys - Shared marker constants for system-injected messages.
 *
 * Multiple extensions tag their whispers/steers with a `details` object
 * containing `_braidInjected: true` so that `lib/utils/filter-safe-to-remove.ts`
 * can recognize and exclude them from context compaction. The `source`
 * field identifies the origin for debugging and analytics.
 *
 * Centralizing these string keys here prevents typos and makes the
 * contract greppable. Type augmentation for the `details` field lives
 * in `src/types/extension-context.d.ts`.
 *
 * See also:
 *   - `lib/utils/injection-tracker.ts` (producer)
 *   - `lib/utils/filter-safe-to-remove.ts` (consumer)
 */

/** Marker: this message was injected by pi-braid, not produced by the LLM. */
export const BRAID_INJECTED = "_braidInjected" as const;

/** Marker: identifying string of which extension produced the injection. */
export const BRAID_SOURCE = "_braidSource" as const;

/**
 * Marker: correlation id of the unresolved-advisory registry entry this
 * message carries (see `lib/utils/injection-tracker.ts`). The delivery
 * events (`message_start`/`message_end`) carry the same `details` object, so
 * the id is how an append retires the advisory it belongs to. Distinct from
 * the durable `braid_injection` record id: that record is the emission log,
 * this id is the in-flight delivery token.
 */
export const BRAID_ID = "_braidId" as const;
