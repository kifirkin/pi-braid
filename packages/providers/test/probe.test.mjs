#!/usr/bin/env node
/**
 * probe.test.mjs
 *
 * Probe-layer regression suite for packages/providers, offline (fixtures only,
 * no network): the provider-agnostic runner in probe.ts, its adapter table, and
 * the route-descriptor plumbing that carries a `probe` capability from settings
 * through the registration table.
 *
 * Covers:
 *   1. The headroom rule on fixtures: the openrouter `/key` shape (numeric cap
 *      ⇒ ok / degraded / unavailable by remaining share; null cap ⇒
 *      unlimited/ok), the Venice status document (epoch allocation pair ⇒
 *      headroom; live rate_limits projection ⇒ ok + reset), the deepseek
 *      balance shape, and a shape change ⇒ unavailable.
 *   2. Transport failures map to unavailable, never a rejection: non-2xx (a 402
 *      body), a thrown fetch, unparseable JSON.
 *   3. A provider with no adapter (zai, minimax) and the one with no
 *      non-billable endpoint at all (agent-zero) are reported WITHOUT any fetch: one
 *      lookup decides, and the network is never touched.
 *   4. Descriptor mechanics: the descriptor's URL and `Bearer <key>` auth
 *      header reach the transport; a custom `authHeader` is honored; an absent
 *      key short-circuits before the fetch.
 *   5. Route plumbing: the `probe` field survives `resolveRoutesConfig`
 *      (trimmed), an invalid one is SKIPPED with a named diagnostic, and an
 *      absent one leaves the resolved entry with exactly the previous shape
 *      (no new key). `registerRoute` carries it into the registration table.
 *
 * Harness: the REAL modules (probe, ring-lifecycle, key-ring, log) are compiled
 * with the package's own local tsc (CJS emit) into <repoRoot>/.probe-build/ and
 * driven with an injected fetch. HOME is redirected to an isolated temp dir so
 * the key rings never touch the real ~/.pi/agent.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const buildDir = join(repoRoot, ".probe-build");

const ROUTE_KEY_PREFIX = "PROBE_TEST_API_KEY";
const ROUTE_KEY_VALUE = "probe-test-key-0";

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

/** Compile the handler modules to CJS in buildDir and load them. */
function loadModules() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const args = [
    tscBin,
    "--ignoreConfig",
    join(pkgRoot, "probe.ts"),
    join(pkgRoot, "ring-lifecycle.ts"),
    join(pkgRoot, "key-ring.ts"),
    join(pkgRoot, "log.ts"),
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
  if (!process.env.PI_BRAID_PROVIDER_QUIET && tsc.stdout)
    console.log(tsc.stdout.trim());
  const require = createRequire(import.meta.url);
  return {
    probe: require(join(buildDir, "probe.js")),
    rl: require(join(buildDir, "ring-lifecycle.js")),
  };
}

/**
 * A recorded fake transport. `body` may be the special JUNK symbol to make
 * json() reject. Exposes its call log.
 */
const JUNK = Symbol("junk-json");
function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (body === JUNK) throw new Error("not json");
        return body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

function throwingFetch(message) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    throw new Error(message);
  };
  fn.calls = calls;
  return fn;
}

const DESCRIPTOR = { url: "https://status.example/v1/status" };

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-probe-"));
  try {
    process.env.HOME = scratch;
    for (const key of Object.keys(process.env)) {
      if (/^(AGENT_ZERO_API_KEY|PROBE_TEST_API_KEY)(_P\d+)?$/.test(key)) {
        delete process.env[key];
      }
    }
    process.env[ROUTE_KEY_PREFIX] = ROUTE_KEY_VALUE;
    mkdirSync(join(scratch, ".pi", "agent"), { recursive: true });

    const { probe, rl } = loadModules();
    const KEY = "test-probe-key";

    // ── 1. Headroom rule on documented shapes ─────────────���──────────────
    {
      const openrouter = {
        data: {
          limit: 200,
          limit_remaining: 150,
          limit_reset: null,
          usage_monthly: 50,
          is_free_tier: false,
        },
      };
      const out = await probe.probeRoute("openrouter", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, openrouter),
        now: () => 111,
      });
      check(
        "openrouter: over the threshold is ok, spend/cap/headroom recorded",
        out.state === "ok" &&
          out.headroomPct === 75 &&
          out.spendUsd === 50 &&
          out.capUsd === 200 &&
          out.at === 111,
        JSON.stringify(out),
      );
      check(
        "openrouter: remainingUsd is the endpoint's own limit_remaining",
        out.remainingUsd === 150,
        JSON.stringify(out),
      );

      const low = await probe.probeRoute("openrouter", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, {
          data: { ...openrouter.data, limit_remaining: 2 },
        }),
      });
      check(
        "openrouter: at or below the threshold is degraded",
        low.state === "degraded" && low.headroomPct === 1,
        JSON.stringify(low),
      );

      const spent = await probe.probeRoute("openrouter", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, {
          data: { ...openrouter.data, limit_remaining: 0 },
        }),
      });
      check(
        "openrouter: zero remaining is unavailable with a reason",
        spent.state === "unavailable" &&
          spent.headroomPct === 0 &&
          spent.reason === "no headroom",
        JSON.stringify(spent),
      );

      const unlimited = await probe.probeRoute("openrouter", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, {
          data: { limit: null, limit_remaining: null, is_free_tier: true },
        }),
      });
      check(
        "openrouter: a null limit is unlimited ⇒ ok, no headroom",
        unlimited.state === "ok" && unlimited.headroomPct === undefined,
        JSON.stringify(unlimited),
      );
    }

    {
      // An epoch boundary as DATA (a fixed instant, not a calendar label).
      const reset = new Date(1_800_000_000_000).toISOString();
      const rateLimits = {
        data: {
          apiTier: { id: "paid", isCharged: true },
          balances: { USD: 1.23, DIEM: 0, BUNDLED_CREDITS: 0 },
          nextEpochBegins: reset,
        },
      };
      const out = await probe.probeRoute("venice-direct", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, rateLimits),
      });
      check(
        "venice-direct: the rate_limits projection is ok and carries the reset",
        out.state === "ok" && out.resetAt === Date.parse(reset),
        JSON.stringify(out),
      );

      const withAllocation = (used, allocation) => ({
        data: {
          canConsume: true,
          balances: { diem: used, diemEpochAllocation: allocation },
          nextEpochBegins: reset,
        },
      });
      const roomy = await probe.probeRoute("venice-direct", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, withAllocation(40, 100)),
      });
      const tight = await probe.probeRoute("venice-direct", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, withAllocation(90, 100)),
      });
      const dry = await probe.probeRoute("venice-direct", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, withAllocation(100, 100)),
      });
      check(
        "venice-direct: the allocation pair maps ok / degraded / unavailable by headroom",
        roomy.state === "ok" &&
          roomy.headroomPct === 60 &&
          tight.state === "degraded" &&
          tight.headroomPct === 10 &&
          dry.state === "unavailable" &&
          dry.headroomPct === 0,
        [roomy.state, tight.state, dry.state].join("/"),
      );

      const blocked = await probe.probeRoute("venice-direct", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, {
          data: {
            canConsume: false,
            balances: { diem: 0, diemEpochAllocation: 0 },
          },
        }),
      });
      check(
        "venice-direct: canConsume false is unavailable",
        blocked.state === "unavailable" &&
          blocked.reason === "reported unavailable",
        JSON.stringify(blocked),
      );

      const weird = await probe.probeRoute("venice-direct", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, { data: { unexpected: true } }),
      });
      check(
        "venice-direct: an unexpected body is a shape change, not a state",
        weird.state === "unavailable" && weird.reason === "shape change",
        JSON.stringify(weird),
      );
    }

    {
      // Venice headroom from the USD balance, against the route's floor.
      const balanceOf = (usd) => ({ data: { balances: { USD: usd } } });
      const above = await probe.probeRoute("venice-direct", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, balanceOf(5)),
        now: () => 222,
      });
      check(
        "venice-direct: a balance above the floor is ok and carries remainingUsd",
        above.state === "ok" &&
          above.remainingUsd === 5 &&
          above.headroomPct === undefined &&
          above.at === 222,
        JSON.stringify(above),
      );

      const atFloor = await probe.probeRoute("venice-direct", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, balanceOf(1)),
      });
      check(
        "venice-direct: a balance at the floor is degraded",
        atFloor.state === "degraded" && atFloor.remainingUsd === 1,
        JSON.stringify(atFloor),
      );

      const zeroBalance = await probe.probeRoute(
        "venice-direct",
        DESCRIPTOR,
        KEY,
        { fetch: fakeFetch(200, balanceOf(0)) },
      );
      check(
        "venice-direct: a zero balance is unavailable with a reason",
        zeroBalance.state === "unavailable" &&
          zeroBalance.reason === "no balance" &&
          zeroBalance.remainingUsd === 0,
        JSON.stringify(zeroBalance),
      );

      const measured = await probe.probeRoute(
        "venice-direct",
        DESCRIPTOR,
        KEY,
        {
          fetch: fakeFetch(200, balanceOf(0.0738)),
        },
      );
      check(
        "venice-direct: a balance below the floor stops reading as healthy",
        measured.state === "degraded" && measured.remainingUsd === 0.0738,
        JSON.stringify(measured),
      );

      const override = await probe.probeRoute(
        "venice-direct",
        { url: DESCRIPTOR.url, balanceFloorUsd: 0 },
        KEY,
        { fetch: fakeFetch(200, balanceOf(0.5)) },
      );
      const defaultFloor = await probe.probeRoute(
        "venice-direct",
        DESCRIPTOR,
        KEY,
        { fetch: fakeFetch(200, balanceOf(0.5)) },
      );
      check(
        "a descriptor balanceFloorUsd override changes the verdict",
        override.state === "ok" && defaultFloor.state === "degraded",
        JSON.stringify({ override, defaultFloor }),
      );

      const malformed = await probe.probeRoute(
        "venice-direct",
        DESCRIPTOR,
        KEY,
        { fetch: fakeFetch(200, { data: { balances: "nope" } }) },
      );
      const noFigures = await probe.probeRoute(
        "venice-direct",
        DESCRIPTOR,
        KEY,
        { fetch: fakeFetch(200, { data: { balances: {} } }) },
      );
      check(
        "venice-direct: a malformed or figureless balances is a shape change, never a throw",
        malformed.state === "unavailable" &&
          malformed.reason === "shape change" &&
          noFigures.state === "unavailable" &&
          noFigures.reason === "shape change",
        JSON.stringify({ malformed, noFigures }),
      );
    }

    {
      const available = await probe.probeRoute("deepseek", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, {
          is_available: true,
          balance_infos: [{ currency: "USD", total_balance: "12.30" }],
        }),
      });
      check(
        "deepseek: is_available true is ok (the shape reports no cap)",
        available.state === "ok",
        JSON.stringify(available),
      );
      const down = await probe.probeRoute("deepseek", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, { is_available: false, balance_infos: [] }),
      });
      check(
        "deepseek: is_available false is unavailable",
        down.state === "unavailable" && down.reason === "reported unavailable",
        JSON.stringify(down),
      );
      const bad = await probe.probeRoute("deepseek", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, { is_available: true }),
      });
      check(
        "deepseek: a missing balance list is a shape change",
        bad.state === "unavailable" && bad.reason === "shape change",
        JSON.stringify(bad),
      );
    }

    // ── 2. Transport failures never reject ──────────────────────────────
    {
      const limited = fakeFetch(402, { error: "payment required" });
      const out = await probe.probeRoute("openrouter", DESCRIPTOR, KEY, {
        fetch: limited,
      });
      check(
        "a non-2xx response is unavailable and the body is never parsed",
        out.state === "unavailable" &&
          out.reason === "http 402" &&
          limited.calls.length === 1,
        JSON.stringify(out),
      );

      const thrown = throwingFetch("connection reset");
      const netOut = await probe.probeRoute("openrouter", DESCRIPTOR, KEY, {
        fetch: thrown,
      });
      check(
        "a thrown transport is unavailable with a network reason",
        netOut.state === "unavailable" &&
          netOut.reason === "network: connection reset",
        JSON.stringify(netOut),
      );

      const junk = await probe.probeRoute("openrouter", DESCRIPTOR, KEY, {
        fetch: fakeFetch(200, JUNK),
      });
      check(
        "unparseable JSON is unavailable",
        junk.state === "unavailable" && junk.reason === "malformed json",
        JSON.stringify(junk),
      );
    }

    // ── 3. No adapter / no endpoint: one lookup, no network ─────────────
    for (const providerId of ["zai", "minimax"]) {
      const transport = fakeFetch(200, {});
      const out = await probe.probeRoute(providerId, DESCRIPTOR, KEY, {
        fetch: transport,
      });
      check(
        `${providerId}: no adapter ⇒ unavailable without a fetch`,
        out.state === "unavailable" &&
          out.reason === "no adapter" &&
          transport.calls.length === 0,
        JSON.stringify(out),
      );
    }
    {
      const transport = fakeFetch(200, {});
      const out = await probe.probeRoute("agent-zero", DESCRIPTOR, KEY, {
        fetch: transport,
      });
      check(
        "agent-zero: no non-billable endpoint ⇒ unavailable without a fetch",
        out.state === "unavailable" &&
          out.reason === "no free endpoint" &&
          transport.calls.length === 0,
        JSON.stringify(out),
      );
      const unknown = await probe.probeRoute("not-a-route", DESCRIPTOR, KEY, {
        fetch: transport,
      });
      check(
        "an unknown provider is unavailable with the same no-adapter reason",
        unknown.state === "unavailable" && unknown.reason === "no adapter",
        JSON.stringify(unknown),
      );
    }

    // ── 4. Descriptor mechanics ────────────────────────────────────────
    {
      const transport = fakeFetch(200, {
        data: { limit: 10, limit_remaining: 10, is_free_tier: false },
      });
      await probe.probeRoute("openrouter", DESCRIPTOR, KEY, {
        fetch: transport,
      });
      const call = transport.calls[0];
      check(
        "the descriptor URL and the bearer auth header reach the transport",
        call.url === DESCRIPTOR.url &&
          call.init.method === "GET" &&
          call.init.headers.Authorization === `Bearer ${KEY}`,
        JSON.stringify(call),
      );
      check(
        "the probe is bounded by an abort signal",
        typeof call.init.signal === "object" && call.init.signal !== null,
      );

      const custom = fakeFetch(200, {
        data: { limit: 10, limit_remaining: 10, is_free_tier: false },
      });
      await probe.probeRoute(
        "openrouter",
        { url: DESCRIPTOR.url, authHeader: "X-Api-Key" },
        KEY,
        { fetch: custom },
      );
      check(
        "a custom authHeader replaces the default bearer header name",
        custom.calls[0].init.headers["X-Api-Key"] === `Bearer ${KEY}` &&
          custom.calls[0].init.headers.Authorization === undefined,
        JSON.stringify(custom.calls[0].init.headers),
      );

      const missing = fakeFetch(200, {});
      const out = await probe.probeRoute("openrouter", DESCRIPTOR, null, {
        fetch: missing,
      });
      check(
        "an absent key short-circuits before the fetch",
        out.state === "unavailable" &&
          out.reason === "no key" &&
          missing.calls.length === 0,
        JSON.stringify(out),
      );
    }

    // ── 5. Route plumbing: resolution + registration ────────────────────
    {
      const resolved = rl.resolveRoutesConfig([
        {
          provider: "p",
          keys: "P_KEY",
          probe: { url: " https://s.example/status ", authHeader: " X-Key " },
        },
        { provider: "q", keys: "Q_KEY" },
      ]);
      check(
        "resolver: the probe field survives with trimmed url and authHeader",
        resolved.diagnostics.length === 0 &&
          resolved.routes[0].probe.url === "https://s.example/status" &&
          resolved.routes[0].probe.authHeader === "X-Key" &&
          resolved.routes[1].probe === undefined,
        JSON.stringify(resolved.routes),
      );
      check(
        "resolver: an entry without probe keeps exactly the previous shape",
        JSON.stringify(resolved.routes[1]) ===
          '{"provider":"q","keys":"Q_KEY"}',
        JSON.stringify(resolved.routes[1]),
      );
      check(
        "resolver: an entry without models or probe carries no extra keys",
        Object.keys(resolved.routes[1]).join(",") === "provider,keys",
      );

      const bad = rl.resolveRoutesConfig([
        { provider: "a", keys: "K", probe: 3 },
        { provider: "b", keys: "K", probe: {} },
        { provider: "c", keys: "K", probe: { url: "u", authHeader: 5 } },
        { provider: "ok", keys: "K", probe: { url: "u" } },
      ]);
      check(
        "resolver: an invalid probe skips the entry with a named diagnostic",
        bad.routes.length === 1 &&
          bad.routes[0].provider === "ok" &&
          bad.diagnostics[0] ===
            "routes[0].probe: must be an object carrying a non-empty url" &&
          bad.diagnostics[1] ===
            "routes[1].probe.url: must be a non-empty string" &&
          bad.diagnostics[2] ===
            "routes[2].probe.authHeader: must be a non-empty string",
        JSON.stringify(bad.diagnostics),
      );

      const withFloor = rl.resolveRoutesConfig([
        { provider: "f", keys: "K", probe: { url: "u", balanceFloorUsd: 0 } },
      ]);
      check(
        "resolver: a numeric balanceFloorUsd survives with the probe shape",
        withFloor.diagnostics.length === 0 &&
          withFloor.routes[0].probe.balanceFloorUsd === 0 &&
          Object.keys(withFloor.routes[0].probe).join(",") ===
            "url,balanceFloorUsd",
        JSON.stringify(withFloor),
      );

      const badFloor = rl.resolveRoutesConfig([
        { provider: "a", keys: "K", probe: { url: "u", balanceFloorUsd: "1" } },
        { provider: "b", keys: "K", probe: { url: "u", balanceFloorUsd: -1 } },
        {
          provider: "c",
          keys: "K",
          probe: { url: "u", balanceFloorUsd: Number.POSITIVE_INFINITY },
        },
        { provider: "ok", keys: "K", probe: { url: "u" } },
      ]);
      check(
        "resolver: a non-numeric or negative balanceFloorUsd skips the entry by name",
        badFloor.routes.length === 1 &&
          badFloor.routes[0].provider === "ok" &&
          badFloor.diagnostics.length === 3 &&
          badFloor.diagnostics.every((d) =>
            d.endsWith(
              "probe.balanceFloorUsd: must be a non-negative finite number",
            ),
          ),
        JSON.stringify(badFloor.diagnostics),
      );

      const ring = rl.createRouteRing({
        provider: "probe-route",
        keys: ROUTE_KEY_PREFIX,
      });
      rl.registerRoute({
        providerId: "probe-route",
        keys: ROUTE_KEY_PREFIX,
        modelIds: [],
        probe: { url: "https://s.example/status" },
        ring,
      });
      rl.registerRoute({
        providerId: "plain-route",
        keys: ROUTE_KEY_PREFIX,
        modelIds: [],
        ring: rl.createRouteRing({
          provider: "plain-route",
          keys: ROUTE_KEY_PREFIX,
        }),
      });
      check(
        "registration: the probe descriptor is carried verbatim",
        rl.getRouteRegistrationForTest("probe-route").probe.url ===
          "https://s.example/status",
      );
      check(
        "registration: a route without a probe stores none",
        rl.getRouteRegistrationForTest("plain-route").probe === undefined,
      );
    }
  } finally {
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
