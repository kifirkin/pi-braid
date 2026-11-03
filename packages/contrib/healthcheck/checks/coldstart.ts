/**
 * Cold-start rehearsal: does braid work on a machine that has no state?
 *
 * Why this category exists: the rest of this extension probes the machine it
 * runs on, which is the machine least likely to be broken. A new machine, a
 * container, or a reinstall starts with settings and credentials and nothing
 * else, and the failure modes there are not missing files: a subsystem that
 * treats absent state as corrupt state returns an empty answer that reads as a
 * healthy one.
 *
 * So the rehearsal builds a throwaway home, copies ONLY the config manifest,
 * leaves every state directory absent, and runs one real pi process against an
 * empty BRAID_HOME. The probe asks four subsystems to answer from nothing and
 * to say which empty answers it could not tell apart from a broken path.
 *
 * It is opt-in per category (`categories: ["coldstart"]`) and never part of the
 * default sweep: it spawns a process and can take minutes, and a health check
 * nobody runs because it is slow is worse than none.
 *
 * Isolation is an invariant, not a courtesy: the live braid home is
 * fingerprinted before and after, and any new entry there fails the run.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";
import { braidDir } from "../../state-paths.js";

/** Configuration and credentials, never state. Anything braid creates for
 *  itself on first use is deliberately absent from this list. */
export const CONFIG_MANIFEST = [
  "settings.json",
  "auth.json",
  "models-store.json",
  "mcp.json",
] as const;

/** A rehearsal that cannot finish in this window is the finding, so the child
 *  is killed rather than awaited. */
export const REHEARSAL_TIMEOUT_MS = 180_000;

export const PROBE_PROMPT = [
  "You are a startup probe on a machine whose braid state is empty. Make these four calls in order and",
  "record whether each worked:",
  "1) memory with action recall_search and query braid;",
  "2) scratchpad with action read;",
  "3) orchestrate with action list-workers;",
  "4) bash: printf bash-ok",
  "Then print exactly one line beginning with COLD_RESULT followed by a JSON object with keys memory,",
  'scratchpad, orchestrate, bash, each "ok" or "fail: <short reason>", and notes for anything that',
  "looked wrong without failing. If an empty answer cannot be told apart from a broken path, say so in",
  "notes. Write nothing after that line.",
].join("\n");

const VERDICT_MARKER = /(?:COLD_RESULT|REHEARSAL_JSON)\s*(\{[^\n]*\})/;

/** The pi config directory: braid's home is inside it by default, and a
 *  BRAID_HOME elsewhere still keeps its parent as the config root. */
export function agentConfigDir(): string {
  const braid = braidDir();
  return braid ? dirname(braid) : join(homedir(), ".pi", "agent");
}

/** Copy whatever of the manifest exists. A missing file is reported, never
 *  invented: credentials may legitimately live in the environment instead. */
export function copyConfigManifest(
  from: string,
  to: string,
): { copied: string[]; missing: string[] } {
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  const missing: string[] = [];
  for (const file of CONFIG_MANIFEST) {
    const source = join(from, file);
    if (!existsSync(source)) {
      missing.push(file);
      continue;
    }
    cpSync(source, join(to, file));
    copied.push(file);
  }
  return { copied, missing };
}

/** The child's environment. HOME, XDG roots and BRAID_HOME all point inside
 *  the throwaway tree, and the session role is cleared so a probe process never
 *  registers the seat's outbound surfaces. */
export function buildColdStartEnv(
  root: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const home = join(root, "home");
  return {
    ...base,
    HOME: home,
    BRAID_HOME: join(home, ".pi", "agent", "braid"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    BRAID_SESSION_ROLE: "",
  };
}

/** The verdict is model output: it may be fenced, prefixed, or wrapped in
 *  prose, so find the marker anywhere and take the JSON that follows it. */
export function parseVerdict(stdout: string): Record<string, string> | null {
  const hit = stdout.match(VERDICT_MARKER);
  if (!hit) return null;
  try {
    const parsed = JSON.parse(hit[1]) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) out[key] = String(value);
    return out;
  } catch {
    return null;
  }
}

function liveFingerprint(dir: string | null): string[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export interface RehearsalOptions {
  timeoutMs?: number;
  /** Injected in tests so the fixture never spawns a process. */
  runChild?: (
    env: NodeJS.ProcessEnv,
    root: string,
  ) => { status: number; stdout: string; stderr: string; timedOut: boolean };
}

export function testColdStart(options: RehearsalOptions = {}): CheckResult[] {
  const timeoutMs = options.timeoutMs ?? REHEARSAL_TIMEOUT_MS;
  const results: CheckResult[] = [];

  const configDir = agentConfigDir();
  const manifest = (() => {
    const present = CONFIG_MANIFEST.filter((file) =>
      existsSync(join(configDir, file)),
    );
    return { dir: configDir, present };
  })();

  results.push(
    check("coldstart", "config-manifest", () => {
      if (!manifest.present.includes("settings.json")) {
        return {
          status: "warn",
          message: `no settings.json in ${manifest.dir}: a rehearsal would boot a process with no package set`,
          details: `present: ${manifest.present.join(", ") || "none"}`,
        };
      }
      return {
        status: "pass",
        message: `${manifest.present.length} of ${CONFIG_MANIFEST.length} config files available to copy`,
        details: `from ${manifest.dir}: ${manifest.present.join(", ")}`,
      };
    }),
  );

  const liveHome = braidDir();
  const before = liveFingerprint(liveHome);
  const root = mkdtempSync(join(tmpdir(), "braid-health-coldstart-"));
  const env = buildColdStartEnv(root, process.env);
  const { copied, missing } = copyConfigManifest(
    configDir,
    join(root, "home", ".pi", "agent"),
  );
  const coldBraid = env.BRAID_HOME as string;

  let run = { status: 0, stdout: "", stderr: "", timedOut: false };
  try {
    const runner = options.runChild ?? defaultRunChild(timeoutMs);
    run = runner(env, root);
  } catch (err) {
    results.push(
      check("coldstart", "boot", () => ({
        status: "fail",
        message: `rehearsal process could not start: ${err instanceof Error ? err.message : String(err)}`,
      })),
    );
  }

  if (run !== null) {
    results.push(
      check("coldstart", "boot", () => {
        if (run.timedOut) {
          return {
            status: "fail",
            message: `rehearsal was killed after ${timeoutMs}ms: a subsystem waits instead of failing on absent state`,
            details: tail(run.stderr || run.stdout),
          };
        }
        if (run.status !== 0) {
          return {
            status: "fail",
            message: `rehearsal exited ${run.status}`,
            details: tail(run.stderr || run.stdout),
          };
        }
        return { status: "pass", message: "cold process ran to completion" };
      }),
    );
  }

  const verdict = parseVerdict(run.stdout);
  results.push(
    check("coldstart", "verdict", () => {
      if (!verdict) {
        return {
          status: "warn",
          message:
            "the probe printed no COLD_RESULT line, so nothing it did can be judged",
          details: tail(run.stdout) || tail(run.stderr),
        };
      }
      return {
        status: "pass",
        message: `probe reported ${Object.keys(verdict).length} keys`,
      };
    }),
  );

  if (verdict) {
    for (const key of ["memory", "scratchpad", "orchestrate", "bash"]) {
      const value = verdict[key];
      if (value === undefined) continue;
      results.push(
        check("coldstart", `subsystem-${key}`, () => {
          const ok = value.trim().toLowerCase().startsWith("ok");
          return {
            status: ok ? "pass" : "fail",
            message: ok
              ? `${key} answered from empty state`
              : `${key}: ${value}`,
          };
        }),
      );
    }
    if (verdict.notes) {
      results.push(
        check("coldstart", "probe-notes", () => ({
          status: "warn",
          message: "the probe recorded doubts about its own result",
          details: verdict.notes,
        })),
      );
    }
  }

  const installPasses = run.stderr
    .split("\n")
    .filter((line) => /^added \d+ packages?/.test(line));
  results.push(
    check("coldstart", "first-boot-installs", () => {
      if (installPasses.length === 0) {
        return {
          status: "pass",
          message:
            "boot fetched nothing: every pinned package was already installed",
        };
      }
      return {
        status: "warn",
        message: `boot fetched ${installPasses.length} pinned source(s): a clean machine needs network and a longer first start`,
        details: installPasses.join("; "),
      };
    }),
  );

  results.push(
    check("coldstart", "state-created", () => {
      const created = existsSync(coldBraid)
        ? readdirSync(coldBraid).sort()
        : [];
      if (created.length === 0) {
        return {
          status: "warn",
          message:
            "the cold run created no state at all: check that the probe reached braid",
        };
      }
      return {
        status: "pass",
        message: `${created.length} state entries created on demand`,
        details: created.join(", "),
      };
    }),
  );

  const after = liveFingerprint(liveHome);
  results.push(
    check("coldstart", "isolation", () => {
      const added = after.filter((entry) => !before.includes(entry));
      if (added.length > 0) {
        return {
          status: "fail",
          message: `the rehearsal wrote into the live braid home: ${added.join(", ")}`,
          details: `live home: ${liveHome ?? "underivable"}`,
        };
      }
      return {
        status: "pass",
        message: "the live braid home gained nothing",
        details: `copied config: ${copied.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`,
      };
    }),
  );

  if (options.runChild) {
    // A real run leaves a temp tree behind for inspection; a test run does not
    // need one, and must not leak a directory per invocation.
    rmSync(root, { recursive: true, force: true });
  }

  return results;
}

function defaultRunChild(timeoutMs: number) {
  return (env: NodeJS.ProcessEnv, root: string) => {
    const cli = process.argv[1];
    if (!cli || !existsSync(cli)) {
      throw new Error(`cannot locate the running pi CLI at ${cli ?? "(none)"}`);
    }
    const child = spawnSync(
      process.execPath,
      [cli, "-p", "--no-session", PROBE_PROMPT],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return {
      status: child.status ?? -1,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
      timedOut: child.signal === "SIGTERM" || child.error?.name === "ETIMEDOUT",
    };
  };
}

function tail(text: string, lines = 6): string {
  return text.split("\n").filter(Boolean).slice(-lines).join(" | ");
}
