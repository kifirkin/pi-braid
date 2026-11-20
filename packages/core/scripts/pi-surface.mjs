/**
 * pi-surface.mjs - what braid takes from pi, read from the installed declarations.
 *
 * Braid reaches into pi far beyond the extension API: the registration methods
 * every extension module calls, the event payloads its handlers read field by
 * field, the session and model-registry shapes it walks, the settings class it
 * opens, the frontmatter parser its skills loader shares, the truncation caps
 * its own tools budget against, the model and message types it passes around.
 * `check-extension-api.mjs` pins only the `ctx.<member>` names, and nothing
 * pinned the rest: a pi release could rename a field braid reads and every gate
 * in the repository stayed green.
 *
 * This module holds the list of surfaces braid uses and the extractor that
 * turns an installed pi tree into a comparable record of them. The record is
 * `pi-surface.json` beside this package's manifest, written and compared by
 * `check-pi-surface.mjs`.
 *
 * A symbol is recorded as its declaration *head* - `interface ExtensionAPI {` -
 * plus, for a declaration with a body, one entry per member holding the
 * member's normalized signature lines. Normalization is comments removed and
 * whitespace collapsed to one space; generic parameters, optional markers and
 * re-export paths are kept as written. Splitting members into their own entries
 * is what makes an upgrade diff read as the member that moved rather than one
 * eight-kilobyte line that changed. A body inside a generic argument
 * (`Foo<{ a: string }>`) is split like any other object type, because the
 * extractor does not track angle brackets: `<` and `>` cannot be told from
 * comparison operators without a parser, and a wrong brace depth would be worse
 * than a coarse member.
 *
 * Which file a symbol lives in is declared, never guessed. A surface row names
 * its package and its declaration file; a symbol the row lists but that file
 * does not declare is an error at record time that names where the symbol
 * actually is, so a row cannot quietly vouch for a file it does not describe.
 * A symbol need not be exported: `ParsedFrontmatter` is reachable only through
 * `parseFrontmatter`'s return type, and braid reads its fields.
 *
 * Limits, stated on purpose. This reads `.d.ts` only. A release that changes a
 * constant's value, an event's runtime payload, a handler's behavior or a JSON
 * schema without changing a declaration is invisible here. So is everything pi
 * does not declare at all, and any surface no row names: the record says what
 * somebody declared braid depends on, and a new call site is where a row gets
 * added.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = resolve(HERE, "..");

/** The manifest this module's extractor feeds, beside this package's manifest. */
export const MANIFEST_PATH = resolve(CORE_ROOT, "pi-surface.json");

/** The package whose declarations every other row is oriented around. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Manifest shape version. A reader that does not know the number refuses. */
export const MANIFEST_VERSION = 1;

/**
 * The surfaces braid depends on, one row per declaration file.
 *
 * `why` is the dependency, not a label: it names the braid call that would
 * break. `symbols` holds only names braid imports, or members braid calls on an
 * object pi hands it (those say so in `why`).
 */
export const SURFACES = [
  {
    name: "extension-api",
    package: PI_PACKAGE,
    file: "dist/core/extensions/types.d.ts",
    why: "every extension module is a function of these: pi.on, the register* calls, pi.exec, pi.getSettings, and the context members handlers read (ui, modelRegistry, sessionManager, compact, getContextUsage).",
    symbols: [
      "ExtensionAPI",
      "ExtensionContext",
      "ExtensionCommandContext",
      "ExtensionUIContext",
      "ExtensionToolContext",
      "ToolDefinition",
      "ToolInfo",
      "CompactOptions",
      "ContextUsage",
    ],
  },  {
    name: "extension-events",
    package: PI_PACKAGE,
    file: "dist/core/extensions/types.d.ts",
    why: "one symbol per event braid registers a handler on: each carries the literal pi dispatches on and the payload fields the handler reads (event.command, event.messages, event.result, event.toolName).",
    symbols: [
      "SessionStartEvent",
      "SessionShutdownEvent",
      "SessionBeforeCompactEvent",
      "SessionCompactEvent",
      "SessionBeforeTreeEvent",
      "TurnStartEvent",
      "TurnEndEvent",
      "AgentStartEvent",
      "AgentEndEvent",
      "AgentSettledEvent",
      "ModelSelectEvent",
      "MessageUpdateEvent",
      "MessageEndEvent",
      "ToolCallEvent",
      "ToolResultEvent",
      "ToolExecutionStartEvent",
      "ToolExecutionEndEvent",
      "InputEvent",
      "ResourcesDiscoverEvent",
      "BeforeAgentStartEvent",
      "BeforeProviderRequestEvent",
      "ContextEvent",
    ],
  },
  {
    name: "provider-models",
    package: PI_PACKAGE,
    file: "dist/core/extensions/types.d.ts",
    why: "the Venice catalog is typed against pi's provider model union, and the fields braid fills (contextWindow, maxTokens, thinkingLevelMap, compat) are that union's.",
    symbols: ["ProviderModelConfig"],
  },
  {
    name: "session",
    package: PI_PACKAGE,
    file: "dist/core/session-manager.d.ts",
    why: "ctx.sessionManager is the readonly view, and braid reads the entries it returns: getBranch, getEntries, getSessionId, getSessionFile, appendMessage, appendCustomEntry.",
    symbols: ["ReadonlySessionManager", "SessionEntry"],
  },
  {
    name: "settings",
    package: PI_PACKAGE,
    file: "dist/core/settings-manager.d.ts",
    why: "the turn-end hygiene handler asks pi whether compaction is on, through SettingsManager.create(cwd, getAgentDir()).getCompactionEnabled().",
    symbols: ["SettingsManager"],
  },
  {
    name: "model-registry",
    package: PI_PACKAGE,
    file: "dist/core/model-registry.d.ts",
    why: "ctx.modelRegistry drives model choice and the judge: getAvailable, getAll, find, getApiKeyForProvider.",
    symbols: ["ModelRegistry"],
  },
  {
    name: "model-runtime",
    package: PI_PACKAGE,
    file: "dist/core/model-runtime.d.ts",
    why: "the polyfill reads the model registry's runtime to drive its own picker: the transport a selected model will stream through, and the write path that persists the choice.",
    symbols: ["ModelRuntime"],
  },
  {
    name: "system-prompt",
    package: PI_PACKAGE,
    file: "dist/core/system-prompt.d.ts",
    why: "pi hands the prompt builder a normalized, mutable options object and reads it back; braid writes contextFiles, skills and its own sections into it.",
    symbols: ["NormalizedBuildSystemPromptOptions"],
  },
  {
    name: "truncation",
    package: PI_PACKAGE,
    file: "dist/core/tools/truncate.d.ts",
    why: "the run tool's byte budget and the browser tool's page capture are held to pi's truncation constants and its head truncator.",
    symbols: ["DEFAULT_MAX_BYTES", "truncateHead"],
  },
  {
    name: "bash-tool",
    package: PI_PACKAGE,
    file: "dist/core/tools/bash.d.ts",
    why: "the bash-cwd extension wraps pi's bash tool definition and reads the details type it returns.",
    symbols: ["createBashToolDefinition", "BashToolDetails"],
  },
  {
    name: "host-config",
    package: PI_PACKAGE,
    file: "dist/config.d.ts",
    why: "braid resolves its state next to pi's agent directory and records the pi version a session runs under.",
    symbols: ["getAgentDir", "VERSION"],
  },
  {
    name: "frontmatter",
    package: PI_PACKAGE,
    file: "dist/utils/frontmatter.d.ts",
    why: "the skills loader parses SKILL.md with pi's parser and reads the frontmatter and body it returns; braid owns the triggers, not the format.",
    symbols: ["parseFrontmatter", "ParsedFrontmatter"],
  },
  {
    name: "image-resize",
    package: PI_PACKAGE,
    file: "dist/utils/image-resize.d.ts",
    why: "the capture cap and offload recovery resize oversized images with pi's resizer and reuse its dimension note.",
    symbols: ["resizeImage", "formatDimensionNote"],
  },
  {
    name: "resize-result",
    package: PI_PACKAGE,
    file: "dist/utils/image-resize-core.d.ts",
    why: "the resize result is read field by field (data, mimeType, width, height, originalWidth, originalHeight) to decide whether the coordinate mapping moved.",
    symbols: ["ResizedImage"],
  },
  {
    name: "resource-loader",
    package: PI_PACKAGE,
    file: "dist/core/resource-loader.d.ts",
    why: "the prompt builder's project-docs section loads AGENTS.md files through pi's loader rather than reimplementing its walk.",
    symbols: ["loadProjectContextFiles"],
  },
  {
    name: "settings-ui",
    package: PI_PACKAGE,
    file: "dist/modes/interactive/theme/theme.d.ts",
    why: "the /module settings list and the browser tool's selector run pi-tui's lists, which need pi's own theme callbacks to render.",
    symbols: ["getSettingsListTheme", "getSelectListTheme"],
  },
  {
    name: "model-selector",
    package: PI_PACKAGE,
    file: "dist/modes/interactive/components/model-selector.d.ts",
    why: "the polyfill's model picker mounts pi's own selector component inside a custom UI slot.",
    symbols: ["ModelSelectorComponent"],
  },
  {
    name: "ai-models",
    package: "@earendil-works/pi-ai",
    file: "dist/models.d.ts",
    why: "braid builds its provider registry on pi-ai's constructors: createModels at startup, createProvider for the Venice route, Provider as the registered shape.",
    symbols: ["Provider", "ModelsSimpleStreamOptions", "createModels", "createProvider"],
  },
  {
    name: "ai-types",
    package: "@earendil-works/pi-ai",
    file: "dist/types.d.ts",
    why: "the model and message shapes braid reads while resolving routes and pricing (model.provider, model.contextWindow, model.maxTokens) and while filtering content parts.",
    symbols: [
      "Model",
      "Api",
      "Context",
      "Message",
      "AssistantMessage",
      "Usage",
      "StopReason",
      "ImageContent",
      "TextContent",
    ],
  },
  {
    name: "ai-thinking",
    package: "@earendil-works/pi-ai",
    file: "dist/providers/model-schema.d.ts",
    why: "the auxiliary-call options carry a ModelThinkingLevel and pi's ThinkingLevel crosses into the registry's stream options, so the vocabulary is pi-ai's.",
    symbols: ["ThinkingLevel", "ModelThinkingLevel"],
  },
  {
    name: "ai-schema-enum",
    package: "@earendil-works/pi-ai",
    file: "dist/utils/string-enum.d.ts",
    why: "tool schemas register their enum parameters through StringEnum, so the JSON schema pi receives is pi-ai's.",
    symbols: ["StringEnum"],
  },
  {
    name: "ai-compat",
    package: "@earendil-works/pi-ai",
    file: "dist/compat.d.ts",
    why: "auxiliary completions go through pi-ai's compat entry point instead of a client of braid's own.",
    symbols: ["completeSimple"],
  },
  {
    name: "ai-openai-api",
    package: "@earendil-works/pi-ai",
    file: "dist/api/openai-completions.lazy.d.ts",
    why: "the Venice provider is registered with pi-ai's own OpenAI-completions transport, so the api it names is pi-ai's.",
    symbols: ["openAICompletionsApi"],
  },
  {
    name: "agent-core",
    package: "@earendil-works/pi-agent-core",
    file: "dist/types.d.ts",
    why: "every tool braid defines returns AgentToolResult, streams partials through AgentToolUpdateCallback, and the context manager prunes AgentMessage arrays.",
    symbols: ["AgentToolResult", "AgentToolUpdateCallback", "AgentMessage"],
  },
  {
    name: "tui-autocomplete",
    package: "@earendil-works/pi-tui",
    file: "dist/autocomplete.d.ts",
    why: "/module autocompletion returns pi-tui's AutocompleteItem rows to pi's own completion renderer.",
    symbols: ["AutocompleteItem"],
  },
  {
    name: "tui-select",
    package: "@earendil-works/pi-tui",
    file: "dist/components/select-list.d.ts",
    why: "the browser tool mounts pi-tui's SelectList and answers with its SelectItem rows.",
    symbols: ["SelectList", "SelectItem"],
  },
  {
    name: "tui-settings",
    package: "@earendil-works/pi-tui",
    file: "dist/components/settings-list.d.ts",
    why: "the /module list is a pi-tui SettingsList fed SettingItem rows and pi's own SettingsListTheme.",
    symbols: ["SettingsList", "SettingItem", "SettingsListTheme"],
  },
  {
    name: "tui-text",
    package: "@earendil-works/pi-tui",
    file: "dist/components/text.d.ts",
    why: "the browser tool renders its page listings as pi-tui Text nodes so the host's theme and wrapping apply to them.",
    symbols: ["Text"],
  },
  {
    name: "tui-container",
    package: "@earendil-works/pi-tui",
    file: "dist/tui.d.ts",
    why: "the module command and the browser tool compose their panes as pi-tui Containers.",
    symbols: ["Container"],
  },
];

/** Drop comments, keep every offset: a blanked comment still occupies its space,
 *  so a message computed from an offset names the line a reader sees. */
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const stop = close < 0 ? text.length : close + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (ch === "/" && next === "/") {
      let stop = text.indexOf("\n", i);
      if (stop < 0) stop = text.length;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, text.length);
      out += text.slice(i, stop);
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** One signature line: comments gone, whitespace runs collapsed, ends trimmed. */
function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** Character that follows `from` once whitespace is skipped, or "". */
function nextSignificant(text, from) {
  for (let i = from; i < text.length; i++) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return "";
}

/**
 * Index just past the declaration that starts at `start`.
 *
 * A declaration ends at the first `;` outside any bracket, or at a `}` that
 * closes a body back to depth zero - unless what follows continues the type
 * (`|`, `&`, `=`, `[`, `,`, `)`, `:`, `>`), which is how a union of object
 * types stays one declaration.
 */
function endOfDeclaration(text, start) {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth--;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth > 0) continue;
      const next = nextSignificant(text, i + 1);
      if (next && "|&=,[):>".includes(next)) continue;
      let end = i + 1;
      while (end < text.length && /\s/.test(text[end])) end++;
      if (text[end] === ";") end++;
      return end;
    }
    if (ch === ";" && depth === 0) return i + 1;
  }
  return text.length;
}

/** Split at a separator outside every bracket and string. */
export function splitTopLevel(text, separators) {
  const chunks = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      continue;
    }
    if (depth === 0 && separators.includes(ch)) {
      chunks.push(text.slice(start, i));
      start = i + 1;
    }
  }
  chunks.push(text.slice(start));
  return chunks;
}

/** Index of the first `{` outside parentheses, brackets and strings, or -1. */
function firstBodyBrace(text) {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth--;
      continue;
    }
    if (ch === "{" && depth === 0) return i;
  }
  return -1;
}

/** Index of the `}` matching the `{` at `open`, or -1 when unbalanced. */
function matchingBrace(text, open) {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

const MEMBER_MODIFIERS =
  /^(?:(?:readonly|static|public|private|protected|abstract|declare|override|accessor)\s+)+/;

/** The name a member entry is keyed by, or null when the chunk is not one. */
function memberName(text) {
  const body = text.replace(MEMBER_MODIFIERS, "");
  const quoted = body.match(/^(['"])([^'"]+)\1\s*\??\s*:/);
  if (quoted) return `${quoted[1]}${quoted[2]}${quoted[1]}`;
  const index = body.match(/^\[([^\]]+)\]\s*\??\s*:/);
  if (index) return `[${normalize(index[1])}]`;
  if (/^new\s*[<(]/.test(body)) return "(construct)";
  if (/^[<(]/.test(body)) return "(call)";
  const named = body.match(/^([A-Za-z_$][\w$]*)\s*(?:[?(<:;]|=(?!=)|$)/);
  return named ? named[1] : null;
}

/** Name -> signature lines, overloads kept in source order. */
function parseMembers(body, kind) {
  const separators = kind === "enum" ? "," : ";";
  let chunks = splitTopLevel(body, separators);
  if (kind !== "enum" && chunks.length === 1) chunks = splitTopLevel(body, ",");
  const members = new Map();
  let unnamed = 0;
  for (const chunk of chunks) {
    const text = normalize(chunk);
    if (!text) continue;
    const name = memberName(text) ?? `(unnamed ${++unnamed})`;
    const lines = members.get(name) ?? [];
    lines.push(text);
    members.set(name, lines);
  }
  return members;
}

/** The record of one declaration: kind, head, members. */
function describeDeclaration(declaration, kind) {
  const open = firstBodyBrace(declaration);
  const close = open < 0 ? -1 : matchingBrace(declaration, open);
  if (open < 0 || close < 0) {
    return { kind, signature: normalize(declaration).replace(/;$/, "") };
  }
  const members = parseMembers(declaration.slice(open + 1, close), kind);
  const record = { kind, signature: normalize(declaration.slice(0, open + 1)) };
  if (members.size) record.members = Object.fromEntries(members);
  return record;
}

const DECLARATION =
  /^(?:export\s+)?(?:(?:declare|abstract|const)\s+)*(interface|type|class|namespace|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Every top-level declaration in one `.d.ts`, keyed by name.
 *
 * `export` is optional so a row can name a type reachable only through an
 * exported signature: `parseFrontmatter` returns `ParsedFrontmatter<T>`, the
 * field is spelled in that alias, and braid reads it. Only declarations a row
 * names enter the manifest, so a file's private helpers are not swept in.
 */
function declarationsIn(raw) {
  const text = stripComments(raw);
  const declared = new Map();
  DECLARATION.lastIndex = 0;
  let match;
  while ((match = DECLARATION.exec(text)) !== null) {
    const name = match[2];
    if (declared.has(name)) continue;
    const end = endOfDeclaration(text, match.index);
    declared.set(name, describeDeclaration(text.slice(match.index, end), match[1]));
  }
  return declared;
}

const fileCache = new Map();

/** `declarationsIn` for a path, read once per run. */
function declarationsFromFile(file) {
  const cached = fileCache.get(file);
  if (cached) return cached;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const failure = new Error(`cannot read ${file}: ${err.message}`);
    failure.code = err.code;
    throw failure;
  }
  const declared = declarationsIn(raw);
  fileCache.set(file, declared);
  return declared;
}

/** Every `.d.ts` under `<root>/dist`, for the message that says where a symbol
 *  actually lives. Walked only when a row is wrong, so a green run never pays
 *  for it. */
function declarationFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".d.ts")) files.push(path);
    }
  };
  walk(join(root, "dist"));
  return files;
}

/** Where a name is declared across a package, for an error message. */
function locateElsewhere(root, name) {
  const hits = [];
  for (const file of declarationFiles(root)) {
    if (declarationsFromFile(file).has(name)) hits.push(relative(root, file));
  }
  return hits;
}

function packageVersion(root) {
  let raw;
  try {
    raw = readFileSync(join(root, "package.json"), "utf8");
  } catch {
    throw new Error(`no package.json at ${root}: install the workspace dependencies, or point PI_SURFACE_PI_ROOT at an installed ${PI_PACKAGE}`);
  }
  let version;
  try {
    version = JSON.parse(raw).version;
  } catch (err) {
    throw new Error(`cannot parse ${join(root, "package.json")}: ${err.message}`, { cause: err });
  }
  if (!version) throw new Error(`no version in ${join(root, "package.json")}`);
  return version;
}

/**
 * The installed pi tree this run reads.
 *
 * `PI_SURFACE_PI_ROOT` wins, so a run can be pointed at the install a session
 * actually loads; otherwise the workspace's own `node_modules`, which is what a
 * checkout and CI both have. No path is baked in: a missing tree is an error
 * that names the path it looked at.
 */
export function resolvePiRoot(env = process.env) {
  const override = env.PI_SURFACE_PI_ROOT;
  const root = override
    ? resolve(override)
    : resolve(CORE_ROOT, "..", "..", "node_modules", ...PI_PACKAGE.split("/"));
  return { root, version: packageVersion(root) };
}

/** Package root and version for every package the rows name, resolved beside
 *  the pi root: the scoped packages install as siblings. */
export function packageRoots(piRoot) {
  const root = resolve(piRoot);
  if (basename(root) !== "pi-coding-agent") {
    throw new Error(`pi root ${root} is not a ${PI_PACKAGE} directory`);
  }
  const sibling = dirname(root);
  const roots = new Map();
  for (const name of new Set(SURFACES.map((row) => row.package))) {
    const dir = name === PI_PACKAGE ? root : join(sibling, name.slice(name.lastIndexOf("/") + 1));
    roots.set(name, { root: dir, version: packageVersion(dir) });
  }
  return roots;
}

/**
 * The live surface: one record per row, each symbol resolved from the file the
 * row names, plus the row symbols that file does not declare.
 *
 * Strict by default: a row that names a symbol its declared file does not
 * declare is an error, because a record that quietly drops a symbol would
 * compare clean forever afterwards. `lenient` returns those symbols in
 * `missing` instead, for a comparison that has to report a symbol leaving pi
 * as a difference rather than as a broken row.
 */
export function extractSurface({ piRoot, env = process.env, lenient = false } = {}) {
  const root = piRoot ?? resolvePiRoot(env).root;
  const roots = packageRoots(root);
  const packages = {};
  const surfaces = {};
  const missing = [];
  for (const row of SURFACES) {
    const pkg = roots.get(row.package);
    packages[row.package] = pkg.version;
    const file = join(pkg.root, row.file);
    let declared;
    try {
      declared = declarationsFromFile(file);
    } catch (err) {
      // A declaration file that is gone is a surface that is gone, not a broken
      // run: every symbol it carried becomes a difference, named with the file
      // that used to hold it.
      if (err.code !== "ENOENT") throw err;
      declared = new Map();
    }
    const symbols = {};
    for (const name of row.symbols) {
      const record = declared.get(name);
      if (record) {
        symbols[name] = record;
        continue;
      }
      const elsewhere = locateElsewhere(pkg.root, name);
      missing.push({ surface: row.name, symbol: name, package: row.package, file: row.file, elsewhere });
    }
    surfaces[row.name] = {
      package: row.package,
      file: row.file,
      why: row.why,
      symbols,
    };
  }
  if (missing.length && !lenient) {
    const detail = missing.map((entry) => {
      const where = entry.elsewhere.length
        ? `it is declared in ${entry.elsewhere.join(", ")}`
        : `no declaration of it exists under ${join(roots.get(entry.package).root, "dist")}`;
      return `  surface "${entry.surface}": ${entry.package} does not declare ${entry.symbol} in ${entry.file}; ${where}`;
    });
    throw new Error(`refusing to record, ${missing.length} row symbol(s) missing:\n${detail.join("\n")}`);
  }
  return { version: MANIFEST_VERSION, packages, surfaces, missing };
}

/** A recorded manifest, with the shape checks a comparison depends on. */
export function readManifest(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`no manifest at ${file}: write it with --record`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not JSON: ${err.message}`, { cause: err });
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${file} is not a manifest object`);
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(
      `${file} is manifest version ${JSON.stringify(manifest.version)}, this reader knows ${MANIFEST_VERSION}: re-record it`,
    );
  }
  if (!manifest.surfaces || typeof manifest.surfaces !== "object") {
    throw new Error(`${file} carries no surfaces object: re-record it`);
  }
  return manifest;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? "").trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** One range token, or null when the token is a form this reader does not
 *  evaluate (a workspace range, a git url, a tag). */
function matchesToken(version, token) {
  if (token === "*" || token === "x" || token === "X") return true;
  let operator = "";
  let rest = token;
  for (const candidate of ["^", "~", ">=", "<=", ">", "<", "="]) {
    if (token.startsWith(candidate)) {
      operator = candidate;
      rest = token.slice(candidate.length);
      break;
    }
  }
  const base = parseVersion(rest);
  if (!base) return null;
  const order = compareVersions(version, base);
  switch (operator) {
    case "^":
      if (order < 0) return false;
      if (base.major > 0) return version.major === base.major;
      if (base.minor > 0) return version.major === 0 && version.minor === base.minor;
      return version.major === 0 && version.minor === 0 && version.patch === base.patch;
    case "~":
      return order >= 0 && version.major === base.major && version.minor === base.minor;
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case "<":
      return order < 0;
    default:
      return order === 0;
  }
}

/** Whether `version` satisfies `range`, over the forms a dependency field uses:
 *  exact, caret, tilde, comparison, wildcard and `||` alternatives. Null means
 *  the range was not evaluated, never "no". */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  let evaluated = false;
  for (const alternative of String(range ?? "").split("||")) {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    let all = true;
    for (const token of tokens) {
      const verdict = matchesToken(parsed, token);
      if (verdict === null) return null;
      evaluated = true;
      if (!verdict) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return evaluated ? false : null;
}

/** Where each package the rows name is declared, per workspace manifest. */
export function declaredRanges(repoRoot, packageNames) {
  const manifests = [join(repoRoot, "package.json")];
  let children;
  try {
    children = readdirSync(join(repoRoot, "packages"), { withFileTypes: true });
  } catch {
    children = [];
  }
  for (const child of children) {
    if (child.isDirectory()) manifests.push(join(repoRoot, "packages", child.name, "package.json"));
  }
  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const rows = [];
  for (const file of manifests) {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    // The line a range sits on, found inside its own block: a package named in
    // both peerDependencies and devDependencies shares one range string, so a
    // file-wide search would attribute the second row to the first one's line.
    const lines = raw.split("\n");
    const located = new Map();
    let block = null;
    lines.forEach((line, index) => {
      const opens = /^ {2}"([^"]+)": \{$/.exec(line);
      if (opens) {
        block = fields.includes(opens[1]) ? opens[1] : null;
        return;
      }
      if (/^ {2}\}/.test(line)) {
        block = null;
        return;
      }
      if (!block) return;
      const entry = /^ {4}"([^"]+)": /.exec(line);
      if (entry) located.set(`${block}\u0000${entry[1]}`, index + 1);
    });
    for (const field of fields) {
      const declared = parsed[field];
      if (!declared) continue;
      for (const name of packageNames) {
        const range = declared[name];
        if (range === undefined) continue;
        rows.push({
          file: relative(repoRoot, file),
          line: located.get(`${field}\u0000${name}`) ?? null,
          field,
          name,
          range,
        });
      }
    }
  }
  return rows;
}
