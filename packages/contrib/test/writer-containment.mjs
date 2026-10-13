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
 *
 * Not a test file: state-paths.test.ts spawns it.
 */
import * as fs from "node:fs";

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
} else {
  throw new Error(`unknown mode: ${mode}`);
}
