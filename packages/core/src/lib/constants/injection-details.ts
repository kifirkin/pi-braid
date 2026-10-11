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
