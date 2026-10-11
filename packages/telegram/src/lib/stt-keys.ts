/**
 * stt-keys.ts — the STT key pool: candidate resolution, failover memory,
 * and runtime counters for voice-transcription reliability.
 *
 * Resolution order (first hit wins, deduped by key value):
 *   1. explicit  — the caller-resolved BRAID_TG_STT_API_KEY (alias included)
 *   2. list      — BRAID_TG_STT_KEYS, comma/whitespace separated
 *   3. keyring   — macOS `security find-generic-password -s <service> -w`
 *                  (darwin-only; absent/failed item tolerated silently)
 *   4. env       — vars matching /^AGENT_ZERO_API_KEY(_[A-Z0-9]+)?$/ in
 *                  lexicographic order (deterministic across runs)
 *
 * Only candidate INDEX and SOURCE KIND ever leave this module — never key
 * material. The failure line and counters name `key N/source`, not the key.
 */

/** Where a candidate came from (logged/counted; never the key itself). */
export type SttKeySource = "explicit" | "list" | "keyring" | "env";

/** One key candidate: the pool entry transcribe failover advances through. */
export interface SttKeyCandidate {
  /** The key material (consumer-internal only). */
  key: string;
  /** Source kind (observability-safe: this is what gets logged). */
  source: SttKeySource;
  /** Position in the resolved pool (stable for the process lifetime). */
  index: number;
}

/** Injectable keyring exec: returns null/throws when the item is absent. */
export type SttKeyringExec = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string } | null>;

/** Input for resolveSttKeyCandidates (pure + injectable, no real exec in tests). */
export interface ResolveSttKeyCandidatesInput {
  /** The caller-resolved explicit key (BRAID_TG_STT_API_KEY incl. alias). */
  explicit?: string;
  /** Raw env record (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Keyring exec seam (defaults to the real `security` invocation). */
  exec?: SttKeyringExec;
  /** Platform override (default process.platform; keyring is darwin-only). */
  platform?: string;
  /** Keyring service name (default BRAID_TG_STT_KEYRING_SERVICE or "braid-stt"). */
  keyringService?: string;
  /** Include the AGENT_ZERO_API_KEY* env candidates (default true). The agent-zero
   *  key family belongs to the Venice chat endpoint; enabling them against
   *  any other provider base URL would leak the key across providers, so
   *  transcriptions-mode callers turn this off. */
  includeAgentZeroEnv?: boolean;
}

/** Default macOS keyring service for the STT key. */
export const DEFAULT_STT_KEYRING_SERVICE = "braid-stt";

/** agent-zero key env-var pattern: base name plus optional _SUFFIX (A-Z0-9). */
const AGENT_ZERO_KEY_PATTERN = /^AGENT_ZERO_API_KEY(_[A-Z0-9]+)?$/;

function defaultKeyringExec(): SttKeyringExec {
  return async (cmd, args) => {
    const { execFile } = await import("node:child_process");
    return await new Promise((resolveExec) => {
      execFile(cmd, args, { timeout: 3000 }, (error, stdout) => {
        if (error)
          resolveExec(null); // absent item / lock — tolerated
        else resolveExec({ stdout: String(stdout) });
      });
    });
  };
}

/**
 * Resolve the STT key candidate pool in the documented order. Absent sources
 * contribute nothing; duplicate key values keep only their FIRST position.
 * Never throws — a failed keyring probe just yields no candidate.
 */
export async function resolveSttKeyCandidates(
  input: ResolveSttKeyCandidatesInput = {},
): Promise<SttKeyCandidate[]> {
  const envRecord =
    input.env ?? (process.env as Record<string, string | undefined>);
  const platform = input.platform ?? process.platform;
  const out: SttKeyCandidate[] = [];
  const seen = new Set<string>();
  const push = (key: string | undefined, source: SttKeySource): void => {
    const trimmed = key?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ key: trimmed, source, index: out.length });
  };

  push(input.explicit, "explicit");

  const list = envRecord["BRAID_TG_STT_KEYS"];
  if (list) {
    for (const part of list.split(/[,\s]+/)) push(part, "list");
  }

  if (platform === "darwin") {
    const service =
      input.keyringService ??
      envRecord["BRAID_TG_STT_KEYRING_SERVICE"] ??
      DEFAULT_STT_KEYRING_SERVICE;
    try {
      const exec = input.exec ?? defaultKeyringExec();
      const result = await exec("security", [
        "find-generic-password",
        "-s",
        service,
        "-w",
      ]);
      push(result?.stdout, "keyring");
    } catch {
      // keyring unavailable — tolerated, pool continues with env candidates
    }
  }

  if (input.includeAgentZeroEnv ?? true) {
    for (const name of Object.keys(envRecord)
      .filter((n) => AGENT_ZERO_KEY_PATTERN.test(n))
      .sort()) {
      push(envRecord[name], "env");
    }
  }

  return out;
}

// Process-lifetime state: winner memory + counters

let preferred: SttKeyCandidate | null = null;
let counterState = freshCounters();

function freshCounters(): SttCounters {
  return {
    attempts: 0,
    successesByCandidateIndex: {},
    normalizationsApplied: 0,
    failuresByClass: {},
    transportRetries: 0,
    transportRetrySuccesses: 0,
  };
}

/** STT runtime counters (observability snapshot for callers/tests). */
export interface SttCounters {
  /** Transcription requests issued (each candidate hit counts). */
  attempts: number;
  /** Successful transcriptions keyed by winning candidate index. */
  successesByCandidateIndex: Record<number, number>;
  /** Normalization rounds whose output was actually retried with. */
  normalizationsApplied: number;
  /** Final failures keyed by error class (auth/quota/rate/other/empty/no-key). */
  failuresByClass: Record<string, number>;
  /** Transport-class retries issued (a thrown request retried once, per round). */
  transportRetries: number;
  /** Transport-class retries whose retry then returned a transcript. */
  transportRetrySuccesses: number;
}

/** Remember the winning candidate so later calls try it FIRST. */
export function rememberSttKeyWinner(candidate: SttKeyCandidate): void {
  preferred = candidate;
}

/** The last remembered winner (null until the first success). */
export function getPreferredSttKey(): SttKeyCandidate | null {
  return preferred;
}

/** Current counters snapshot (fresh objects — safe to hand to tests/logs). */
export function getSttCounters(): SttCounters {
  return {
    ...counterState,
    successesByCandidateIndex: { ...counterState.successesByCandidateIndex },
    failuresByClass: { ...counterState.failuresByClass },
  };
}

/** Test seam: clear winner memory and counters. */
export function resetSttState(): void {
  preferred = null;
  counterState = freshCounters();
}

/** @internal counter mutation helpers (used by transcribe.ts failover). */
export function countSttAttempt(): void {
  counterState.attempts += 1;
}
export function countSttSuccess(candidate: SttKeyCandidate): void {
  const map = counterState.successesByCandidateIndex;
  map[candidate.index] = (map[candidate.index] ?? 0) + 1;
}
export function countSttNormalizationApplied(): void {
  counterState.normalizationsApplied += 1;
}
export function countSttFailure(errorClass: string): void {
  const map = counterState.failuresByClass;
  map[errorClass] = (map[errorClass] ?? 0) + 1;
}
/** @internal A transport-class retry was issued (counted apart from attempts,
 *  which counts key-pool hits). */
export function countSttTransportRetry(): void {
  counterState.transportRetries += 1;
}
/** @internal A transport-class retry then transcribed successfully. */
export function countSttTransportRetrySuccess(): void {
  counterState.transportRetrySuccesses += 1;
}
