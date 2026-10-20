/**
 * tool input defaults: a blank selector means absent across the contrib tools.
 *
 * Why this harness exists: pi validates a tool call before a handler runs, and
 * `validateToolArguments` runs TypeBox `Value.Convert` over the raw arguments.
 * Convert turns a blank string into 0 for `Type.Optional(Type.Number())` and
 * `Type.Optional(Type.Integer())`, keeps `[""]` for `Type.Array(Type.String())`,
 * and keeps `""` for `Type.Optional(Type.String())`. The converted value then
 * passes the schema check, so an `x ?? default` read cannot tell a blank key (a
 * client that emits every schema key sends "") from a real value. Before this
 * fix that produced, in six independent packages:
 *
 *   repl           a 0ms evaluation deadline ("Execution timed out after 0ms")
 *                  and a 0 recursion bound for ctx.subCall
 *   observatory    a tail of 0 events, reported as "no events recorded yet"
 *   healthcheck    a `[""]` category filter that matched nothing, so every
 *                  probe was skipped and the report was empty
 *   codebase       a depth-0 tree (root entry only) and a filter that selected
 *                  no graph section (header-only output)
 *   network-monitor a refusal naming the empty argument: `Unknown client ""`
 *
 * Four legs, all offline:
 *   1. the conversion: each site's blank value driven through the framework's
 *      own validateToolArguments, which is what makes a blank selector
 *      indistinguishable from 0 once a handler sees it;
 *   2. schema boundary: file_diff's format and codebase's find are closed
 *      unions, so an unknown or blank value is refused at validation rather
 *      than silently falling back;
 *   3. resolution: every resolver, one case per selector shape, each named with
 *      its expected outcome, plus the repl tool driven end to end for the
 *      deadline defect;
 *   4. wiring: each index.ts routes its site through its resolver and carries
 *      none of the pre-fix expressions.
 *
 * Run: node packages/contrib/test/tool-input-defaults.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRIB = join(HERE, "..");

// Every extension here reads its toggles (and network-monitor its settings)
// from HOME, so all six register against a throwaway tree with an empty
// settings document: defaults on, the developer's own settings untouched.
const HOME = mkdtempSync(join(tmpdir(), "tool-input-defaults-"));
process.env.HOME = HOME;
process.env.BRAID_HOME = join(HOME, "braid");
mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({}));

// The contrib sources import each other with `.js` specifiers that only pi's
// loader resolves, so the same hook the package's other child drivers use is
// registered before any source import.
register(new URL("./lib/ts-resolve.mjs", import.meta.url));

const importFrom = (relative) =>
  import(pathToFileURL(join(CONTRIB, relative)).href);

const { validateToolArguments } =
  await import("@earendil-works/pi-ai/utils/validation");
const { isClientId } = await importFrom("network-monitor/clients.ts");

const EXTENSIONS = {
  repl: {
    index: await importFrom("repl/index.ts"),
    inputs: await importFrom("repl/tool-inputs.ts"),
    tools: ["repl"],
  },
  observatory: {
    index: await importFrom("observatory/index.ts"),
    inputs: await importFrom("observatory/tool-inputs.ts"),
    tools: ["observatory"],
  },
  healthcheck: {
    index: await importFrom("healthcheck/index.ts"),
    inputs: await importFrom("healthcheck/tool-inputs.ts"),
    tools: ["healthcheck"],
  },
  codebase: {
    index: await importFrom("codebase/index.ts"),
    inputs: await importFrom("codebase/tool-inputs.ts"),
    tools: ["codebase"],
  },
  diff: {
    index: await importFrom("diff/index.ts"),
    inputs: null,
    tools: ["file_diff"],
  },
  "network-monitor": {
    index: await importFrom("network-monitor/index.ts"),
    inputs: await importFrom("network-monitor/tool-inputs.ts"),
    tools: ["tunnel_status", "tunnel_reconnect"],
  },
};

// ── the registered tools, captured from each extension itself ─────────────

for (const entry of Object.values(EXTENSIONS)) {
  entry.captured = [];
  entry.index.default({
    registerTool: (tool) => entry.captured.push(tool),
    registerCommand: () => {},
    on: () => {},
    setActiveTools: () => {},
    getAllTools: () => [],
  });
  for (const name of entry.tools) {
    assert.ok(
      entry.captured.some((candidate) => candidate.name === name),
      `tool ${name} is not registered`,
    );
  }
}

function tool(extensionName, toolName) {
  const entry = EXTENSIONS[extensionName];
  const found = entry.captured.find((candidate) => candidate.name === toolName);
  assert.ok(found, `tool ${toolName} is not registered`);
  return found;
}

/** Drive raw arguments through the framework's own validation, as pi does. */
function validated(extensionName, toolName, args) {
  return validateToolArguments(
    { name: toolName, parameters: tool(extensionName, toolName).parameters },
    { name: toolName, arguments: args },
  );
}

/** The framework's refusal message, or a failure if the call was accepted. */
function refusal(extensionName, toolName, args) {
  try {
    validated(extensionName, toolName, args);
  } catch (err) {
    return err.message;
  }
  assert.fail(
    `${toolName} accepted ${JSON.stringify(args)}; validation was supposed to refuse it`,
  );
}

// ── the conversion that makes blank indistinguishable from 0 ──────────────

describe("schema boundary: what a blank value becomes", () => {
  it("a blank repl limit reaches the handler as the number 0", () => {
    assert.equal(
      validated("repl", "repl", { code: "1", max_calls: "" }).max_calls,
      0,
      "a blank max_calls arrives as 0, which is why `?? 10` could not help",
    );
    assert.equal(
      validated("repl", "repl", { code: "1", timeout_ms: "" }).timeout_ms,
      0,
      "a blank timeout_ms arrives as 0, a deadline of now",
    );
  });

  it("a blank observatory limit reaches the handler as the number 0", () => {
    assert.equal(
      validated("observatory", "observatory", { action: "events", limit: "" })
        .limit,
      0,
      "a blank limit arrives as 0, so the tail took no events",
    );
  });

  it('a blank healthcheck categories value becomes [""]', () => {
    assert.deepEqual(
      validated("healthcheck", "healthcheck", { categories: "" }).categories,
      [""],
      "a bare blank is converted to one blank element, which matches no category",
    );
    assert.deepEqual(
      validated("healthcheck", "healthcheck", { categories: ["", "shell"] })
        .categories,
      ["", "shell"],
      "a blank element survives validation next to a real one",
    );
  });

  it("a blank codebase depth reaches the handler as the number 0", () => {
    assert.equal(
      validated("codebase", "codebase", { action: "tree", maxDepth: "" })
        .maxDepth,
      0,
      "a blank maxDepth arrives as 0, so the walk stopped at the root entry",
    );
  });

  it('a blank network-monitor client reaches the handler as ""', () => {
    const params = validated("network-monitor", "tunnel_status", {
      client: "",
    });
    assert.equal(
      params.client,
      "",
      "a blank client arrives as the empty string, which `??` keeps",
    );
  });

  it("an absent optional key stays absent, so the handler's default applies", () => {
    assert.equal(
      "client" in validated("network-monitor", "tunnel_status", {}),
      false,
    );
    assert.equal(
      "format" in validated("diff", "file_diff", { a: "x", b: "y" }),
      false,
    );
    assert.equal(
      "limit" in validated("observatory", "observatory", { action: "events" }),
      false,
    );
  });
});

// ── closed unions: unknown values are refused, not defaulted ──────────────

describe("closed unions", () => {
  it("file_diff accepts the three formats the module renders", () => {
    for (const format of ["unified", "summary", "stat"]) {
      assert.equal(
        validated("diff", "file_diff", { a: "x", b: "y", format }).format,
        format,
        `format "${format}" must pass validation unchanged`,
      );
    }
  });

  it("file_diff refuses a blank format, naming the parameter", () => {
    assert.match(
      refusal("diff", "file_diff", { a: "x", b: "y", format: "" }),
      /- format:/,
    );
  });

  it("file_diff refuses an unknown format instead of rendering unified", () => {
    assert.match(
      refusal("diff", "file_diff", { a: "x", b: "y", format: "side-by-side" }),
      /- format:/,
      "the refusal is the framework's own validation error, naming format",
    );
  });

  it("codebase accepts the five graph filters", () => {
    for (const find of ["dead-ends", "orphans", "hubs", "cycles", "all"]) {
      assert.equal(
        validated("codebase", "codebase", { action: "graph", find }).find,
        find,
        `find "${find}" must pass validation unchanged`,
      );
    }
  });

  it("codebase refuses a blank or unknown graph filter", () => {
    assert.match(
      refusal("codebase", "codebase", { action: "graph", find: "" }),
      /- find:/,
    );
    assert.match(
      refusal("codebase", "codebase", { action: "graph", find: "nope" }),
      /- find:/,
    );
  });
});

// ── resolution, without running any extension side effect ────────────────

describe("repl resolvers", () => {
  const { resolveMaxCalls, resolveTimeoutMs } = EXTENSIONS.repl.inputs;

  it("an absent max_calls resolves to the documented 10", () => {
    assert.equal(resolveMaxCalls(undefined), 10);
  });

  it("a blank max_calls (arriving as 0) resolves to 10, not a 0 recursion bound", () => {
    assert.equal(resolveMaxCalls(0), 10);
  });

  it("a blank string max_calls resolves to 10 as well", () => {
    // Validation converts the blank to 0 before the handler, but the resolver
    // must not depend on that: a raw blank is "not provided" too.
    assert.equal(resolveMaxCalls(""), 10);
    assert.equal(resolveMaxCalls("   "), 10);
  });

  it("a negative or non-finite max_calls resolves to 10", () => {
    assert.equal(resolveMaxCalls(-3), 10);
    assert.equal(resolveMaxCalls(NaN), 10);
    assert.equal(resolveMaxCalls(Infinity), 10);
  });

  it("a positive max_calls is handed through", () => {
    assert.equal(resolveMaxCalls(4), 4);
  });

  it("an absent timeout_ms resolves to the documented 30000", () => {
    assert.equal(resolveTimeoutMs(undefined), 30000);
  });

  it("a blank timeout_ms (arriving as 0) resolves to 30000, not a deadline of now", () => {
    assert.equal(resolveTimeoutMs(0), 30000);
  });

  it("a blank string timeout_ms resolves to 30000 as well", () => {
    assert.equal(resolveTimeoutMs(""), 30000);
  });

  it("a positive timeout_ms is honoured", () => {
    assert.equal(resolveTimeoutMs(5000), 5000);
  });
});

describe("observatory resolver", () => {
  const { resolveEventLimit } = EXTENSIONS.observatory.inputs;

  it("an absent limit resolves to the documented 20", () => {
    assert.equal(resolveEventLimit(undefined), 20);
  });

  it("a blank limit (arriving as 0) resolves to 20, not an empty tail", () => {
    assert.equal(resolveEventLimit(0), 20);
  });

  it("a blank string limit resolves to 20 as well", () => {
    assert.equal(resolveEventLimit(""), 20);
  });

  it("a negative limit resolves to 20", () => {
    assert.equal(resolveEventLimit(-10), 20);
  });

  it("a positive limit is honoured and still capped at 200", () => {
    assert.equal(resolveEventLimit(5), 5);
    assert.equal(resolveEventLimit(500), 200);
  });
});

describe("healthcheck resolver", () => {
  const { resolveCategories } = EXTENSIONS.healthcheck.inputs;

  it("absent categories mean the documented default set", () => {
    assert.equal(resolveCategories(undefined), undefined);
    assert.equal(resolveCategories(null), undefined);
    assert.equal(resolveCategories("not-an-array"), undefined);
  });

  it("an empty array means the documented default set", () => {
    assert.equal(resolveCategories([]), undefined);
  });

  it("a blank-only list means the documented default set, not no probes", () => {
    assert.equal(resolveCategories([""]), undefined);
    assert.equal(resolveCategories(["", "   "]), undefined);
  });

  it("blank elements are dropped and the named ones kept as given", () => {
    assert.deepEqual(resolveCategories(["", "shell"]), ["shell"]);
    assert.deepEqual(resolveCategories(["Filesystem", " "]), ["Filesystem"]);
  });
});

describe("codebase resolvers", () => {
  const { resolveMaxDepth, resolveFind, DEFAULT_MAX_DEPTH, MAX_MAX_DEPTH } =
    EXTENSIONS.codebase.inputs;

  it("an absent depth resolves to the documented 3", () => {
    assert.equal(resolveMaxDepth(undefined), DEFAULT_MAX_DEPTH);
    assert.equal(DEFAULT_MAX_DEPTH, 3);
  });

  it("a blank depth (arriving as 0) resolves to 3, not a root-only tree", () => {
    assert.equal(resolveMaxDepth(0), 3);
  });

  it("a blank string depth resolves to the default as well", () => {
    assert.equal(resolveMaxDepth(""), 3);
  });

  it("a negative or fractional depth resolves to the default", () => {
    assert.equal(resolveMaxDepth(-2), 3);
    assert.equal(resolveMaxDepth(2.5), 3);
  });

  it("a positive depth is honoured and capped at the documented maximum", () => {
    assert.equal(resolveMaxDepth(2), 2);
    assert.equal(resolveMaxDepth(99), MAX_MAX_DEPTH);
    assert.equal(MAX_MAX_DEPTH, 10);
  });

  it("an absent or blank graph filter resolves to all", () => {
    assert.equal(resolveFind(undefined), "all");
    assert.equal(resolveFind(""), "all");
    assert.equal(resolveFind("   "), "all");
  });

  it("a known graph filter is handed through", () => {
    assert.equal(resolveFind("hubs"), "hubs");
  });
});

describe("network-monitor resolver", () => {
  const { resolveClientParam } = EXTENSIONS["network-monitor"].inputs;

  it("absent or null means the configured client", () => {
    assert.equal(resolveClientParam(undefined), undefined);
    assert.equal(resolveClientParam(null), undefined);
  });

  it("a blank or whitespace-only client means the configured client", () => {
    assert.equal(resolveClientParam(""), undefined);
    assert.equal(resolveClientParam("   "), undefined);
  });

  it("a named client is handed through, spelling included", () => {
    assert.equal(resolveClientParam("happ"), "happ");
    assert.equal(resolveClientParam(" happ "), " happ ");
  });

  it('a blank parameter composes to the configured client, so `Unknown client ""` is unreachable', () => {
    // The two lines pickAdapter runs, in order: resolve, then fall back to the
    // settings value. A blank must leave a valid id behind.
    const configured = "happ";
    const chosen = resolveClientParam("") ?? configured;
    assert.equal(chosen, configured);
    assert.equal(
      isClientId(chosen),
      true,
      "a blank parameter must not survive to the client-id check",
    );
  });
});

describe("repl end to end", () => {
  it("a blank timeout_ms still evaluates, instead of reporting a 0ms timeout", async () => {
    const repl = tool("repl", "repl");
    // The evaluation takes 25ms, so a 0ms deadline (what a blank key used to
    // become) loses the race and the call rejects before this code returns.
    const result = await repl.execute("call-blank-timeout", {
      code: "new Promise((resolve) => setTimeout(() => resolve(7), 25))",
      timeout_ms: 0,
      reset: true,
    });
    assert.equal(
      result.details.result,
      7,
      "the evaluation must complete; a 0ms deadline rejected before it ran",
    );
  });
});

// ── wiring: the sites use the resolvers ───────────────────────────────────

describe("index.ts wiring", () => {
  const sources = Object.fromEntries(
    Object.keys(EXTENSIONS).map((name) => [
      name,
      readFileSync(join(CONTRIB, name, "index.ts"), "utf-8"),
    ]),
  );

  it("repl routes both limits through its resolvers", () => {
    assert.ok(sources.repl.includes("resolveMaxCalls(params.max_calls)"));
    assert.ok(sources.repl.includes("resolveTimeoutMs(params.timeout_ms)"));
  });

  it("observatory tails events through resolveEventLimit", () => {
    assert.ok(
      sources.observatory.includes(
        "tailEvents(resolveEventLimit(params.limit))",
      ),
    );
  });

  it("healthcheck resolves its categories before shouldRun", () => {
    assert.ok(
      sources.healthcheck.includes(
        "const requestedCats = resolveCategories(params.categories);",
      ),
    );
  });

  it("codebase routes depth and filter through its resolvers", () => {
    assert.ok(sources.codebase.includes("resolveMaxDepth(params.maxDepth)"));
    assert.ok(sources.codebase.includes("resolveFind(params.find)"));
  });

  it("file_diff reads format without a truthiness fallback", () => {
    assert.ok(sources.diff.includes('params.format ?? "unified"'));
  });

  it("network-monitor resolves the client parameter in pickAdapter", () => {
    assert.ok(
      sources["network-monitor"].includes(
        "const id = resolveClientParam(requested) ?? s.client;",
      ),
    );
  });

  it("none of the pre-fix expressions survives", () => {
    const stale = {
      repl: ["params.max_calls ?? 10", "params.timeout_ms ?? 30000"],
      observatory: ["(params.limit as number | undefined) ?? 20"],
      healthcheck: ["const requestedCats = params.categories;"],
      codebase: [
        "(params.maxDepth as number | undefined) ?? DEFAULT_MAX_DEPTH",
        '(params.find as string | undefined) ?? "all"',
      ],
      diff: ['params.format || "unified"', 'default: "unified"'],
      "network-monitor": ["const id = requested ?? s.client;"],
    };
    for (const [name, expressions] of Object.entries(stale)) {
      for (const expression of expressions) {
        assert.equal(
          sources[name].includes(expression),
          false,
          `${name}/index.ts still contains the pre-fix expression: ${expression}`,
        );
      }
    }
  });
});
