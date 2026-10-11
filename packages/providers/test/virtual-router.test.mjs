#!/usr/bin/env node
/**
 * virtual-router.test.mjs
 *
 * Behavior pins for packages/providers/virtual-router.ts, offline: the pure
 * selection policy behind the `braid/auto` virtual model plus the registration
 * glue that wires it to injected readers.
 *
 * Covers:
 *   1. User selection across a healthy/exhausted ring: the first route in
 *      configured order that reports a usable key and no fresh death wins; a
 *      spent route, a fresh death (model-scoped), and a ring with no state file
 *      (fail-open) each change the answer the way the policy documents.
 *   2. Continuation stickiness: a `continuation` request returns the previous
 *      physical model unchanged (same object) even when its route has since
 *      gone spent, and an unchanged choice stores no new session state.
 *   3. Retry moves off a spent route: a spent/dead failed route reroutes onto
 *      the first healthy route that serves the failed model id (through that
 *      route's `models` map); a healthy failed route stays put; a model no
 *      other route serves stays put.
 *   4. Level resolution for both top names: `xhigh` and `max` both land on the
 *      target model's declared ceiling (including when the target spells that
 *      bucket with the other name), an unsupported mid level drops to the
 *      highest supported level at or below, and a non-reasoning model offers
 *      `off` alone.
 *   5. No collision with a physical catalog id: registration is skipped with
 *      ONE log line when the provider already ships a physical `auto`; the
 *      registered definition declares no context window, max tokens or input
 *      types, so pi reads the physical model it routed to; the returned model
 *      is the registry's own object (capabilities are never raised).
 *   6. The logical base id is never the virtual id: `auto` configured as the
 *      default model resolves to an id the route table serves (widest
 *      coverage, ties by first appearance), a normal logical id passes
 *      through, and the derived base selects a physical route by health.
 *   7. A second provider entry: the same router registered under a second
 *      route-table id answers from its own provider's route, walks to the
 *      next route's translated id when its leading route is spent or freshly
 *      dead, and skips only its own entry when that provider already ships a
 *      physical `auto`.
 *
 * Harness: the REAL module is compiled with the package's local tsc (CJS emit)
 * into a temp dir OUTSIDE the repo. The module has no runtime imports (pi's
 * types are type-only), so it loads under plain CJS with no registry and no
 * network.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");

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

function loadModule(buildDir) {
  mkdirSync(buildDir, { recursive: true });
  const args = [
    tscBin,
    "--ignoreConfig",
    join(pkgRoot, "virtual-router.ts"),
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
  return require(join(buildDir, "virtual-router.js"));
}

/** A physical model as the registry would hand one over. */
function model(provider, id, extra = {}) {
  return { provider, id, reasoning: true, ...extra };
}

/** A route health snapshot entry; every field explicit so a test reads plainly. */
function entry(provider, overrides = {}) {
  return {
    provider,
    ring: { usable: 2, total: 2 },
    deathClass: null,
    deathAt: 0,
    deathModelId: null,
    modelIds: ["shared/flash"],
    models: {},
    ...overrides,
  };
}

function snapshot(routes) {
  return { routes };
}

async function run() {
  const buildDir = mkdtempSync(join(tmpdir(), "pi-braid-vrouter-build-"));
  try {
    const vr = loadModule(buildDir);

    // ── 1. User selection across healthy/exhausted ring ────────────────────
    console.log("# 1. user selection by health");
    {
      const healthy = entry("route-a", { ring: { usable: 1, total: 2 } });
      const spentRing = entry("route-b", { ring: { usable: 0, total: 2 } });
      const third = entry("route-c");
      const opts = {
        logicalModelId: "shared/flash",
        now: NOW,
        freshnessMs: FRESHNESS_MS,
      };

      const first = vr.selectRouteByHealth(
        snapshot([healthy, spentRing, third]),
        opts,
      );
      check(
        "first healthy route wins",
        first &&
          first.provider === "route-a" &&
          first.modelId === "shared/flash",
        JSON.stringify(first),
      );

      const afterSpend = vr.selectRouteByHealth(
        snapshot([
          entry("route-a", { ring: { usable: 0, total: 2 } }),
          spentRing,
          third,
        ]),
        opts,
      );
      check(
        "spent ring takes the route out",
        afterSpend && afterSpend.provider === "route-c",
        JSON.stringify(afterSpend),
      );

      const noRingState = vr.selectRouteByHealth(
        snapshot([entry("route-a", { ring: null }), third]),
        opts,
      );
      check(
        "absent ring state fails open",
        noRingState && noRingState.provider === "route-a",
        JSON.stringify(noRingState),
      );

      const freshDeath = entry("route-a", {
        deathClass: "request-shape",
        deathAt: NOW - 1000,
        deathModelId: "shared/flash",
      });
      const afterDeath = vr.selectRouteByHealth(
        snapshot([freshDeath, third]),
        opts,
      );
      check(
        "fresh model-scoped death parks the route",
        afterDeath && afterDeath.provider === "route-c",
        JSON.stringify(afterDeath),
      );

      const otherModelDeath = entry("route-a", {
        deathClass: "request-shape",
        deathAt: NOW - 1000,
        deathModelId: "shared/other",
      });
      const notParked = vr.selectRouteByHealth(
        snapshot([otherModelDeath, third]),
        opts,
      );
      check(
        "a death for another model does not park the route",
        notParked && notParked.provider === "route-a",
        JSON.stringify(notParked),
      );

      const staleDeath = entry("route-a", {
        deathClass: "request-shape",
        deathAt: NOW - FRESHNESS_MS - 1,
        deathModelId: "shared/flash",
      });
      const afterStale = vr.selectRouteByHealth(
        snapshot([staleDeath, third]),
        opts,
      );
      check(
        "a stale death no longer parks the route",
        afterStale && afterStale.provider === "route-a",
        JSON.stringify(afterStale),
      );

      const offSwitch = vr.selectRouteByHealth(snapshot([staleDeath, third]), {
        ...opts,
        freshnessMs: 0,
        now: NOW,
      });
      check(
        "freshnessMs 0 turns the death leg off",
        offSwitch && offSwitch.provider === "route-a",
        JSON.stringify(offSwitch),
      );

      const translated = entry("route-b", {
        modelIds: [],
        models: { "shared/flash": "route-b/flash-x" },
      });
      const mapped = vr.selectRouteByHealth(
        snapshot([spentRing, translated]),
        opts,
      );
      check(
        "models map translates the dispatch id",
        mapped &&
          mapped.provider === "route-b" &&
          mapped.modelId === "route-b/flash-x",
        JSON.stringify(mapped),
      );

      const noneServe = vr.selectRouteByHealth(
        snapshot([entry("route-a", { modelIds: [], models: {} })]),
        opts,
      );
      check("no route serving the id selects nothing", noneServe === null);

      const unhealthyFallback = vr.selectAnyRoute(
        snapshot([
          entry("route-a", { ring: { usable: 0, total: 1 } }),
          entry("route-b", { ring: { usable: 0, total: 1 } }),
        ]),
        opts,
      );
      check(
        "selectAnyRoute ignores health for the last resort",
        unhealthyFallback && unhealthyFallback.provider === "route-a",
        JSON.stringify(unhealthyFallback),
      );
    }

    // ── 3. Retry moves off a spent route ──────────────────────────────────
    console.log("# 3. retry off a spent route");
    {
      const opts = {
        now: NOW,
        freshnessMs: FRESHNESS_MS,
        logicalModelId: null,
      };
      const spent = entry("route-a", {
        ring: { usable: 0, total: 2 },
        models: { "shared/flash": "route-a/flash" },
      });
      const healthy = entry("route-b", {
        models: { "shared/flash": "route-b/flash" },
      });
      const moved = vr.selectRetryRoute(snapshot([spent, healthy]), {
        ...opts,
        failedProvider: "route-a",
        failedModelId: "shared/flash",
      });
      check(
        "spent failed route reroutes through the models map",
        moved &&
          moved.provider === "route-b" &&
          moved.modelId === "route-b/flash",
        JSON.stringify(moved),
      );

      const healthyFailed = entry("route-a", {
        models: { "shared/flash": "route-a/flash" },
      });
      const stayed = vr.selectRetryRoute(snapshot([healthyFailed, healthy]), {
        ...opts,
        failedProvider: "route-a",
        failedModelId: "shared/flash",
      });
      check("a healthy failed route stays put", stayed === null);

      const exclusivelyServed = vr.selectRetryRoute(
        snapshot([
          spent,
          entry("route-b", { modelIds: [], models: { "other/only": "x" } }),
        ]),
        { ...opts, failedProvider: "route-a", failedModelId: "shared/flash" },
      );
      check("no other route serves the id ⇒ stay", exclusivelyServed === null);

      const unknownRoute = vr.selectRetryRoute(snapshot([healthy]), {
        ...opts,
        failedProvider: "ghost",
        failedModelId: "shared/flash",
      });
      check("an unknown failed route stays put", unknownRoute === null);

      const deadScoped = entry("route-a", {
        deathClass: "request-shape",
        deathAt: NOW - 10,
        deathModelId: "shared/flash",
        models: { "shared/flash": "route-a/flash" },
      });
      const movedOffDeath = vr.selectRetryRoute(
        snapshot([deadScoped, healthy]),
        {
          ...opts,
          failedProvider: "route-a",
          failedModelId: "shared/flash",
        },
      );
      check(
        "a dead (not spent) failed route also moves",
        movedOffDeath && movedOffDeath.provider === "route-b",
        JSON.stringify(movedOffDeath),
      );
    }

    // ── 4. Level resolution for both top names ────────────────────────────
    console.log("# 4. thinking level resolution");
    {
      // pi-ai's opencode-go spelling: top bucket is `max`; `xhigh` is null.
      const maxTop = {
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      };
      // the venice catalog spelling: top bucket is `xhigh`, `max` aliases it.
      const xhighTop = {
        reasoning: true,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: "xhigh",
          max: "xhigh",
        },
      };
      check(
        "requested xhigh lands on a max-spelled ceiling",
        vr.resolveThinkingLevel(maxTop, "xhigh") === "max",
        vr.resolveThinkingLevel(maxTop, "xhigh"),
      );
      check(
        "requested max lands on a max-spelled ceiling",
        vr.resolveThinkingLevel(maxTop, "max") === "max",
      );
      check(
        "requested max lands on an xhigh-spelled ceiling",
        vr.resolveThinkingLevel(xhighTop, "max") === "max",
      );
      check(
        "requested xhigh lands on an xhigh-spelled ceiling",
        vr.resolveThinkingLevel(xhighTop, "xhigh") === "xhigh",
      );
      check(
        "a ceiling below the request is the ceiling",
        vr.resolveThinkingLevel(
          { reasoning: true, thinkingLevelMap: { low: "low", high: "high" } },
          "max",
        ) === "high",
      );
      check(
        "an unsupported mid level drops to the highest at or below",
        vr.resolveThinkingLevel(xhighTop, "low") === "off",
        vr.resolveThinkingLevel(xhighTop, "low"),
      );
      check(
        "no level at or below falls up to the lowest supported",
        vr.resolveThinkingLevel(
          {
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: null,
              medium: null,
              high: "high",
              xhigh: "xhigh",
            },
          },
          "minimal",
        ) === "high",
        vr.resolveThinkingLevel(
          {
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: null,
              medium: null,
              high: "high",
              xhigh: "xhigh",
            },
          },
          "minimal",
        ),
      );
      check(
        "a supported level is returned unchanged",
        vr.resolveThinkingLevel(maxTop, "low") === "low",
      );
      check(
        "a non-reasoning model offers off alone",
        vr.resolveThinkingLevel(
          { reasoning: false, thinkingLevelMap: { high: "high" } },
          "high",
        ) === "off",
      );
      const supported = vr.supportedThinkingLevels(xhighTop);
      check(
        "supported set drops null and undeclared tops",
        !supported.includes("minimal") &&
          supported.includes("off") &&
          supported.includes("xhigh"),
        JSON.stringify(supported),
      );
    }

    // ── 5. Registration: collision guard + capability non-raising ──────────
    console.log("# 5. registration");
    {
      const logs = [];
      const pi = {
        virtual: [],
        registerVirtualModel(def) {
          this.virtual.push(def);
        },
      };
      const baseDeps = {
        provider: "prov",
        hasPhysicalModel: () => false,
        readSnapshot: () => snapshot([]),
        logicalModelId: () => "shared/flash",
        freshnessMs: FRESHNESS_MS,
        cacheTtlMs: 0,
        now: () => NOW,
        log: (m) => logs.push(m),
      };
      vr.registerAutoRouter(pi, baseDeps);
      check("registers one virtual model", pi.virtual.length === 1);
      const def = pi.virtual[0];
      check(
        "definition names the provider and the auto id",
        def.provider === "prov" && def.id === "auto",
      );
      check(
        "definition offers both canonical top names",
        def.thinkingLevels.includes("xhigh") &&
          def.thinkingLevels.includes("max"),
        JSON.stringify(def.thinkingLevels),
      );
      check(
        "definition declares no limits or input types",
        def.contextWindow === undefined &&
          def.maxTokens === undefined &&
          def.input === undefined,
      );

      const piSkipped = {
        virtual: [],
        registerVirtualModel(def2) {
          this.virtual.push(def2);
        },
      };
      vr.registerAutoRouter(piSkipped, {
        ...baseDeps,
        hasPhysicalModel: (id) => id === "auto",
      });
      check("collision skips registration", piSkipped.virtual.length === 0);
      check(
        "collision logs exactly once",
        logs.length === 1,
        JSON.stringify(logs),
      );

      // route(): the returned model is the registry's OWN object.
      const registryModel = model("route-a", "route-a/flash", {
        thinkingLevelMap: { high: "high", xhigh: "xhigh" },
      });
      const ctx = {
        modelRegistry: {
          find: (p, id) =>
            p === "route-a" && id === "route-a/flash"
              ? registryModel
              : undefined,
        },
      };
      const virtualModel = {
        provider: "prov",
        id: "auto",
        reasoning: false,
        thinkingLevelMap: {},
      };
      const liveSnapshot = snapshot([
        entry("route-a", { models: { "shared/flash": "route-a/flash" } }),
      ]);
      const routePi = {
        virtual: [],
        registerVirtualModel(d) {
          this.virtual.push(d);
        },
      };
      vr.registerAutoRouter(routePi, {
        ...baseDeps,
        readSnapshot: () => liveSnapshot,
      });
      const routeDef = routePi.virtual[0];
      const request = {
        model: virtualModel,
        thinkingLevel: "xhigh",
        reason: "user",
        messages: [],
      };
      const routed = routeDef.route(request, ctx);
      check(
        "user request returns the registry's own physical model",
        routed.model === registryModel,
        routed.model && routed.model.id,
      );
      check(
        "and resolves the level against that model",
        routed.thinkingLevel === "xhigh",
        routed.thinkingLevel,
      );
      check(
        "state names the chosen route and why",
        routed.state &&
          routed.state.route === "route-a" &&
          routed.state.model === "route-a/flash" &&
          routed.state.why === "user-health",
        JSON.stringify(routed.state),
      );

      // continuation returns the previous model object unchanged.
      const prevModel = model("route-b", "route-b/flash", {
        thinkingLevelMap: { high: "high", max: "max" },
      });
      const cont = routeDef.route(
        {
          model: virtualModel,
          thinkingLevel: "max",
          reason: "continuation",
          previous: { model: prevModel, thinkingLevel: "max" },
          state: routed.state,
        },
        ctx,
      );
      check(
        "continuation returns the previous model object unchanged",
        cont.model === prevModel,
        cont.model && cont.model.id,
      );
      check(
        "continuation keeps the top ceiling on the other spelling",
        cont.thinkingLevel === "max",
        cont.thinkingLevel,
      );
      const contAgain = routeDef.route(
        {
          model: virtualModel,
          thinkingLevel: "max",
          reason: "continuation",
          previous: { model: prevModel, thinkingLevel: "max" },
          state: cont.state,
        },
        ctx,
      );
      check(
        "an unchanged choice does not churn the stored state",
        contAgain.state === undefined,
        JSON.stringify(contAgain.state),
      );

      // retry moves off a spent route in the glue too.
      const spentSnapshot = snapshot([
        entry("route-a", {
          ring: { usable: 0, total: 2 },
          modelIds: [],
          models: { "route-a/flash": "route-a/flash" },
        }),
        entry("route-b", {
          modelIds: [],
          models: { "route-a/flash": "route-b/flash" },
        }),
      ]);
      const retryPi = {
        virtual: [],
        registerVirtualModel(d) {
          this.virtual.push(d);
        },
      };
      vr.registerAutoRouter(retryPi, {
        ...baseDeps,
        readSnapshot: () => spentSnapshot,
      });
      const retryDef = retryPi.virtual[0];
      const retryModels = new Map([
        ["route-b/route-b/flash", model("route-b", "route-b/flash")],
      ]);
      const retryCtx = {
        modelRegistry: { find: (p, id) => retryModels.get(`${p}/${id}`) },
      };
      const moved = retryDef.route(
        {
          model: virtualModel,
          thinkingLevel: "high",
          reason: "retry",
          failed: {
            model: model("route-a", "route-a/flash"),
            thinkingLevel: "high",
          },
        },
        retryCtx,
      );
      check(
        "retry off a spent route lands on the next healthy route",
        moved.model.id === "route-b/flash" && moved.state.why === "retry-moved",
        JSON.stringify(moved.state),
      );

      // `auto` configured as the default model: the router's base id must come
      // from the route table, so the request still lands on a physical model.
      const autoPi = {
        virtual: [],
        registerVirtualModel(d) {
          this.virtual.push(d);
        },
      };
      const autoTarget = model("route-a", "route-a/flash");
      const autoSnapshot = snapshot([
        entry("route-a", {
          modelIds: [],
          models: { "shared/flash": "route-a/flash" },
        }),
      ]);
      vr.registerAutoRouter(autoPi, {
        ...baseDeps,
        readSnapshot: () => autoSnapshot,
        logicalModelId: () => "auto",
      });
      const autoCtx = {
        modelRegistry: {
          find: (p, id) =>
            p === "route-a" && id === "route-a/flash" ? autoTarget : undefined,
        },
      };
      const autoRouted = autoPi.virtual[0].route(
        {
          model: { provider: "prov", id: "auto", reasoning: false },
          thinkingLevel: "high",
          reason: "user",
          messages: [],
        },
        autoCtx,
      );
      check(
        "auto as the configured default routes to the physical model",
        autoRouted.model === autoTarget,
        autoRouted.model && autoRouted.model.id,
      );
      check(
        "and never back to the virtual model itself",
        autoRouted.model.id !== "auto",
        autoRouted.model && autoRouted.model.id,
      );
      check(
        "state names the physical route it chose",
        autoRouted.state &&
          autoRouted.state.route === "route-a" &&
          autoRouted.state.model === "route-a/flash",
        JSON.stringify(autoRouted.state),
      );
    }

    // ── Snapshot reuse window ─────────────────────────────────────────────
    console.log("# cache reuse");
    {
      let reads = 0;
      let clock = NOW;
      const pi = {
        virtual: [],
        registerVirtualModel(d) {
          this.virtual.push(d);
        },
      };
      vr.registerAutoRouter(pi, {
        provider: "prov",
        hasPhysicalModel: () => false,
        readSnapshot: () => {
          reads++;
          return snapshot([entry("route-a")]);
        },
        logicalModelId: () => "shared/flash",
        freshnessMs: FRESHNESS_MS,
        cacheTtlMs: 5000,
        now: () => clock,
      });
      const def = pi.virtual[0];
      const ctx = {
        modelRegistry: {
          find: (p, id) => model(p, id, { thinkingLevelMap: { high: "high" } }),
        },
      };
      const base = {
        model: { provider: "prov", id: "auto", reasoning: false },
        thinkingLevel: "high",
        reason: "user",
      };
      def.route(base, ctx);
      def.route(base, ctx);
      check(
        "within the window the snapshot is read once",
        reads === 1,
        String(reads),
      );
      clock += 6000;
      def.route(base, ctx);
      check("past the window it is read again", reads === 2, String(reads));
      def.route(
        { ...base, reason: "retry", failed: { model: model("route-a", "x") } },
        ctx,
      );
      check(
        "a retry reads fresh even inside the window",
        reads === 3,
        String(reads),
      );
    }

    // ── 6. Logical base id: the virtual id is never the base ──────────────
    console.log("# 6. logical base model id");
    {
      const table = snapshot([
        entry("route-a", {
          modelIds: [],
          models: { "shared/flash": "route-a/flash" },
        }),
        entry("route-b", {
          modelIds: [],
          models: { "shared/flash": "route-b/flash" },
        }),
        entry("route-c", {
          modelIds: ["lone/model"],
          models: { "shared/flash": "route-c/flash" },
        }),
      ]);

      check(
        "the virtual id resolves to the id the table serves",
        vr.resolveLogicalBaseModelId("auto", table) === "shared/flash",
        String(vr.resolveLogicalBaseModelId("auto", table)),
      );
      check(
        "a normal logical id passes through unchanged",
        vr.resolveLogicalBaseModelId("shared/flash", table) === "shared/flash",
      );
      check(
        "a configured id the table does not carry passes through unchanged",
        vr.resolveLogicalBaseModelId("owner/own-model", table) ===
          "owner/own-model",
      );
      check(
        "no configured id derives the base from the table",
        vr.resolveLogicalBaseModelId(null, table) === "shared/flash",
      );
      check(
        "an empty table yields no base",
        vr.resolveLogicalBaseModelId("auto", snapshot([])) === null,
      );

      const wide = snapshot([
        entry("route-a", { modelIds: [], models: { "narrow/one": "a/one" } }),
        entry("route-b", { modelIds: [], models: { "wide/two": "b/two" } }),
        entry("route-c", { modelIds: [], models: { "wide/two": "c/two" } }),
      ]);
      check(
        "the id the most routes serve wins",
        vr.resolveLogicalBaseModelId("auto", wide) === "wide/two",
        String(vr.resolveLogicalBaseModelId("auto", wide)),
      );
      const tie = snapshot([
        entry("route-a", { modelIds: [], models: { "first/one": "a/one" } }),
        entry("route-b", { modelIds: [], models: { "second/two": "b/two" } }),
      ]);
      check(
        "a tie goes to the first appearance in table order",
        vr.resolveLogicalBaseModelId("auto", tie) === "first/one",
        String(vr.resolveLogicalBaseModelId("auto", tie)),
      );
      const declaredTwice = snapshot([
        entry("route-a", {
          modelIds: ["twice/id"],
          models: { "twice/id": "a/id" },
        }),
        entry("route-b", {
          modelIds: [],
          models: { "shared/other": "b/other" },
        }),
        entry("route-c", {
          modelIds: [],
          models: { "shared/other": "c/other" },
        }),
      ]);
      check(
        "an id declared twice by one route counts once",
        vr.resolveLogicalBaseModelId("auto", declaredTwice) === "shared/other",
        String(vr.resolveLogicalBaseModelId("auto", declaredTwice)),
      );

      const derived = vr.resolveLogicalBaseModelId("auto", table);
      const picked = vr.selectRouteByHealth(table, {
        logicalModelId: derived,
        now: NOW,
        freshnessMs: FRESHNESS_MS,
      });
      check(
        "the derived base selects the first healthy route that serves it",
        picked &&
          picked.provider === "route-a" &&
          picked.modelId === "route-a/flash",
        JSON.stringify(picked),
      );
      const firstSpent = snapshot([
        entry("route-a", {
          ring: { usable: 0, total: 2 },
          modelIds: [],
          models: { "shared/flash": "route-a/flash" },
        }),
        entry("route-b", {
          modelIds: [],
          models: { "shared/flash": "route-b/flash" },
        }),
      ]);
      const movedOn = vr.selectRouteByHealth(firstSpent, {
        logicalModelId: vr.resolveLogicalBaseModelId("auto", firstSpent),
        now: NOW,
        freshnessMs: FRESHNESS_MS,
      });
      check(
        "a spent first route moves the derived base to the next route",
        movedOn &&
          movedOn.provider === "route-b" &&
          movedOn.modelId === "route-b/flash",
        JSON.stringify(movedOn),
      );
    }

    // ── 7. A second entry: same policy, its own provider id ───────────────
    console.log("# 7. second provider entry");
    {
      // The owner's table puts opencode-go ahead of the agent-zero gateway; the same
      // router is registered once per provider id, so a session that starts on
      // the second entry gets the same health walk. What this pins is that the
      // two entries are independent: their collision guards, their snapshots
      // and their answers, including the translated id the gateway needs.
      const shared = snapshot([
        entry("opencode-go", {
          modelIds: [],
          models: { "deepseek-v4.1-flash": "deepseek-v4.1-flash" },
        }),
        entry("agent-zero", {
          modelIds: [],
          models: { "deepseek-v4.1-flash": "deepseek-v4-1-flash" },
        }),
      ]);
      const registry = new Map([
        [
          "opencode-go/deepseek-v4.1-flash",
          model("opencode-go", "deepseek-v4.1-flash"),
        ],
        [
          "agent-zero/deepseek-v4-1-flash",
          model("agent-zero", "deepseek-v4-1-flash"),
        ],
      ]);
      const ctx = {
        modelRegistry: {
          find: (provider, id) => registry.get(`${provider}/${id}`),
        },
      };
      const piFor = () => ({
        virtual: [],
        registerVirtualModel(d) {
          this.virtual.push(d);
        },
      });
      const deps = (provider, overrides = {}) => ({
        provider,
        hasPhysicalModel: () => false,
        readSnapshot: () => shared,
        logicalModelId: () => "deepseek-v4.1-flash",
        freshnessMs: FRESHNESS_MS,
        cacheTtlMs: 0,
        now: () => NOW,
        ...overrides,
      });
      const request = {
        model: { provider: "opencode-go", id: "auto", reasoning: false },
        thinkingLevel: "high",
        reason: "user",
        messages: [],
      };

      const gatewayPi = piFor();
      vr.registerAutoRouter(gatewayPi, deps("agent-zero"));
      const secondPi = piFor();
      vr.registerAutoRouter(secondPi, deps("opencode-go"));
      check(
        "each provider id gets its own definition",
        gatewayPi.virtual.length === 1 &&
          gatewayPi.virtual[0].provider === "agent-zero" &&
          secondPi.virtual.length === 1 &&
          secondPi.virtual[0].provider === "opencode-go",
      );

      const first = secondPi.virtual[0].route(request, ctx);
      check(
        "the second entry answers from its own provider's route",
        first.model === registry.get("opencode-go/deepseek-v4.1-flash") &&
          first.state?.why === "user-health",
        JSON.stringify(first.state),
      );

      // The route the second entry leads with goes spent: the same entry walks
      // to the gateway, which serves the request through its own translated id.
      const spent = snapshot([
        entry("opencode-go", {
          ring: { usable: 0, total: 1 },
          modelIds: [],
          models: { "deepseek-v4.1-flash": "deepseek-v4.1-flash" },
        }),
        entry("agent-zero", {
          modelIds: [],
          models: { "deepseek-v4.1-flash": "deepseek-v4-1-flash" },
        }),
      ]);
      const walkedPi = piFor();
      vr.registerAutoRouter(
        walkedPi,
        deps("opencode-go", { readSnapshot: () => spent }),
      );
      const walked = walkedPi.virtual[0].route(request, ctx);
      check(
        "a spent leading route walks to the gateway's translated id",
        walked.model === registry.get("agent-zero/deepseek-v4-1-flash"),
        JSON.stringify(walked.state),
      );

      // A retry after the leading route's recorded shape death moves the
      // request the same way: off the dead route, onto the translated id.
      const deadLead = snapshot([
        entry("opencode-go", {
          modelIds: [],
          models: { "deepseek-v4.1-flash": "deepseek-v4.1-flash" },
          deathClass: "request-shape",
          deathAt: NOW - 10,
          deathModelId: "deepseek-v4.1-flash",
        }),
        entry("agent-zero", {
          modelIds: [],
          models: { "deepseek-v4.1-flash": "deepseek-v4-1-flash" },
        }),
      ]);
      const retryPi = piFor();
      vr.registerAutoRouter(
        retryPi,
        deps("opencode-go", { readSnapshot: () => deadLead }),
      );
      const retried = retryPi.virtual[0].route(
        {
          ...request,
          reason: "retry",
          failed: {
            model: model("opencode-go", "deepseek-v4.1-flash"),
            thinkingLevel: "high",
          },
        },
        ctx,
      );
      check(
        "a retry off the second entry's dead route lands on the gateway",
        retried.model === registry.get("agent-zero/deepseek-v4-1-flash") &&
          retried.state?.why === "retry-moved",
        JSON.stringify(retried.state),
      );

      // Collision is per provider: a physical `auto` on one entry skips only
      // that entry, and the other entry still registers.
      const collidedPi = piFor();
      vr.registerAutoRouter(
        collidedPi,
        deps("opencode-go", { hasPhysicalModel: (id) => id === "auto" }),
      );
      const stillA0 = piFor();
      vr.registerAutoRouter(stillA0, deps("agent-zero"));
      check(
        "a physical `auto` on the second provider skips only its entry",
        collidedPi.virtual.length === 0 && stillA0.virtual.length === 1,
      );

      // The requested level resolves against the target the second entry
      // picked, not against the entry's own declaration.
      const levelRegistry = new Map([
        [
          "opencode-go/deepseek-v4.1-flash",
          model("opencode-go", "deepseek-v4.1-flash", {
            thinkingLevelMap: { high: "high", max: "max" },
          }),
        ],
      ]);
      const levelCtx = {
        modelRegistry: {
          find: (provider, id) => levelRegistry.get(`${provider}/${id}`),
        },
      };
      const levelPi = piFor();
      vr.registerAutoRouter(levelPi, deps("opencode-go"));
      const top = levelPi.virtual[0].route(
        { ...request, thinkingLevel: "xhigh" },
        levelCtx,
      );
      check(
        "the second entry resolves the level against its own target",
        top.thinkingLevel === "max",
        top.thinkingLevel,
      );

      // `auto` as the configured base is never the base for the second entry
      // either: it derives from the table the same way.
      const autoBasePi = piFor();
      vr.registerAutoRouter(
        autoBasePi,
        deps("opencode-go", { logicalModelId: () => "auto" }),
      );
      const derived = autoBasePi.virtual[0].route(request, ctx);
      check(
        "a configured `auto` base derives from the table, never the virtual id",
        derived.model.id === "deepseek-v4.1-flash" &&
          derived.model.id !== "auto" &&
          derived.model.provider === "opencode-go",
        JSON.stringify(derived.state),
      );
    }

    console.log(`\n${total - failures}/${total} checks passed`);
    if (failures > 0) process.exit(1);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
