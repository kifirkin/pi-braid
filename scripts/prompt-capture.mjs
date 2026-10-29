#!/usr/bin/env node
/**
 * prompt-capture — render one pi-braid build's assembled system prompt, and
 * diff two captures with the region each hunk belongs to.
 *
 * The prompt is assembled by an extension, not a pure function: the handler
 * needs an ExtensionAPI and a session context. This script runs the real
 * handler against a fake of both (the shape the prompt fixtures already use),
 * then hands the mutated prompt options to pi's own section builder, by file
 * URL because pi's exports map blocks the subpath import. What lands in the
 * file is the text the model would receive, not a re-implementation of it.
 *
 * Determinism is the point. Two captures of one build, from two different
 * working directories, must be byte-identical, or the diff mode is noise. The
 * inputs that are not code are therefore pinned here, explicitly:
 *
 *   home / agent dir / braid home   a fixed /tmp tree, cleaned per capture,
 *                                   so settings, memories and timers are empty
 *                                   and every rendered path is stable
 *   process id                      the compact instance line prints it
 *   session id, model, tool set,    fixed scenario inputs
 *   skills, project docs
 *   build root                      resolved to its real path
 *   pi toolchain                    resolved once; every build loads into it
 *
 * The clock is NOT pinned: no captured section reads it. If the prompt ever
 * grows a timestamp, the two-capture check is what should redden, not a pin
 * that would hide it. The cost is that a timestamp with a one-second
 * resolution can pass two captures taken inside the same second.
 *
 * Every pin hides a surface. A capture cannot show that a memory count or a
 * timer list changed, because the pinned home is always empty; it cannot show
 * a clock format, because no clock is rendered; and it renders the fallback
 * tool-guideline map rather than each tool's own registered promptGuidelines,
 * because the scenario supplies tool names, not registrations. The prompt
 * text itself, and every path the prompt renders, stay visible.
 *
 * Captures are serial: the pinned tree is cleared at the start of every run,
 * so two captures must not overlap on one machine.
 *
 * Usage:
 *   node scripts/prompt-capture.mjs capture --root <dir> --out <file>
 *                                           [--scenario default] [--pi <dir>]
 *   node scripts/prompt-capture.mjs diff <old> <new> [--context <n>]
 *
 * <root> is the directory holding dist/ (the package root of an installed
 * pi-braid, or packages/core in a checkout). Capture exits 0 on success.
 * Diff exits 0 when the files are identical, 1 when they differ, 2 on error.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Fixed root for every pinned input. A random temp dir would leak into the
 *  rendered memory and docs paths and break byte equality between runs. */
const CAPTURE_BASE = "/tmp/pi-braid-prompt-capture";
const CAPTURE_HOME = join(CAPTURE_BASE, "home");
const CAPTURE_AGENT_DIR = join(CAPTURE_HOME, ".pi", "agent");
const CAPTURE_BRAID_HOME = join(CAPTURE_AGENT_DIR, "braid");
const CAPTURE_WORKSPACE = join(CAPTURE_BASE, "workspace");
const PINNED_PID = 4242;
const PINNED_SESSION_ID = "capture-session";
const CAPTURE_FORMAT = 1;
const HEADER_MARKER = "---";

/** A scenario is a named, fixed set of inputs the handler would otherwise
 *  read from the live session. Only code differences should move the capture. */
const SCENARIOS = {
  default: {
    cwd: "packages/app",
    docs: [
      {
        path: "AGENTS.md",
        content:
          "# Workspace contract\n\nThe capture writes pointer lines only.\n",
      },
      {
        path: "packages/app/CLAUDE.md",
        content: "# App contract\n\nThe capture writes pointer lines only.\n",
      },
    ],
    tools: [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "list_skills",
      "context_navigate",
      "context_compress",
      "memory",
      "scratchpad",
      "think",
      "verify",
      "timer",
      "system_info",
      "workspace_snapshot",
    ],
    skills: [
      {
        name: "code-search",
        description: "Search code and choose between the search tools.",
        filePath: join(CAPTURE_WORKSPACE, "skills", "code-search", "SKILL.md"),
        baseDir: join(CAPTURE_WORKSPACE, "skills"),
      },
      {
        name: "tone-quality",
        description: "Write text that carries signal.",
        filePath: join(CAPTURE_WORKSPACE, "skills", "tone-quality", "SKILL.md"),
        baseDir: join(CAPTURE_WORKSPACE, "skills"),
      },
    ],
    model: { provider: "capture", id: "fixed-model", contextWindow: 200_000 },
    usage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
    appendSystemPrompt: "Embedder appendix kept verbatim.",
    sections: { "host-extra": "Embedder section kept verbatim." },
  },
};

// ── environment pins ────────────────────────────────────────────────────────

/**
 * Pin everything the handler reads outside the build, before any build or pi
 * module loads: braid captures os.homedir() at import time, so setting these
 * after the import would pin only half the reads.
 */
function pinEnvironment() {
  rmSync(CAPTURE_BASE, { recursive: true, force: true });
  mkdirSync(CAPTURE_AGENT_DIR, { recursive: true });
  mkdirSync(CAPTURE_BRAID_HOME, { recursive: true });

  process.env.HOME = CAPTURE_HOME;
  process.env.PI_CODING_AGENT_DIR = CAPTURE_AGENT_DIR;
  process.env.BRAID_HOME = CAPTURE_BRAID_HOME;
  // Ambient values would otherwise reach settings, session lookup or the
  // module loader in a way the capture does not name.
  delete process.env.PI_SESSION_FILE;
  delete process.env.BRAID_MODULES;

  // process.pid is a configurable own property on Node's process object.
  Object.defineProperty(process, "pid", {
    value: PINNED_PID,
    configurable: true,
  });
}

/** Create the scenario's fixed docs under the pinned workspace. */
function prepareScenario(scenario) {
  const cwd = join(CAPTURE_WORKSPACE, scenario.cwd);
  for (const doc of scenario.docs) {
    const file = join(CAPTURE_WORKSPACE, doc.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, doc.content);
  }
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

// ── pi toolchain ────────────────────────────────────────────────────────────

/** Package root of a resolved file: the nearest package.json with a name. */
function packageRootOf(file) {
  let dir = dirname(file);
  for (let i = 0; i < 8; i++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof pkg.name === "string" && pkg.name) return { dir, pkg };
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The `node_modules` directory a resolved package entry came from. */
function modulesRootOf(file) {
  const parts = realpathSync(file).split("/");
  const index = parts.lastIndexOf("node_modules");
  return index < 0 ? null : parts.slice(0, index + 1).join("/") || "/";
}

/**
 * Resolve an `exports` target without Node's resolver. The package is ESM-only
 * (`exports` carries `import`, not `require`), so `require.resolve` refuses it;
 * the toolchain needs the file path, not a loader condition.
 */
function exportTarget(pkgRoot, subpath) {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const field = pkg.exports;
  let target;
  if (field && typeof field === "object") {
    let entry = field[subpath];
    if (entry === undefined) {
      for (const key of Object.keys(field)) {
        const starAt = key.indexOf("*");
        if (starAt < 0) continue;
        const prefix = key.slice(0, starAt);
        const suffix = key.slice(starAt + 1);
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
        const star = subpath.slice(
          prefix.length,
          subpath.length - suffix.length,
        );
        const pattern = field[key];
        const resolved =
          typeof pattern === "string"
            ? pattern
            : (pattern?.import ?? pattern?.default ?? pattern?.node);
        if (typeof resolved === "string") entry = resolved.replace("*", star);
        break;
      }
    }
    if (typeof entry === "string") target = entry;
    else if (entry && typeof entry === "object") {
      target = entry.import ?? entry.default ?? entry.node ?? entry.require;
    }
  } else if (subpath === ".") {
    target = typeof field === "string" ? field : (pkg.main ?? "index.js");
  }
  return typeof target === "string" ? join(pkgRoot, target) : null;
}

/** Resolve one bare specifier inside a toolchain's node_modules. */
function toolchainSpecifier(modulesRoot, specifier) {
  const match = /^((?:@[^/]+\/)?[^/]+)(?:\/(.+))?$/.exec(specifier);
  if (!match) return null;
  const pkgRoot = join(modulesRoot, ...match[1].split("/"));
  if (!existsSync(join(pkgRoot, "package.json"))) return null;
  return exportTarget(pkgRoot, match[2] ? `./${match[2]}` : ".");
}

/**
 * Resolve the pi toolchain once and make every build load into it.
 *
 * A build installed without its own node_modules cannot resolve pi at all: the
 * bare import is resolved from the build file, and nothing above the installed
 * package carries pi. The resolve hook answers every bare specifier from the
 * pinned toolchain instead, so both builds run against one dependency set and a
 * diff shows the braid delta rather than a pi or peer-dependency delta.
 */
async function loadToolchain(piArg) {
  let piRoot;
  if (piArg) {
    piRoot = realpathSync(resolve(piArg));
    const manifest = join(piRoot, "package.json");
    if (!existsSync(manifest))
      throw new Error(`${piRoot} is not a pi package root`);
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.name !== "@earendil-works/pi-coding-agent") {
      throw new Error(`${piRoot} is not the pi-coding-agent package root`);
    }
  } else {
    const entryPath = fileURLToPath(
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const located = packageRootOf(entryPath);
    if (!located || located.pkg.name !== "@earendil-works/pi-coding-agent") {
      throw new Error(
        `could not locate the pi-coding-agent package root for ${entryPath}`,
      );
    }
    piRoot = located.dir;
  }

  const entry = exportTarget(piRoot, ".");
  if (!entry)
    throw new Error(`no import target in ${join(piRoot, "package.json")}`);
  const modulesRoot = modulesRootOf(entry);
  if (!modulesRoot) throw new Error(`no node_modules directory above ${entry}`);
  const piUrl = pathToFileURL(entry).href;

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        // A package installed without its peers cannot resolve them from its
        // own path. Every bare specifier comes from the pinned toolchain, so
        // both builds run against one dependency set; a relative import is
        // the build's own code and stays untouched.
        const bare =
          !specifier.startsWith(".") &&
          !specifier.startsWith("/") &&
          !specifier.startsWith("node:") &&
          !builtinModules.includes(specifier);
        if (bare) {
          const file = toolchainSpecifier(modulesRoot, specifier);
          if (file)
            return { url: pathToFileURL(file).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
  }

  const pi = await import(piUrl);
  const builderUrl = new URL("core/system-prompt.js", new URL("./", piUrl))
    .href;
  const builder = await import(builderUrl);
  return { pi, builder, root: piRoot };
}

/** Load the prompt-builder extension from one build root. */
async function loadBuild(root) {
  const entry = join(
    root,
    "dist",
    "extensions",
    "core",
    "prompt-builder",
    "index.js",
  );
  if (!existsSync(entry)) {
    throw new Error(
      `no built prompt-builder at ${entry} (run the package build first)`,
    );
  }
  const mod = await import(pathToFileURL(entry).href);
  if (typeof mod.default !== "function") {
    throw new Error(`${entry} does not export a default extension factory`);
  }
  return mod.default;
}

// ── the fake runtime ────────────────────────────────────────────────────────

/**
 * Minimal ExtensionAPI double: registers are recorded, tools are the scenario's,
 * and every delivery is captured rather than sent. A missing method throws at
 * the call site instead of being silently faked, so a build that starts using
 * a new API fails the capture loudly.
 */
function fakePi(scenario) {
  const handlers = new Map();
  const sent = [];
  return {
    handlers,
    sent,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool() {},
    getAllTools: () =>
      scenario.tools.map((name) => ({
        name,
        description: `The ${name} tool.`,
      })),
    getActiveTools: () => scenario.tools.slice(),
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
    appendEntry() {},
  };
}

/** Minimal ExtensionContext double with one stable session key. */
function fakeCtx(cwd, scenario, sessionFile) {
  return {
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => PINNED_SESSION_ID,
      getBranch: () => [],
      getLabel: () => undefined,
    },
    getContextUsage: () => ({ ...scenario.usage }),
    model: { ...scenario.model },
  };
}

// ── capture ─────────────────────────────────────────────────────────────────

/** The prompt options pi would hand the handler for this scenario. */
function promptOptions(scenario, cwd) {
  return {
    cwd,
    selectedTools: scenario.tools.slice(),
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: scenario.appendSystemPrompt,
    sections: { ...scenario.sections },
    contextFiles: [],
    skills: scenario.skills.map((skill) => ({ ...skill })),
  };
}

/** Read the version of the pi-braid package the build belongs to. */
function readBraidPackage(root) {
  let dir = root;
  for (let i = 0; i < 8; i++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name === "pi-braid") {
          return {
            version: typeof pkg.version === "string" ? pkg.version : "unknown",
            root: dir,
          };
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { version: "unknown", root: "" };
}

/** 1-based line number of a character offset. */
function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Where each rendered section sits in the assembled body. The builder returns
 * the same strings it joins, so locating them in order is exact; a miss means
 * the builder's rendering changed under the capture, and that is an error, not
 * an "unknown region".
 */
function sectionRanges(assembled, sections) {
  const ranges = [];
  let cursor = 0;
  for (const [name, text] of Object.entries(sections)) {
    if (!text) continue;
    const start = assembled.indexOf(text, cursor);
    if (start < 0)
      throw new Error(
        `rendered section ${name} was not found in the assembled prompt`,
      );
    ranges.push({
      name,
      start: lineOf(assembled, start),
      end: lineOf(assembled, start + text.length - 1),
    });
    cursor = start + text.length;
  }
  return ranges;
}

async function capture(options) {
  const scenario = SCENARIOS[options.scenario];
  if (!scenario) {
    throw new Error(
      `unknown scenario "${options.scenario}" (known: ${Object.keys(SCENARIOS).join(", ")})`,
    );
  }

  pinEnvironment();
  const cwd = prepareScenario(scenario);
  const toolchain = await loadToolchain(options.pi);
  const build = await loadBuild(options.root);
  const braid = readBraidPackage(options.root);

  const pi = fakePi(scenario);
  build(pi);
  const handler = pi.handlers.get("before_agent_start")?.at(-1);
  if (typeof handler !== "function") {
    throw new Error("the build registered no before_agent_start handler");
  }

  const prompt = promptOptions(scenario, cwd);
  const event = { systemPromptOptions: prompt };
  await handler(
    event,
    fakeCtx(cwd, scenario, join(CAPTURE_WORKSPACE, "session.jsonl")),
  );

  // pi's builder is the last step: braid's handler publishes options, and this
  // is the text the provider would receive after pi renders them.
  const assembled = toolchain.builder.buildSystemPrompt(prompt);
  const sections = toolchain.builder.buildSystemPromptSections(prompt);

  const header = {
    format: CAPTURE_FORMAT,
    scenario: options.scenario,
    root: braid.root || options.root,
    braid: braid.version,
    pi:
      typeof toolchain.pi.VERSION === "string"
        ? toolchain.pi.VERSION
        : "unknown",
    piRoot: toolchain.root,
    bytes: Buffer.byteLength(assembled, "utf8"),
    lines: assembled.split("\n").length,
    sections: sectionRanges(assembled, sections),
    pins: {
      home: CAPTURE_HOME,
      braidHome: CAPTURE_BRAID_HOME,
      cwd,
      pid: PINNED_PID,
      sessionId: PINNED_SESSION_ID,
      model: `${scenario.model.provider}/${scenario.model.id}`,
      tools: scenario.tools.length,
      skills: scenario.skills.length,
      clock: "unpinned; no captured section reads it",
    },
  };
  const headerText = JSON.stringify(header, null, 2);
  // Pretty JSON keeps a two-build diff to the fields that moved instead of one
  // 1 KB header line. The marker is the first line that is exactly "---";
  // JSON escaping keeps that sequence out of the header itself.
  const bodyStart = headerText.split("\n").length + 2;
  header.bodyStart = bodyStart;
  const framed = `${JSON.stringify(header, null, 2)}\n${HEADER_MARKER}\n${assembled}\n`;
  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  writeFileSync(options.out, framed);
  return header;
}

// ── diff ────────────────────────────────────────────────────────────────────

/** Split a capture file into its header record and body. Tolerant: a file
 *  without a capture header still diffs, with regions reported as unknown. */
function readCapture(file) {
  const text = readFileSync(file, "utf8");
  const marker = `\n${HEADER_MARKER}\n`;
  const end = text.indexOf(marker);
  if (end < 0) return { meta: null, body: text };
  let meta = null;
  try {
    const parsed = JSON.parse(text.slice(0, end));
    if (parsed && parsed.format === CAPTURE_FORMAT) meta = parsed;
  } catch {
    meta = null;
  }
  return { meta, body: text.slice(end + marker.length) };
}

/** Regions a hunk touches. Body coordinates are 1-based; a hunk that reaches
 *  into the JSON header reports "header". */
function regionsOf(meta, start, count) {
  if (
    !meta ||
    typeof meta.bodyStart !== "number" ||
    !Array.isArray(meta.sections)
  )
    return [];
  const first = start - meta.bodyStart + 1;
  const last = first + Math.max(count, 1) - 1;
  const names = [];
  if (first < 1) names.push("header");
  for (const section of meta.sections) {
    if (typeof section.start !== "number" || typeof section.end !== "number")
      continue;
    if (last >= section.start && first <= section.end)
      names.push(String(section.name));
  }
  return names;
}

function regionLabel(names) {
  if (names.length === 0) return "unknown";
  return names.join(", ");
}

function describe(file) {
  try {
    const { meta } = readCapture(file);
    if (!meta) return file;
    return `${file} [scenario=${meta.scenario} braid=${meta.braid} root=${meta.root}]`;
  } catch {
    return file;
  }
}

function diff(args) {
  const oldPath = args[0];
  const newPath = args[1];
  const context = args[2] ?? 3;

  const result = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--no-color",
      "--no-ext-diff",
      "--text",
      `--unified=${context}`,
      "--",
      oldPath,
      newPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status === 0) {
    console.log(`identical: ${describe(oldPath)} == ${describe(newPath)}`);
    console.log(`no hunks`);
    return 0;
  }
  if (result.status !== 1) {
    throw new Error(
      `git diff exited ${result.status}: ${result.stderr.trim()}`,
    );
  }

  const lines = result.stdout.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk < 0) {
    throw new Error("git reported a difference but printed no hunks");
  }

  const oldMeta = readCapture(oldPath).meta;
  const newMeta = readCapture(newPath).meta;
  console.log(`--- ${describe(oldPath)}`);
  console.log(`+++ ${describe(newPath)}`);

  let hunks = 0;
  for (let i = firstHunk; i < lines.length; i++) {
    const line = lines[i];
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      hunks++;
      const oldStart = Number(header[1]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      // A pure deletion has no new-side lines; its region is the old side's.
      const names =
        newCount === 0
          ? regionsOf(oldMeta, oldStart, oldCount)
          : regionsOf(newMeta, newStart, newCount);
      console.log(`${line} region: ${regionLabel(names)}`);
      continue;
    }
    console.log(line);
  }
  console.log(`hunks: ${hunks}`);
  return 1;
}

// ── cli ─────────────────────────────────────────────────────────────────────

const USAGE = `prompt-capture — render or diff an assembled pi-braid system prompt

  node scripts/prompt-capture.mjs capture --root <dir> --out <file>
                                          [--scenario default] [--pi <dir>]
  node scripts/prompt-capture.mjs diff <old> <new> [--context <n>]

capture  --root   directory holding dist/ (installed package or packages/core)
         --out    capture file to write
         --scenario  fixed input set (default: default)
         --pi     pi package root to render through (default: this repo's)
diff     exits 0 identical, 1 different, 2 error; each hunk names its region.`;

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

function parseCaptureArgs(args) {
  const parsed = { root: null, out: null, scenario: "default", pi: null };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--root") parsed.root = takeValue(args, i++, flag);
    else if (flag === "--out") parsed.out = takeValue(args, i++, flag);
    else if (flag === "--scenario")
      parsed.scenario = takeValue(args, i++, flag);
    else if (flag === "--pi") parsed.pi = takeValue(args, i++, flag);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!parsed.root) throw new Error("capture needs --root");
  if (!parsed.out) throw new Error("capture needs --out");
  parsed.root = realpathSync(resolve(parsed.root));
  return parsed;
}

function parseDiffArgs(args) {
  const files = [];
  let context = 3;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--context") context = Number(takeValue(args, i++, flag));
    else if (flag.startsWith("--"))
      throw new Error(`unknown argument: ${flag}`);
    else files.push(flag);
  }
  if (files.length !== 2)
    throw new Error("diff needs exactly two capture files");
  if (!Number.isInteger(context) || context < 0)
    throw new Error("--context must be a whole number");
  for (const file of files) {
    if (!existsSync(file) || !statSync(file).isFile())
      throw new Error(`no such file: ${file}`);
  }
  return [files[0], files[1], context];
}

async function main(argv) {
  const mode = argv[0];
  if (!mode || mode === "--help" || mode === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (mode === "capture") {
    const options = parseCaptureArgs(argv.slice(1));
    const header = await capture(options);
    console.error(
      `captured ${header.scenario} from ${header.root} (braid ${header.braid}, pi ${header.pi})`,
    );
    console.error(
      `wrote ${options.out} (${header.bytes} bytes, ${header.lines} lines)`,
    );
    return 0;
  }
  if (mode === "diff") {
    return diff(parseDiffArgs(argv.slice(1)));
  }
  throw new Error(`unknown mode: ${mode}`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      `prompt-capture: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  });
