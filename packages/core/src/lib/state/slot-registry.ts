/**
 * slot-registry.ts - the process's index of declared slots.
 *
 * `slot.ts` registers a live handle here on first definition. The census is
 * the read surface: version, owner, presence, age and subscriber count for
 * every slot this process has declared. The module is separate from the slot
 * type so a reader can inspect the census without importing the write path,
 * and so the checker's legacy list has one declared home.
 *
 * The table lives on `Symbol.for("pi-braid:slot-registry")`, not in module
 * scope: the source tree and the compiled dist can both be evaluated in one
 * process, and the census must count a slot once, not once per module
 * instance. A second definition of a key increments `definitions` and keeps
 * the first handle; the first build to load owns the census row.
 */

/** The parts of a slot the registry needs to describe it. */
export interface SlotSnapshot {
  /** Whether a value (stamped or unstamped) is on the global right now. */
  present: boolean;
  /** Milliseconds since the stamped write, or null for an unstamped value. */
  ageMs: number | null;
  /** Subscribers registered for this key, across module instances. */
  subscribers: number;
}

/** A live slot, as the registry holds it. */
export interface SlotHandle {
  key: string;
  version: number;
  owner: string;
  writesExpected: boolean;
  requiresSubscriber: boolean;
  snapshot(): SlotSnapshot;
}

/** One row of `slotCensus()`. */
export interface SlotCensusEntry extends SlotSnapshot {
  key: string;
  version: number;
  owner: string;
  writesExpected: boolean;
  requiresSubscriber: boolean;
  /** How many times this key has been defined in the process. */
  definitions: number;
}

/** A process-global key this change did not migrate, with the reason it stays. */
export interface LegacyGlobalSlot {
  key: string;
  /** The file that holds the key. */
  file: string;
  reason: string;
}

/**
 * Every `__braid_` key in the tree that is not a declared slot.
 *
 * `check-global-slots.mjs` reads this list from the file's source text (it is
 * a plain `.mjs` and cannot import TypeScript), so keep one `key: "..."` entry
 * per line inside the array. Each entry names the file that holds the key and
 * why the slot stays bare: the value is a protocol whose other side lives in
 * another package, or a latch whose lifetime is the process, and neither is
 * made safer by this contract alone.
 */
export const LEGACY_GLOBAL_SLOTS: readonly LegacyGlobalSlot[] = [
  {
    key: "__braid_key_ring_feedback_handler",
    file: "packages/core/src/lib/state/global-state.ts",
    reason:
      "providers publishes the handler and core consumes it; the protocol crosses a package boundary.",
  },
  {
    key: "__braid_watchdog_tunnel",
    file: "packages/core/src/lib/state/global-state.ts",
    reason:
      "telegram publishes the tunnel hub and core subscribes; the protocol crosses a package boundary.",
  },
  {
    key: "__braid_watchdog_tg_signal",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "telegram owns the transition hub; the watchdog only subscribes.",
  },
  {
    key: "__braid_watchdog_wake_delivery_feed",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "the watchdog engine and the timer share one lossy delivery feed.",
  },
  {
    key: "__braid_watchdog_wake_due_provider",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "telegram publishes the wake-due probe and the watchdog reads it lossily.",
  },
  {
    key: "__braid_turn_start_gate",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "the enforcement gate and the provider layer share a domain-free yes/no.",
  },
  {
    key: "__braid_acceptance_signal",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "a producing session publishes a wall-clock-stamped signal another session reads.",
  },
  {
    key: "__braid_context_emergency_offload_runner",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "context-manager publishes a runner; consumers read it lossily.",
  },
  {
    key: "__braid_extension_ctx_provider",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "one process-global context provider serves every consumer of the slot.",
  },
  {
    key: "__braid_aux_degraded_transport_warned",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "a once-per-process latch; a module-level flag would repeat on /reload.",
  },
  {
    key: "__braid_discoverability_shown",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "a dedup set that must survive /reload.",
  },
  {
    key: "__braid_shown_signal_types",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "per-signal-type dedup that must survive /reload.",
  },
  {
    key: "__braid_project_shown_signals",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "project-scoped dedup with disk write-through.",
  },
  {
    key: "__braid_branch_shown_signals",
    file: "packages/core/src/lib/state/global-state.ts",
    reason: "branch-scoped dedup set appended through the session entry writer.",
  },
  {
    key: "__braid_async_storage_shutdown_registered__",
    file: "packages/core/src/lib/state/async-storage.ts",
    reason: "a once-per-process shutdown-handler latch.",
  },
  {
    key: "__braid_hygiene_whisper_baseline_tokens",
    file: "packages/core/src/extensions/core/prompt-builder/awareness-whisper.ts",
    reason: "a per-process token baseline that /reload must not reset.",
  },
  {
    key: "__braid_eventbus_handlers",
    file: "packages/core/src/extensions/enforcement/handlers/register-session-start.ts",
    reason: "a per-process handler registry re-evaluated on /reload.",
  },
  {
    key: "__braid_tg_poller_liveness",
    file: "packages/core/src/lib/state/telegram-poller-liveness.ts",
    reason: "a live probe the telegram factory publishes and the prompt builder reads.",
  },
  {
    key: "__braid_tg_live_holder",
    file: "packages/telegram/src/lib/notify/live-update.ts",
    reason: "telegram's live-message holder, shared by that package's own modules.",
  },
];

interface Registration {
  handle: SlotHandle;
  definitions: number;
}

const REGISTRY = Symbol.for("pi-braid:slot-registry");
const processGlobals = globalThis as unknown as Record<symbol, unknown>;

function registrations(): Map<string, Registration> {
  const existing = processGlobals[REGISTRY];
  if (existing instanceof Map) return existing as Map<string, Registration>;
  const created = new Map<string, Registration>();
  processGlobals[REGISTRY] = created;
  return created;
}

/** Register a slot on first definition; a repeat definition is counted. */
export function registerSlot(handle: SlotHandle): void {
  const table = registrations();
  const existing = table.get(handle.key);
  if (existing) {
    existing.definitions += 1;
    return;
  }
  table.set(handle.key, { handle, definitions: 1 });
}

/** Every declared slot, in key order, with its live presence and consumers. */
export function slotCensus(): SlotCensusEntry[] {
  return [...registrations().values()]
    .map(({ handle, definitions }) => ({
      key: handle.key,
      version: handle.version,
      owner: handle.owner,
      writesExpected: handle.writesExpected,
      requiresSubscriber: handle.requiresSubscriber,
      definitions,
      ...handle.snapshot(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
