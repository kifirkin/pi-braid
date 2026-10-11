/**
 * Session Start Queue - phased lazy loading of session_start handlers.
 *
 * Uses a WeakMap keyed by the pi runtime so each reload gets a fresh queue;
 * the old pi object is GC'd (along with its queue) when pi-core invalidates
 * the runtime, so handler accumulation across reloads cannot recur.
 *
 * Problem this solves:
 *   A module-level `handlers: Handler[]` guarded by an `initialized` flag
 *   only protects the single `pi.on(SESSION_START)` registration - it does
 *   NOT guard `handlers.push()`. Every reload re-runs every extension's
 *   default function and appends another handler entry; after N reloads,
 *   session_start fires N times.
 *
 * Solution:
 *   - `slots = new WeakMap<object, Slot>()` — each pi runtime owns its queue.
 *     A fresh pi (post-reload) gets a fresh queue; the old one is GC'd.
 *   - Dedupe by name within the per-pi list (mirrors turn-end-coordinator's
 *     behavior). Same extension re-registering on the same runtime replaces.
 *   - The `pi.on(SESSION_START)` listener is attached once per runtime
 *     (lazily, on first registerSessionStartHandler call for that pi).
 *
 * Phases:
 *   Phase 1 (CoreInit) - sequential, critical for agent operation
 *   Phase 2 (MemoryState) - parallel await-all, state loading
 *   Phase 3 (Background) - fire-and-forget, non-critical
 */

import { createLogger } from "../core/logger.js";
import { SESSION_START } from "../../lib/core/event-names.js";

const _log = createLogger("session-start-queue");

export enum SessionPhase {
  /** Critical path - blocks agent start. Runs sequentially. */
  CoreInit = 0,
  /** State loading / memory initialization - runs in parallel via Promise.all. */
  MemoryState = 1,
  /** Non-critical setup - fire-and-forget. Errors are logged, not thrown. */
  Background = 2,
}

// Types
interface Handler {
  phase: SessionPhase;
  name: string;
  fn: (event: any, ctx: any) => Promise<void>;
}

interface Slot {
  handlers: Handler[];
  coordinatorAttached: boolean;
}

/** Per-runtime slots keyed by the `pi` extension API object. */
const slots = new WeakMap<object, Slot>();

function getOrCreateSlot(pi: object): Slot {
  let slot = slots.get(pi);
  if (!slot) {
    slot = { handlers: [], coordinatorAttached: false };
    slots.set(pi, slot);
  }
  return slot;
}

async function runPhases(handlers: Handler[], event: any, ctx: any): Promise<void> {
  const startMs = Date.now();

  // ── Phase 1: CoreInit (sequential, blocking) ──
  const phase1 = handlers.filter((h) => h.phase === SessionPhase.CoreInit);
  for (const h of phase1) {
    try {
      await h.fn(event, ctx);
    } catch (err) {
      _log.error(`[session-start] Phase1 error in "${h.name}":`, err);
    }
  }

  // ── Phase 2: MemoryState (parallel await-all) ──
  const phase2 = handlers
    .filter((h) => h.phase === SessionPhase.MemoryState)
    .map((h) =>
      h.fn(event, ctx).catch((err: Error) => {
        _log.error(`[session-start] Phase2 error in "${h.name}":`, err);
      }),
    );
  await Promise.allSettled(phase2);

  // ── Phase 3: Background (fire-and-forget) ──
  const backgroundHandlers = handlers.filter((h) => h.phase === SessionPhase.Background);
  for (const h of backgroundHandlers) {
    h.fn(event, ctx).catch((err: Error) => {
      _log.error(`[session-start] Phase3 error in "${h.name}":`, err);
    });
  }

  const elapsed = Date.now() - startMs;
  _log.debug(
    `[session-start] Phases complete in ${elapsed}ms ` +
      `(P1:${phase1.length}, P2:${phase2.length}, P3:${backgroundHandlers.length})`,
  );
}

/**
 * Register a session_start handler with a specific phase.
 * The coordinator's pi.on(SESSION_START) is registered lazily on first call
 * per runtime. Dedupes by name within the same runtime (last registration wins).
 */
export function registerSessionStartHandler(
  pi: any,
  phase: SessionPhase,
  fn: (event: any, ctx: any) => Promise<void>,
  name?: string,
): void {
  const slot = getOrCreateSlot(pi);
  const n = name || fn.name || `handler-${slot.handlers.length}`;

  // Dedupe by name within this runtime (mirrors turn-end-coordinator pattern)
  const existing = slot.handlers.findIndex((h) => h.name === n);
  const entry: Handler = { phase, fn, name: n };
  if (existing >= 0) {
    slot.handlers[existing] = entry;
  } else {
    slot.handlers.push(entry);
  }

  // The coordinator attaches exactly once per runtime.
  if (!slot.coordinatorAttached) {
    slot.coordinatorAttached = true;
    pi.on(SESSION_START, async (event: any, ctx: any) => {
      await runPhases(slot.handlers, event, ctx);
    });
  }
}
