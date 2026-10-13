/**
 * writer-containment.mjs — child driver for state-paths.test.ts's containment
 * checks: one mode per relocated contrib writer, each driving the REAL write
 * with BRAID_HOME pinned (the parent pins it) and the cwd a throwaway
 * project. Prints one JSON line; the parent asserts the write landed under
 * the pin and that the cwd tree did not change.
 *
 *   observatory        the extension entry's session_start recorder
 *   browser-screenshot saveScreenshotToFile (no live browser needed)
 *   browser-profile    prepareScrapingProfile's mkdir/lock-clear (no Chrome)
 *   healthcheck        testMemoryAndState's read-write-unlink probe
 *   healthcheck-writers testFilesystem's write-test/subdir probes plus the
 *                      extension's own report write, driven through the
 *                      registered tool (filesystem category only)
 *   healthcheck-tools  testAgentTools' probe set, driven through the
 *                      registered tool (tools category only), with both
 *                      candidate healthcheck dirs watched: its probe file is
 *                      created and unlinked inside the check, so only a watch
 *                      can say which root it landed on
 *
 * Not a test file: state-paths.test.ts spawns it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mode = process.argv[2];

if (mode === "observatory") {
  const { default: observatoryExtension } =
    await import("../observatory/index.ts");
  const handlers = {};
  const pi = {
    on(name, fn) {
      handlers[name] = fn;
    },
    registerTool() {},
    registerCommand() {},
    getAllTools() {
      return [];
    },
  };
  observatoryExtension(pi);
  const sessionStart = handlers["session_start"];
  if (typeof sessionStart !== "function") {
    throw new Error(
      "observatory registered no session_start handler (recording disabled? settings.json missing?)",
    );
  }
  await sessionStart({ model: "containment-probe" }, { cwd: process.cwd() });
  const { observatorySessionsDir } = await import("../state-paths.ts");
  const dir = observatorySessionsDir();
  const files = dir !== null && fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  process.stdout.write(JSON.stringify({ dir, files }) + "\n");
} else if (mode === "browser-screenshot") {
  const { saveScreenshotToFile } = await import("../browser/index.ts");
  const saved = saveScreenshotToFile("aGVsbG8=", "png");
  process.stdout.write(JSON.stringify({ saved }) + "\n");
} else if (mode === "browser-profile") {
  const { prepareScrapingProfile } = await import("../browser/cdp.ts");
  const dir = prepareScrapingProfile();
  process.stdout.write(
    JSON.stringify({ dir, exists: fs.existsSync(dir) }) + "\n",
  );
} else if (mode === "healthcheck") {
  const { testMemoryAndState } = await import("../healthcheck/checks/state.ts");
  const checks = testMemoryAndState().map((c) => ({
    name: c.name,
    status: c.status,
    message: c.message,
  }));
  process.stdout.write(JSON.stringify({ checks }) + "\n");
} else if (mode === "healthcheck-writers") {
  const { testFilesystem } =
    await import("../healthcheck/checks/filesystem.ts");
  const { default: healthcheckExtension } =
    await import("../healthcheck/index.ts");
  const checks = testFilesystem().map((c) => ({
    name: c.name,
    status: c.status,
    message: c.message,
  }));

  // The extension's own report write, driven through the registered tool.
  let registered = null;
  healthcheckExtension({
    registerTool(tool) {
      registered = tool;
    },
    on() {},
    registerCommand() {},
    getAllTools() {
      return [];
    },
  });
  if (typeof registered?.execute !== "function") {
    throw new Error("the healthcheck extension registered no executable tool");
  }
  await registered.execute("containment", { categories: ["filesystem"] });
  process.stdout.write(JSON.stringify({ checks }) + "\n");
} else if (mode === "healthcheck-tools") {
  const { healthcheckDir } = await import("pi-braid/lib");
  const { default: healthcheckExtension } =
    await import("../healthcheck/index.ts");

  // Both candidates must exist before the probes run: the default tree's dir
  // is what a folded constant resolves, and a fold writes there without
  // failing (a real install's default tree exists). It is created for the
  // watch and removed below, so the child leaves its HOME tree unchanged.
  const pinDir = healthcheckDir();
  const foldedDir = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "braid",
    "healthcheck",
  );
  const watch = (dir) => {
    const events = [];
    fs.mkdirSync(dir, { recursive: true });
    const watcher = fs.watch(dir, (_event, filename) => {
      events.push(filename === null ? "(unknown)" : String(filename));
    });
    return { dir, events, watcher };
  };
  const pin = watch(pinDir);
  const folded = watch(foldedDir);

  let registered = null;
  healthcheckExtension({
    registerTool(tool) {
      registered = tool;
    },
    on() {},
    registerCommand() {},
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
  });
  if (typeof registered?.execute !== "function") {
    throw new Error("the healthcheck extension registered no executable tool");
  }
  const result = await registered.execute("containment", {
    categories: ["tools"],
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  pin.watcher.close();
  folded.watcher.close();

  // Remove the watch fixture, then the empty ancestors it required: HOME's
  // tree must come back exactly as the child found it.
  fs.rmSync(foldedDir, { recursive: true, force: true });
  for (
    let dir = path.dirname(foldedDir);
    dir !== os.homedir() && dir.startsWith(os.homedir() + path.sep);
    dir = path.dirname(dir)
  ) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break;
    }
  }

  const checks = (result?.details?.checks ?? []).map((c) => ({
    name: c.name,
    status: c.status,
    message: c.message,
  }));
  process.stdout.write(
    JSON.stringify({
      checks,
      events: { pin: pin.events, folded: folded.events },
    }) + "\n",
  );
} else {
  throw new Error(`unknown mode: ${mode}`);
}
