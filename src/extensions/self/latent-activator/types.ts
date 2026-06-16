/**
 * Latent activator types.
 *
 * Extracted from index.ts so sub-modules (signals.ts, mixes.ts) can
 * import the AtomicBehavior union without pulling in the entire
 * extension implementation.
 */

export type AtomicBehavior =
  | "meticulous"
  | "pragmatic"
  | "architectural"
  | "debugger"
  | "reviewer"
  | "explorer"
  | "executor"
  | "planner"
  | "synthesizer"
  | "validator"
  | "forensic"
  | "catalyst"
  | "archivist"
  | "guardian"
  | "oracle"
  | "mirror"
  | "bridge"
  | "scalpel"
  | "compass"
  | "lens"
  | "hammer"
  | "detective"
  | "teacher"
  | "mentor"
  | "witness"
  | "artist"
  | "scientist"
  | "engineer"
  | "translator"
  | "referee"
  | "pioneer"
  | "curator"
  | "warrior"
  | "healer"
  | "messenger"
  | "keeper"
  | "wanderer"
  | "reflection"
  | "research";
