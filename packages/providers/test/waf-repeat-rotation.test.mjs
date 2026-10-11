#!/usr/bin/env node
/**
 * waf-repeat-rotation.test.mjs
 *
 * A route that keeps refusing the same payload must move the request, not
 * retry it (packages/providers).
 *
 * The edge blocks a request body at the gateway and answers 403 with an HTML
 * page. The block is per request, not per key, so the WAF branch deliberately
 * leaves the key ring untouched and hands the turn a retry marker for the SAME
 * route. A payload the route refuses deterministically therefore retries the
 * same refusal forever: a livelock with no ceiling.
 *
 * The contract this file pins:
 *
 *   1. The FIRST consecutive edge block for a (route, model id) pair keeps
 *      today's behavior byte-for-byte: the sanitized page plus the WAF retry
 *      marker, the same route, no key-ring write, and no walk consultation.
 *   2. The SECOND consecutive block for the same pair consults the route walk:
 *      the turn moves to the next configured route, the replacement carries the
 *      repeat marker (which names the refusal, never a dead key), and the key
 *      ring is STILL untouched — no key exhausted, no key-ring state file, no
 *      route-death record.
 *   3. The streak is per (route, model id): a block on one route is never
 *      charged to another, and another model id starts from zero.
 *   4. The streak is bounded by the rotation episode's own reset: engine.reset()
 *      (session_start) or a completed fail-back puts every route back to its
 *      first block.
 *   5. Without a wired rotation hook — and without the counter on it — every
 *      block keeps taking the first-block path: byte-identical to a build
 *      without this feature.
 *   6. When the walk cannot move the turn (no other route can serve the model),
 *      the repeat block returns the sanitized page WITHOUT the retry marker:
 *      the route has refused this request twice, so re-sending it there is the
 *      livelock the feature exists to end.
 *
 * Harness (mirrors route-walk-classes.test.mjs): the REAL modules are compiled
 * with the package's local tsc (CJS emit) into a temp dir OUTSIDE the repo and
 * driven with no network and no pi-ai import. HOME is redirected to an isolated
 * temp dir and the keyspace is sanitized, so no ring/route state file outside
 * it is touched. Routes are registered through the real registerRoute seam with
 * real rings; the walk runs through the real createRotationEngine, and the
 * agent-loop cases enter through the real handleMessageEnd with the rotation
 * hook wired the way index.ts wires it. Only setModel/notify (the pi-core
 * boundary) are fakes.
 *
 * SAFETY: the block page is assembled at runtime from innocuous fragments, so
 * this source carries no complete tag literal.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");

const SHARED_MODEL = "shared/waf-model";
const OTHER_MODEL = "shared/other-model";
const NOW = 1_700_000_000_000;
const FRESHNESS_MS = 900_000;

let failures = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name}${extra ? " (" + extra + ")" : ""}`);
  }
}

/** Compile the real handler modules to CJS in buildDir and load them. */
function loadModules(buildDir) {
  mkdirSync(buildDir, { recursive: true });
  const args = [
    tscBin,
    "--ignoreConfig",
    join(pkgRoot, "ring-lifecycle.ts"),
    join(pkgRoot, "key-ring.ts"),
    join(pkgRoot, "log.ts"),
    join(pkgRoot, "route-state.ts"),
    "--outDir",
    buildDir,
    "--module",
    "commonjs",
    "--target",
    "ES2022",
    "--lib",
    "ES2022",
    "--strict",
    "--esModuleInterop",
    "--skipLibCheck",
    "--forceConsistentCasingInFileNames",
    "--types",
    "node",
  ];
  const tsc = spawnSync("node", args, { cwd: pkgRoot, encoding: "utf-8" });
  if (tsc.status !== 0) {
    console.error(
      "tsc emit failed:\n" + (tsc.stdout || "") + (tsc.stderr || ""),
    );
    process.exit(1);
  }
  const require = createRequire(import.meta.url);
  return {
    rl: require(join(buildDir, "ring-lifecycle.js")),
    keyRing: require(join(buildDir, "key-ring.js")),
    log: require(join(buildDir, "log.js")),
    rs: require(join(buildDir, "route-state.js")),
  };
}

/** Engage deps recording every setModel/probe/notify; setModel always OK. */
function engageDeps() {
  const calls = { setModel: [], probe: [], notify: [] };
  return {
    calls,
    deps: {
      setModel: (provider, model) => {
        calls.setModel.push({ provider, model });
        return true;
      },
      probe: (provider, model) => {
        calls.probe.push({ provider, model });
        return true;
      },
      notify: (text) => calls.notify.push(text),
    },
  };
}

const readIfExists = (path) =>
  existsSync(path) ? readFileSync(path, "utf8") : null;

// The edge page is assembled at runtime from innocuous fragments: this source
// holds no complete tag literal, while the joined body still trips the
// isWafBlockError markers.
const LT = "<";
const GT = ">";
const tag = (name, attrs) => LT + name + (attrs ? " " + attrs : "") + GT;
const WAF_PAGE =
  "403 " +
  tag("!doctype", "html") +
  tag("html") +
  tag("head") +
  tag("title") +
  "Access denied" +
  tag("/title") +
  tag("meta", 'content="cf-' + "ray" + '"') +
  tag("/head") +
  tag("body") +
  "automated request blocked by " +
  "waf" +
  tag("/body") +
  tag("/html");

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-waf-repeat-"));
  const buildDir = mkdtempSync(join(tmpdir(), "pi-braid-waf-repeat-build-"));
  let logApi = null;
  try {
    process.env.HOME = scratch;
    const owned =
      /^(DEAD_KEY|MIDDLE_KEY|HEALTHY_KEY|SOLO_KEY|AGENT_ZERO_API_KEY|VENICE_API_KEY)(_P\d+)?$/;
    for (const key of Object.keys(process.env)) {
      if (owned.test(key)) delete process.env[key];
    }
    process.env.DEAD_KEY = "dead-key-0";
    process.env.MIDDLE_KEY = "middle-key-0";
    process.env.HEALTHY_KEY = "healthy-key-0";
    process.env.SOLO_KEY = "solo-key-0";

    const { rl, keyRing, log, rs } = loadModules(buildDir);
    logApi = log;
    const keyRingStatePath = (routeId) =>
      join(scratch, ".pi", "agent", `.key-ring-state-${routeId}.json`);
    const routeStatePath = join(
      scratch,
      ".pi",
      "agent",
      ".provider-route-state.json",
    );

    // Three routes serving one shared model id, in table order, plus a solo
    // route whose walk has nowhere to move a turn.
    for (const [providerId, prefix] of [
      ["dead", "DEAD_KEY"],
      ["middle", "MIDDLE_KEY"],
      ["healthy", "HEALTHY_KEY"],
    ]) {
      rl.registerRoute({
        providerId,
        keys: prefix,
        modelIds: [SHARED_MODEL],
        ring: keyRing.createKeyRing({
          prefix,
          stateFile: providerId,
          healthInRotationInfo: true,
        }),
      });
    }
    process.env.SOLO_KEY = "solo-key-0";
    rl.registerRoute({
      providerId: "solo",
      keys: "SOLO_KEY",
      modelIds: [SHARED_MODEL],
      ring: keyRing.createKeyRing({
        prefix: "SOLO_KEY",
        stateFile: "solo",
        healthInRotationInfo: true,
      }),
    });

    rmSync(routeStatePath, { force: true });

    let nowMs = NOW;

    const routeDeathsFromStore = () => {
      const verdicts = new Map();
      for (const [routeId, entry] of Object.entries(
        rs.readRouteState().routes,
      )) {
        if (entry.deathClass === null) continue;
        verdicts.set(routeId, {
          class: entry.deathClass,
          modelId: entry.deathModelId ?? null,
          status: entry.deathStatus ?? null,
          at: entry.deathAt,
        });
      }
      return verdicts;
    };
    const engineFor = (order) =>
      rl.createRotationEngine({
        order,
        now: () => nowMs,
        probeFreshnessMs: FRESHNESS_MS,
        routeDeaths: routeDeathsFromStore,
        recordRouteDeath: (providerId, death) =>
          rs.recordDeath(providerId, death),
      });

    // The index.ts wiring for a message_end rotation hook. The counter call is
    // guarded so a build whose engine has no counter still runs the behavioral
    // cases below to their assertion (the presence check is a case of its own).
    const noteWaf = (engine, providerId, modelId) =>
      typeof engine.noteWafBlock === "function"
        ? engine.noteWafBlock(providerId, modelId)
        : false;
    const hooksFor = (engine, fb) => ({
      rotation: {
        onRingExhausted: (providerId, errText, modelId) =>
          engine.maybeEngage(providerId, errText, modelId, fb.deps),
        noteWafBlock: (providerId, modelId) =>
          noteWaf(engine, providerId, modelId),
      },
    });
    const wafEvent = (provider, model) => ({
      message: {
        provider,
        model,
        stopReason: "error",
        errorMessage: WAF_PAGE,
      },
    });

    const logLines = [];
    log.setProvidersLogSink((message, type) =>
      logLines.push({ message, type }),
    );

    // ── The counter: per (route, model id), bounded at the threshold ───────
    {
      const engine = engineFor(["middle", "healthy"]);
      check(
        "counter: exposed on the engine",
        typeof engine.noteWafBlock === "function",
      );
      check(
        "counter: the first block for a pair is not a repeat",
        noteWaf(engine, "middle", SHARED_MODEL) === false,
      );
      check(
        "counter: the second consecutive block for the same pair is a repeat",
        noteWaf(engine, "middle", SHARED_MODEL) === true,
      );
      check(
        "counter: later blocks stay repeats (the count is bounded)",
        noteWaf(engine, "middle", SHARED_MODEL) === true,
      );
      check(
        "counter: another route's first block is not a repeat",
        noteWaf(engine, "healthy", SHARED_MODEL) === false,
      );
      check(
        "counter: another model id on the same route is not a repeat",
        noteWaf(engine, "middle", OTHER_MODEL) === false,
      );
      engine.reset();
      check(
        "counter: the episode reset clears every streak",
        noteWaf(engine, "middle", SHARED_MODEL) === false,
      );
    }

    // ── First block: today's behavior, byte-for-byte ───────────────────────
    {
      const fb = engageDeps();
      const engine = engineFor(["middle", "dead", "healthy"]);
      const hooks = hooksFor(engine, fb);
      const ringBefore = rl.getKeyRingStatusForTest("middle");
      const ringFileBefore = readIfExists(keyRingStatePath("middle"));

      const first = await rl.handleMessageEnd(
        wafEvent("middle", SHARED_MODEL),
        hooks,
      );

      check(
        "first block: the WAF retry marker is handed back (same route, same key)",
        typeof first?.message?.errorMessage === "string" &&
          first.message.errorMessage.includes(rl.WAF_RETRY_MARKER),
        JSON.stringify(first?.message?.errorMessage),
      );
      check(
        "first block: the walk is NOT consulted",
        fb.calls.setModel.length === 0 && fb.calls.notify.length === 0,
        JSON.stringify(fb.calls),
      );
      check(
        "first block: the raw page is replaced by the sanitized marker",
        typeof first?.message?.errorMessage === "string" &&
          first.message.errorMessage.includes("Edge/WAF block") &&
          !first.message.errorMessage.includes(LT) &&
          !first.message.errorMessage.includes("Access denied"),
        JSON.stringify(first?.message?.errorMessage),
      );
      check(
        "first block: no key is exhausted and no key-ring state is written",
        JSON.stringify(rl.getKeyRingStatusForTest("middle")) ===
          JSON.stringify(ringBefore) &&
          readIfExists(keyRingStatePath("middle")) === ringFileBefore,
        JSON.stringify(rl.getKeyRingStatusForTest("middle")),
      );

      // ── Second consecutive block: the walk moves the turn ────────────────
      const second = await rl.handleMessageEnd(
        wafEvent("middle", SHARED_MODEL),
        hooks,
      );

      check(
        "second block: the walk engages the next eligible route",
        fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "dead" &&
          fb.calls.setModel[0].model === SHARED_MODEL,
        JSON.stringify(fb.calls.setModel),
      );
      check(
        "second block: the repeat marker is handed back",
        typeof second?.message?.errorMessage === "string" &&
          second.message.errorMessage.includes(rl.WAF_REPEAT_RETRY_MARKER),
        JSON.stringify(second?.message?.errorMessage),
      );
      check(
        "second block: the replacement is still sanitized (no page, no body text)",
        typeof second?.message?.errorMessage === "string" &&
          second.message.errorMessage.includes("Edge/WAF block") &&
          !second.message.errorMessage.includes(LT) &&
          !second.message.errorMessage.includes("Access denied"),
        JSON.stringify(second?.message?.errorMessage),
      );
      check(
        "second block: the marker is retryable (pi-ai reads the phrase) and claims no dead key",
        typeof second?.message?.errorMessage === "string" &&
          /provider returned error/i.test(second.message.errorMessage) &&
          !/ring is exhausted|exhausted the active key|dead key/i.test(
            second.message.errorMessage,
          ),
        JSON.stringify(second?.message?.errorMessage),
      );
      check(
        "second block: the whisper names the repeated refusal, not a dead key",
        fb.calls.notify.length === 1 &&
          /refused this request at the edge again/i.test(fb.calls.notify[0]) &&
          /no key exhausted/i.test(fb.calls.notify[0]) &&
          !/ring exhausted/i.test(fb.calls.notify[0]),
        JSON.stringify(fb.calls.notify),
      );
      check(
        "second block: the key ring is STILL untouched",
        JSON.stringify(rl.getKeyRingStatusForTest("middle")) ===
          JSON.stringify(ringBefore) &&
          readIfExists(keyRingStatePath("middle")) === ringFileBefore,
        JSON.stringify({
          status: rl.getKeyRingStatusForTest("middle"),
          before: ringBefore,
          file: readIfExists(keyRingStatePath("middle")),
          fileBefore: ringFileBefore,
        }),
      );
      check(
        "second block: no route-death record is written either",
        readIfExists(routeStatePath) === null,
        String(readIfExists(routeStatePath)),
      );
    }

    // ── No walk to take: the repeat block stops instead of re-sending ──────
    {
      const fb = engageDeps();
      const engine = engineFor(["solo"]);
      const hooks = hooksFor(engine, fb);
      const ringBefore = rl.getKeyRingStatusForTest("solo");

      const first = await rl.handleMessageEnd(
        wafEvent("solo", SHARED_MODEL),
        hooks,
      );
      check(
        "solo: the first block still takes the same-route retry path",
        typeof first?.message?.errorMessage === "string" &&
          first.message.errorMessage.includes(rl.WAF_RETRY_MARKER),
        JSON.stringify(first?.message?.errorMessage),
      );

      const second = await rl.handleMessageEnd(
        wafEvent("solo", SHARED_MODEL),
        hooks,
      );
      check(
        "solo: the repeat block keeps the sanitized error and drops the same-route retry",
        typeof second?.message?.errorMessage === "string" &&
          second.message.errorMessage.includes("Edge/WAF block") &&
          !second.message.errorMessage.includes(rl.WAF_RETRY_MARKER) &&
          !second.message.errorMessage.includes(rl.WAF_REPEAT_RETRY_MARKER) &&
          !second.message.errorMessage.includes(LT),
        JSON.stringify(second?.message?.errorMessage),
      );
      check(
        "solo: no key is exhausted by either block",
        JSON.stringify(rl.getKeyRingStatusForTest("solo")) ===
          JSON.stringify(ringBefore),
        JSON.stringify(rl.getKeyRingStatusForTest("solo")),
      );
    }

    // ── Without the counter: every block takes the first-block path ────────
    {
      const fb = engageDeps();
      const engine = engineFor(["middle", "dead", "healthy"]);
      // The rotation hook wired WITHOUT the counter (a build that has the
      // engine but not this feature) — and no hook at all.
      const withoutCounter = {
        rotation: {
          onRingExhausted: (providerId, errText, modelId) =>
            engine.maybeEngage(providerId, errText, modelId, fb.deps),
        },
      };
      const a = await rl.handleMessageEnd(
        wafEvent("middle", SHARED_MODEL),
        withoutCounter,
      );
      const b = await rl.handleMessageEnd(
        wafEvent("middle", SHARED_MODEL),
        withoutCounter,
      );
      const c = await rl.handleMessageEnd(wafEvent("middle", SHARED_MODEL));
      check(
        "no counter: both blocks keep the WAF retry marker and no route moves",
        typeof a?.message?.errorMessage === "string" &&
          typeof b?.message?.errorMessage === "string" &&
          a.message.errorMessage.includes(rl.WAF_RETRY_MARKER) &&
          b.message.errorMessage.includes(rl.WAF_RETRY_MARKER) &&
          typeof c?.message?.errorMessage === "string" &&
          c.message.errorMessage.includes(rl.WAF_RETRY_MARKER) &&
          fb.calls.setModel.length === 0,
        JSON.stringify({
          a: a?.message?.errorMessage,
          b: b?.message?.errorMessage,
          calls: fb.calls.setModel,
        }),
      );
    }

    // ── A block on one route never advances another route's streak ─────────
    {
      const fb = engageDeps();
      const engine = engineFor(["middle", "dead", "healthy"]);
      const hooks = hooksFor(engine, fb);

      // `middle` blocks once (streak 1), then `healthy` blocks once: its own
      // first block, so no walk may be consulted for it.
      await rl.handleMessageEnd(wafEvent("middle", SHARED_MODEL), hooks);
      const healthyFirst = await rl.handleMessageEnd(
        wafEvent("healthy", SHARED_MODEL),
        hooks,
      );
      check(
        "isolation: another route's block stays a first block",
        fb.calls.setModel.length === 0 &&
          typeof healthyFirst?.message?.errorMessage === "string" &&
          healthyFirst.message.errorMessage.includes(rl.WAF_RETRY_MARKER),
        JSON.stringify({ calls: fb.calls.setModel, msg: healthyFirst }),
      );

      // `middle`'s own second block now counts, and the walk moves on.
      const middleSecond = await rl.handleMessageEnd(
        wafEvent("middle", SHARED_MODEL),
        hooks,
      );
      check(
        "isolation: the original route's second block still rotates",
        fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "dead" &&
          typeof middleSecond?.message?.errorMessage === "string" &&
          middleSecond.message.errorMessage.includes(
            rl.WAF_REPEAT_RETRY_MARKER,
          ),
        JSON.stringify({ calls: fb.calls.setModel, msg: middleSecond }),
      );
    }

    // ── The streak dies with the episode: a fresh session starts at one ────
    {
      const fb = engageDeps();
      const engine = engineFor(["middle", "dead", "healthy"]);
      const hooks = hooksFor(engine, fb);

      await rl.handleMessageEnd(wafEvent("middle", SHARED_MODEL), hooks);
      await rl.handleMessageEnd(wafEvent("middle", SHARED_MODEL), hooks);
      const engaged = fb.calls.setModel.length;
      engine.reset(); // session_start
      const afterReset = await rl.handleMessageEnd(
        wafEvent("middle", SHARED_MODEL),
        hooks,
      );
      check(
        "episode reset: the next block is a first block again (no instant rotation)",
        fb.calls.setModel.length === engaged &&
          typeof afterReset?.message?.errorMessage === "string" &&
          afterReset.message.errorMessage.includes(rl.WAF_RETRY_MARKER) &&
          !afterReset.message.errorMessage.includes(rl.WAF_REPEAT_RETRY_MARKER),
        JSON.stringify({
          engaged,
          calls: fb.calls.setModel,
          msg: afterReset?.message?.errorMessage,
        }),
      );
    }

    // ── The streak dies with the fail-back too: a completed fail-back starts
    //    at one, exactly like a fresh session ────────────────────────────────
    {
      const fb = engageDeps();
      const engine = engineFor(["middle", "dead", "healthy"]);
      const hooks = hooksFor(engine, fb);

      // Streak to the threshold through the real path: the first block keeps
      // today's retry, the second is a repeat and the walk engages `dead`.
      await rl.handleMessageEnd(wafEvent("middle", SHARED_MODEL), hooks);
      await rl.handleMessageEnd(wafEvent("middle", SHARED_MODEL), hooks);
      const engaged = fb.calls.setModel.length;
      check(
        "fail-back: the repeat block opened an episode and the walk engaged",
        engaged === 1 && fb.calls.setModel[0].provider === "dead",
        JSON.stringify(fb.calls.setModel),
      );

      // The probe leg its caller runs at a later turn boundary: one interval
      // after the engage, the probe reports the primary healthy and the swap
      // back succeeds.
      nowMs += rl.FAILBACK_PROBE_INTERVAL_MS;
      const outcome = await engine.maybeFailBack(fb.deps);
      check(
        "fail-back: the probe completes the excursion and swaps the model back",
        outcome === "failed-back" &&
          fb.calls.probe.length === 1 &&
          fb.calls.probe[0].provider === "middle" &&
          fb.calls.setModel[engaged]?.provider === "middle",
        JSON.stringify({ outcome, calls: fb.calls }),
      );

      // The contract: a completed fail-back leaves every streak at zero, so
      // the next block on `middle` is a first block again — same-route retry
      // marker, no fresh walk consultation.
      const afterFailBack = await rl.handleMessageEnd(
        wafEvent("middle", SHARED_MODEL),
        hooks,
      );
      check(
        "fail-back: the next block on the failed-back route is a first block again (streak cleared)",
        fb.calls.setModel.length === engaged + 1 &&
          typeof afterFailBack?.message?.errorMessage === "string" &&
          afterFailBack.message.errorMessage.includes(rl.WAF_RETRY_MARKER) &&
          !afterFailBack.message.errorMessage.includes(
            rl.WAF_REPEAT_RETRY_MARKER,
          ),
        JSON.stringify({
          calls: fb.calls.setModel,
          msg: afterFailBack?.message?.errorMessage,
        }),
      );
    }

    // ── WAF is its own failure class now (never silently "none") ───────────
    {
      check(
        "classify: an edge page is its own class, so a walk can speak about it",
        rl.classifyFailure(WAF_PAGE.toLowerCase()).class === "waf",
        JSON.stringify(rl.classifyFailure(WAF_PAGE.toLowerCase())),
      );
      check(
        "classify: a key-rotation body stays key class",
        rl.classifyFailure("403 user has no quota left").class === "key",
        JSON.stringify(rl.classifyFailure("403 user has no quota left")),
      );
    }
  } finally {
    logApi?.setProvidersLogSink?.(undefined);
    rmSync(scratch, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
