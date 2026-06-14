/**
 * Session Start Queue - phased lazy loading of session_start handlers.
 *
 * Problem: 14+ extensions register synchronous session_start handlers.
 * All fire sequentially when a session starts, blocking startup.
 *
 * Solution: Batch into phases:
 *   Phase 1 (CoreInit) - sequential, critical for agent operation
 *   Phase 2 (MemoryState) - parallel await-all, state loading
 *   Phase 3 (Background) - fire-and-forget, non-critical
 *
 * Usage (in any extension):
 *   import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
 *   registerSessionStartHandler(pi, SessionPhase.CoreInit, async (_event, ctx) => {
 *     // handler logic
 *   });
 *
 * The first call to registerSessionStartHandler() also registers the single
 * pi.on(SESSION_START) listener that runs all phased handlers.
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

const handlers: Handler[] = [];
let initialized = false;

/**
 * Register a session_start handler with a specific phase.
 * The coordinator's pi.on(SESSION_START) is registered lazily on first call.
 */
export function registerSessionStartHandler(
  pi: any,
  phase: SessionPhase,
  fn: (event: any, ctx: any) => Promise<void>,
  name?: string,
): void {
  handlers.push({ phase, fn, name: name || fn.name || `handler-${handlers.length}` });

  if (!initialized) {
    initialized = true;
    pi.on(SESSION_START, async (event: any, ctx: any) => {
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
      // Phase 2 already wraps each handler with .catch() so individual
      // failures are logged and don't block siblings. allSettled adds
      // belt-and-suspenders against any handler that throws synchronously.
      await Promise.allSettled(phase2);

      // ── Phase 3: Background (fire-and-forget) ──
      for (const h of handlers.filter((h) => h.phase === SessionPhase.Background)) {
        h.fn(event, ctx).catch((err: Error) => {
          _log.error(`[session-start] Phase3 error in "${h.name}":`, err);
        });
      }

      const elapsed = Date.now() - startMs;
      _log.debug(
        `[session-start] Phases complete in ${elapsed}ms ` +
          `(P1:${phase1.length}, P2:${phase2.length}, P3:${handlers.length - phase1.length - phase2.length})`,
      );
    });
  }
}
