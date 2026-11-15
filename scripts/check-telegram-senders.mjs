#!/usr/bin/env node
/**
 * check-telegram-senders.mjs — every path that can put a message in the owner's
 * chat, listed, with the gate each one passes.
 *
 * Why this exists: a rule enforced at one sender is a rule the next sender can
 * skip. A body the Bot API cannot parse, or a wall of prose, reaches the owner's
 * phone from ANY process holding the bot token — and a gate exists only on the
 * paths someone remembered to wire. This file is the list of those paths, kept
 * as data, so a new sender is a failing run instead of a discovery.
 *
 * Two populations, because they fail differently:
 *
 *   SENDER  can reach the Bot API with a method that writes to a chat.
 *   PROBE   names the API host or builds a bot URL, without a write in hand: a
 *           reachability check, a settings default, a fixture value.
 *
 * A probe is one edit away from being a sender, so both populations must be
 * answered by a row. Reach is established by any of:
 *
 *   1. the API host, written literally (a curl in a shell wrapper, a probe URL);
 *   2. a bot URL under construction — `/bot${token}`, `/bot$TOKEN`, `/bot<digits>:`;
 *   3. an import from a Telegram module.
 *
 * A write is a method CALLED (`sendMessage(`) or NAMED as a string
 * (`{ method: "sendMessage" }`), never a method mentioned in a sentence: pi's
 * own extension API exposes a `sendMessage` that posts nothing, and a census
 * that counted prose or that name would be noise. The third reach signal alone
 * proves nothing either, which is why a Telegram import plus a write in hand is
 * the indirect test.
 *
 * Every detected file must be answered by a ROW, and a row is a claim this
 * script re-checks rather than a comment it stores:
 *
 *   gate "wire"           defines the Bot API request       → host literal + fetch
 *   gate "gate"           is the outbound gate itself       → exports planOutbound
 *   gate "formatter"      plans through the gate            → names planOutbound or
 *                                                             createOutboundSender
 *   gate "transport"      is the chunk sender under the gate → carries sendMessageChunks
 *   gate "markup-check"   validates the body before posting → its checker runs before
 *                                                             the first post
 *   exempt "constant"     posts module constants only       → each named constant's
 *                                                             length re-measured, and the
 *                                                             longest is the row's bound
 *   exempt "callback"     answers a tap, posts no body      → answerCallbackQuery
 *                                                             present, no body writer
 *   exempt "probe"        names the host, cannot post       → no write in hand, no token
 *                                                             read, no curl write flag
 *   exempt "fixture"      test data, no code path           → the reason stands in for
 *                                                             the check
 *   exempt "self"         this script's own vocabulary       → the row must name this file
 *
 * A row that no longer holds is a finding too: the gate it names was removed, a
 * constant it measured grew past the bound it recorded, or a probe gained a
 * write. A list that only grows would let a sender keep its row while losing its
 * gate.
 *
 * Scope is stated rather than implied: the roots are printed on every run, and
 * the directories this script does not read are named at the bottom of the
 * constant block with the reason each is out of scope. `--root` replaces the
 * roots, which is how a planted sender is caught without touching the tree.
 *
 *   node scripts/check-telegram-senders.mjs
 *   node scripts/check-telegram-senders.mjs --root <dir>     # replace the roots
 *   node scripts/check-telegram-senders.mjs --repo <dir>     # tree rows resolve against
 *   node scripts/check-telegram-senders.mjs --list           # print every row
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const __dirname = dirname(SELF);

// ── Arguments ────────────────────────────────────────────────────────────────

function option(name) {
  const at = process.argv.indexOf(name);
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const repoRoot = resolve(option("--repo") ?? resolve(__dirname, ".."));
const listRows = process.argv.includes("--list");
const overrideRoots = process.argv
  .map((arg, at) => (arg === "--root" ? process.argv[at + 1] : undefined))
  .filter((value) => value !== undefined && !value.startsWith("--"));

const home = homedir();
const roots =
  overrideRoots.length > 0
    ? overrideRoots.map((path) => ({ label: "override", path: resolve(path) }))
    : [
        { label: "repository", path: repoRoot },
        { label: "skills", path: join(home, ".pi/agent/skills") },
        {
          label: "orchestrator scripts",
          path: join(home, ".pi/agent/braid/orchestrator/scripts"),
        },
      ];

// ── What is read, and what is deliberately not ───────────────────────────────

/** Files that can carry an executable send. A doc or a schema cannot post. */
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".sh",
  ".bash",
  ".py",
]);

/**
 * Directories out of scope, each with the reason it is out. `dist` is a build of
 * `src` (the build is its own staleness gate), `test` holds fixtures that inject
 * a fake transport so no request is made, and `archaeology` holds recorded
 * session text rather than code.
 */
const SKIP_DIRECTORIES = new Map([
  ["node_modules", "installed packages, not this tree's code"],
  [".git", "object store"],
  ["dist", "build output of src; the build is its own gate"],
  ["test", "fixtures: the transport is injected, nothing reaches the API"],
  ["tests", "fixtures: the transport is injected, nothing reaches the API"],
  ["__tests__", "fixtures: the transport is injected, nothing reaches the API"],
  ["archaeology", "recorded session text, not executable code"],
]);

/** A file named as a test is a fixture wherever it sits. */
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]s$/;

// ── Detection vocabulary ─────────────────────────────────────────────────────

/** The Bot API host, plain or as a regular-expression escape. */
const HOST_RE = /api\.telegram\.org|api\\\.telegram\\\.org/;

/** A URL being built for the API: the token follows `/bot`. */
const BOT_URL_RE =
  /\/bot\$\{|\/bot\$[A-Za-z_{]|\/bot\s*["']?\s*\+|\/bot[0-9]{6,}:/;

/**
 * An import or require whose path names the Bot API client or the telegram
 * package. Deliberately not `telegram` anywhere in the path: core has its own
 * `telegram-poller-liveness`, and importing that posts nothing.
 */
const TELEGRAM_IMPORT_RE =
  /(?:from\s*|require\(\s*)["'][^"']*(?:telegram-client|telegram\/|pi-braid-telegram|@pi\/telegram)["']/i;

/** Methods that write to a chat. A read method (`getUpdates`, `getFile`) does not. */
const WRITE_METHODS = [
  "sendMessageChunks",
  "sendMessage",
  "sendPhoto",
  "sendAudio",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendVoice",
  "sendVideoNote",
  "sendMediaGroup",
  "sendLocation",
  "sendVenue",
  "sendContact",
  "sendPoll",
  "sendDice",
  "sendChatAction",
  "sendInvoice",
  "copyMessage",
  "forwardMessage",
  "editMessageText",
  "editMessageCaption",
  "editMessageMedia",
  "editMessageReplyMarkup",
  "editMessageLiveLocation",
  "answerCallbackQuery",
  "deleteMessage",
  "setMessageReaction",
];

/** Methods that put a message BODY in a chat, as opposed to editing or answering. */
const BODY_WRITERS = [
  "sendMessage",
  "sendPhoto",
  "sendAudio",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendVoice",
  "sendVideoNote",
  "sendMediaGroup",
  "sendLocation",
  "sendVenue",
  "sendContact",
  "sendPoll",
  "sendInvoice",
  "copyMessage",
  "forwardMessage",
];

const CALLED_RE = new RegExp(`\\b(${WRITE_METHODS.join("|")})\\s*\\(`, "g");
const NAMED_RE = new RegExp(`["'\`](${WRITE_METHODS.join("|")})["'\`]`, "g");
/** A method as the last segment of a URL: how a fetch or a curl names the call. */
const PATH_NAMED_RE = new RegExp(`/(${WRITE_METHODS.join("|")})\\b`, "g");
const BODY_WRITER_RE = new RegExp(
  `\\b(${BODY_WRITERS.join("|")})\\s*\\(|["'\`](${BODY_WRITERS.join("|")})["'\`]`,
);

/** Flags that make a `curl` a write. A probe reads a status code and sends nothing. */
const CURL_WRITE_RE =
  /(?:\s-X\s*(?:POST|PUT)|\s--request\s*(?:POST|PUT)|\s-d\s|\s--data|\s-F\s|\s--form|\s-T\s)/;

/** The bot token in the environment: a file that reads one can authenticate a write. */
const TOKEN_ENV_RE =
  /\b(?:TELEGRAM_BOT_TOKEN|BRAID_TG_BOT_TOKEN|TELEGRAM_TOKEN)\b/;

/** Any write method named in any case: a refusal list may be lowercased. */
const NAMES_A_CALL_RE = new RegExp(`\\b(?:${WRITE_METHODS.join("|")})\\b`, "i");

/** Every write method the text actually holds: called, or named as a string. */
function writeMethodsIn(text) {
  const found = new Set();
  for (const match of text.matchAll(CALLED_RE)) found.add(match[1]);
  for (const match of text.matchAll(NAMED_RE)) found.add(match[1]);
  for (const match of text.matchAll(PATH_NAMED_RE)) found.add(match[1]);
  return [...found];
}

// ── Allowlist ────────────────────────────────────────────────────────────────

/**
 * One row per detected file. `key` is the path as printed: relative to the
 * repository, or `~/…` for a file outside it. `maxLength` is the bound an
 * `exempt:constant` row re-measures every run; the other rows state their bound
 * in prose, because the gate itself is what bounds them.
 */
const ROWS = [
  {
    key: "packages/telegram/src/lib/telegram-client.ts",
    calls: 10,
    why: "the Bot API request itself: URL, multipart bodies, the response envelope. Every other Telegram path in this tree ends here",
    gate: "wire",
    bound:
      "4096 characters per message, 1024 per caption: the API's own cap, enforced by the callers",
  },
  {
    key: "packages/telegram/src/lib/format.ts",
    calls: 2,
    why: "the chunk sender under the gate: splits a planned body into API-sized parts and keeps an inline keyboard on the last one",
    gate: "transport",
    bound: "chunks of the configured sendMaxChars (4096 by default)",
  },
  {
    key: "packages/telegram/src/lib/notify/outbound.ts",
    calls: 1,
    why: "the outbound gate: resolves the wire format, refuses markup the parser rejects, refuses an unstructured body past the plain cap, attaches the identity line",
    gate: "gate",
    bound:
      "refuses a body over 280 characters with no structure; chunks what it accepts",
  },
  {
    key: "packages/telegram/src/index.ts",
    calls: 0,
    why: "the extension entry point: the send tool, the turn summary, the turn-complete notify, the watchdog and outage seams, all built on one outbound sender",
    gate: "formatter",
    permit: true,
    bound: "the gate's: 280 characters plain, chunked when formatted",
  },
  {
    key: "packages/telegram/src/lib/tool-logic.ts",
    calls: 0,
    why: "the tool's send logic: resolves the chat, the reply markup and the configured cap, then sends through the outbound sender",
    gate: "formatter",
    bound: "the configured sendMaxChars (4096 by default)",
  },
  {
    key: "packages/telegram/src/lib/notify/live-update.ts",
    calls: 3,
    why: "the tracked working message: plans its first body and every edit through the gate, so an edit cannot carry what the first send would have refused",
    gate: "formatter",
    bound: "the gate's: 280 characters plain, chunked when formatted",
  },
  {
    key: "packages/telegram/src/lib/pause-control.ts",
    calls: 3,
    why: "the pause control keyboard: two module constants and a tap answer, no caller text",
    gate: "exempt:constant",
    constants: ["CONTROL_RUNNING_TEXT", "CONTROL_PAUSED_TEXT"],
    maxLength: 49,
    bound: "49 characters, the longer of the two constants re-measured below",
  },
  {
    key: "packages/telegram/src/lib/inbound-poller.ts",
    calls: 1,
    why: "the poller: one ack per paused period, whose text is a module constant unless an embedder overrides the option",
    gate: "exempt:constant",
    constants: ["PAUSED_INBOUND_ACK_TEXT"],
    maxLength: 77,
    bound: "77 characters, the default constant re-measured below",
  },
  {
    key: "packages/telegram/src/lib/decision-buttons.ts",
    calls: 3,
    why: "decision buttons: rewrites a keyboard and answers the tap. A tap answer is not a message body, and the API caps it at 200 characters",
    gate: "exempt:callback",
    bound: "200 characters: the API's tap-answer cap",
  },
  {
    key: "packages/contrib/network-monitor/settings.ts",
    calls: 0,
    why: "the probe URL's default and its parser: the only place a probe URL is admitted, and the place a Bot API call shape is refused. The module's entry point reads this setting, so the URL cannot arrive by another door",
    gate: "exempt:refuse",
    bound: "nothing is posted",
  },
  {
    key: "packages/contrib/network-monitor/test.ts",
    calls: 0,
    why: "fixture values for the probe URL; the tunnel's exec is mocked, so no curl runs",
    gate: "exempt:fixture",
    bound: "nothing is posted",
  },
  {
    key: "scripts/check-telegram-senders.mjs",
    calls: 0,
    why: "this census: it holds the host pattern and the method names it searches for, and posts nothing",
    gate: "exempt:self",
    bound: "nothing is posted",
  },
  {
    key: "~/.pi/agent/skills/morning-newspaper/scripts/daily-edition.sh",
    calls: 0,
    why: "the morning paper's delivery: composes the digest, validates its markup and its length against the API's per-message cap, then posts the message and the file with curl. The caption rides the same check, which is the message cap rather than the 1024 the API allows a caption",
    gate: "markup-check",
    bound: "4096 characters, refused by the digest checker before either post",
  },
  {
    key: "~/.pi/agent/braid/orchestrator/scripts/net-probe.sh",
    calls: 0,
    why: "names the host as a tunnel probe endpoint, read for a status code, and refuses an endpoint that names a Bot API call so a configured list cannot turn the probe into a sender; the verdict is printed, never posted",
    gate: "exempt:refuse",
    bound: "nothing is posted",
  },
];

/** Rendered so a home-rooted path prints without naming a machine. */
function displayKey(absolute) {
  const underRepo = relative(repoRoot, absolute);
  if (!underRepo.startsWith("..") && !underRepo.startsWith(sep)) {
    return underRepo.split(sep).join("/");
  }
  const underHome = relative(home, absolute);
  if (!underHome.startsWith("..") && !underHome.startsWith(sep)) {
    return `~/${underHome.split(sep).join("/")}`;
  }
  return absolute;
}

// ── Walking ──────────────────────────────────────────────────────────────────

function walk(path, found, skipped) {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        skipped.push(
          `${displayKey(child)} (${SKIP_DIRECTORIES.get(entry.name)})`,
        );
        continue;
      }
      walk(child, found, skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    const extension = dot === -1 ? "" : entry.name.slice(dot);
    if (!CODE_EXTENSIONS.has(extension)) continue;
    if (TEST_FILE_RE.test(entry.name)) {
      skipped.push(
        `${displayKey(child)} (a test file: the transport is injected)`,
      );
      continue;
    }
    found.push(child);
  }
}

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Drop comments before reading the file: a comment cannot post, and a host named
 * in prose (`see api.telegram.org`) is a reader's note, not a path. A `//` after
 * a colon is left alone so a URL literal survives, and a shell `#` that does not
 * begin a word (`$#`, `${#}`) is part of an expansion rather than a comment.
 */
function stripComments(text, extension) {
  if (extension === ".sh" || extension === ".bash" || extension === ".py") {
    return text
      .split("\n")
      .map((line) => {
        if (/^\s*#!/.test(line)) return line;
        const at = line.search(/(^|\s)#(?!\{)/);
        return at === -1 ? line : line.slice(0, at);
      })
      .join("\n");
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[\s;{}()])\/\/[^\n]*/g, "$1");
}

/** Call sites in this file that invoke a Bot API write, definitions excluded. */
function wireCalls(text) {
  const calls =
    text.match(new RegExp(`\\b(?:${WRITE_METHODS.join("|")})\\s*\\(`, "g")) ??
    [];
  const definitions =
    text.match(
      new RegExp(`\\bfunction\\s+(?:${WRITE_METHODS.join("|")})\\s*\\(`, "g"),
    ) ?? [];
  return calls.length - definitions.length;
}

/**
 * Classify one file's text. `sender` needs a write in hand; `probe` is context
 * without one. A file with neither is not in either population.
 */
function detect(text, absolute) {
  const methods = writeMethodsIn(text);
  const host = HOST_RE.test(text);
  const botUrl = BOT_URL_RE.test(text);
  const telegramImport = TELEGRAM_IMPORT_RE.test(text);
  // The path anchor needs a write in hand: `packages/telegram/**` holds dozens of
  // modules that never touch the wire (a clock, an HTML parser), and a census that
  // listed them would bury the eight files that do.
  const isTelegramPackage = absolute.includes(`${sep}telegram${sep}`);
  const reach =
    host ||
    botUrl ||
    telegramImport ||
    (isTelegramPackage && methods.length > 0);
  if (!reach) return { kind: "none", methods };
  if (methods.length > 0 || CURL_WRITE_RE.test(text)) {
    return { kind: "sender", methods };
  }
  return { kind: "probe", methods };
}

/**
 * The length of a module constant's string value, read from the source. Handles
 * a literal, a concatenation of literals, and a literal broken across lines. A
 * constant that became a template or a call returns null, and the row reports it
 * as unmeasurable rather than passing.
 */
function constantLength(text, name) {
  const head = new RegExp(`export\\s+const\\s+${name}\\b[^=]*=`, "m").exec(
    text,
  );
  if (head === null) return null;
  const body = text.slice(head.index + head[0].length);
  const literals = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === ";") break;
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < body.length && body[end] !== char) {
        if (body[end] === "\\") end += 1;
        end += 1;
      }
      literals.push(body.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    index += 1;
  }
  if (literals.length === 0) return null;
  // Escapes are counted after resolution, so a bound is the reader's width.
  return literals.join("").replace(/\\(.)/g, "$1").length;
}

// ── Row verification ─────────────────────────────────────────────────────────

/** Re-check one row against its file. An empty list is a row that still holds. */
function verifyRow(row, text, absolute, kind, calls) {
  const problems = [];
  if (row.calls !== undefined && calls !== row.calls) {
    problems.push(
      `holds ${calls} write call${calls === 1 ? "" : "s"}, the row records ${row.calls}`,
    );
  }
  const has = (pattern) => pattern.test(text);
  const probeRow = ["exempt:probe", "exempt:fixture", "exempt:refuse"].includes(
    row.gate,
  );
  if (kind === "probe" && !probeRow) {
    problems.push(
      `the row names a posting gate, but no write reaches the API from this file`,
    );
  }
  // `exempt:fixture` and `exempt:refuse` carry their own, stronger check (no
  // call sites), so only a row claiming "names the host" is contradicted here.
  if (kind === "sender" && row.gate === "exempt:probe") {
    problems.push(
      `the row says this file cannot post, but it holds ${writeMethodsIn(text).join(", ") || "a curl write"}`,
    );
  }
  switch (row.gate) {
    case "wire":
      if (!has(HOST_RE))
        problems.push("no API host: this is no longer the wire");
      // The client takes an injectable fetch, so the call is `fetchFn(...)`.
      if (!/\bfetch\w*\s*\(/.test(text)) problems.push("no fetch call");
      break;
    case "gate":
      if (!has(/export\s+function\s+planOutbound\b/))
        problems.push("does not export planOutbound");
      break;
    case "formatter":
      if (!has(/\b(?:planOutbound|createOutboundSender)\b/))
        problems.push("names neither planOutbound nor createOutboundSender");
      break;
    case "transport":
      if (!has(/\bsendMessageChunks\b/))
        problems.push("does not carry the chunk sender");
      break;
    case "markup-check": {
      const checkAt = text.search(/--check\b/);
      // The first post is an invocation, not the `tg_request() {` definition.
      const postAt = text.search(/\btg_request\b(?!\s*\()|\bsendMessage\b/);
      if (checkAt === -1)
        problems.push("no --check invocation: the markup gate is gone");
      else if (postAt !== -1 && checkAt > postAt)
        problems.push("the markup check runs after the first post");
      break;
    }
    case "exempt:constant": {
      let longest = 0;
      for (const name of row.constants ?? []) {
        const length = constantLength(text, name);
        if (length === null) {
          problems.push(`${name} is not a measurable string constant`);
          continue;
        }
        longest = Math.max(longest, length);
      }
      if (longest > row.maxLength) {
        problems.push(
          `longest measured constant is ${longest} characters, the row records ${row.maxLength}`,
        );
      }
      break;
    }
    case "exempt:callback":
      if (!has(/\banswerCallbackQuery\s*\(/))
        problems.push("does not answer a tap: the exemption no longer applies");
      if (BODY_WRITER_RE.test(text))
        problems.push(
          "posts a message body, which the exemption does not cover",
        );
      break;
    case "exempt:probe":
      if (writeMethodsIn(text).length > 0)
        problems.push(
          `names the write method ${writeMethodsIn(text)[0]}: this file can post now`,
        );
      if (TOKEN_ENV_RE.test(text))
        problems.push("reads a bot token from the environment");
      if (CURL_WRITE_RE.test(text)) problems.push("carries a curl write flag");
      break;
    case "exempt:refuse":
      if (!/\brefus/i.test(text))
        problems.push("no refusal site: naming a call without refusing it");
      if (!NAMES_A_CALL_RE.test(text))
        problems.push(
          "names no Bot API call: this exemption has nothing to stand on",
        );
      if (wireCalls(text) > 0)
        problems.push(
          `calls ${wireCalls(text)} write method${wireCalls(text) === 1 ? "" : "s"}: this exemption covers names, not calls`,
        );
      if (TOKEN_ENV_RE.test(text))
        problems.push("reads a bot token from the environment");
      break;
    case "exempt:fixture":
      // Fixture data may name a call (a refusal is proved with one); it must not
      // invoke one.
      if (wireCalls(text) > 0)
        problems.push(
          `calls ${wireCalls(text)} write method${wireCalls(text) === 1 ? "" : "s"}: fixture data names calls, it does not make them`,
        );
      break;
    case "exempt:self":
      if (resolve(absolute) !== SELF)
        problems.push("exempt:self is only valid for this script's own path");
      break;
    default:
      problems.push(`unknown gate ${String(row.gate)}`);
  }
  return problems;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const files = [];
const skipped = [];
for (const root of roots) walk(root.path, files, skipped);

const detections = [];
const readErrors = [];
for (const absolute of files) {
  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    readErrors.push(`${displayKey(absolute)}: ${error.message}`);
    continue;
  }
  const extension = absolute.slice(absolute.lastIndexOf("."));
  const code = stripComments(text, extension);
  const verdict = detect(code, absolute);
  if (verdict.kind !== "none")
    detections.push({
      absolute,
      code,
      kind: verdict.kind,
      methods: verdict.methods,
      calls: wireCalls(code),
    });
}

const byKey = new Map(ROWS.map((row) => [row.key, row]));
const findings = [];
const clean = [];
const seen = new Set();

for (const detection of detections) {
  const key = displayKey(detection.absolute);
  seen.add(key);
  const row = byKey.get(key);
  if (row === undefined) {
    findings.push({
      key,
      kind: detection.kind === "probe" ? "unlisted probe" : "unlisted sender",
      detail:
        detection.kind === "probe"
          ? "names the Bot API host or a bot URL without a write in hand"
          : `posts through ${detection.methods.join(", ") || "a curl write"}`,
    });
    continue;
  }
  const problems = verifyRow(
    row,
    detection.code,
    detection.absolute,
    detection.kind,
    detection.calls,
  );
  if (problems.length > 0) {
    findings.push({ key, kind: "row", detail: problems.join("; ") });
    continue;
  }
  clean.push({ key, row, kind: detection.kind, calls: detection.calls });
}

const overrideMode = overrideRoots.length > 0;
for (const row of ROWS) {
  // An override run answers for one directory, so a row describing the tree
  // cannot be stale in it: the file it names was never in scope.
  if (overrideMode) continue;
  if (row.permit === true) continue;
  if (!seen.has(row.key)) {
    findings.push({
      key: row.key,
      kind: "stale row",
      detail: "listed, but nothing that reaches the Bot API was found there",
    });
  }
}

// ── Output ───────────────────────────────────────────────────────────────────

const pad = (value, width) => String(value).padEnd(width);
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

if (listRows) {
  for (const row of ROWS) {
    console.log(
      `${row.key}\n  gate: ${row.gate}\n  why:  ${row.why}\n  max:  ${row.bound}`,
    );
  }
  process.exit(0);
}

console.log("telegram senders census");
console.log("roots swept:");
for (const root of roots) {
  console.log(
    `  ${pad(root.label, 20)} ${root.path === repoRoot ? "." : displayKey(root.path)}`,
  );
}
console.log(
  `files read: ${files.length}, ${plural(skipped.length, "path", "paths")} out of scope by the rules in this script`,
);
if (overrideMode)
  console.log(
    "override run: the rows below are read only where this directory holds the file they name",
  );
console.log("");

const permits = overrideMode ? [] : ROWS.filter((row) => row.permit === true);
if (clean.length > 0 || permits.length > 0) {
  console.log(
    "  path                                                    kind    gate            writes  max message",
  );
  const rows = [
    ...clean.map((entry) => ({
      key: entry.key,
      kind: entry.row.gate === "exempt:fixture" ? "fixture" : entry.kind,
      row: entry.row,
      writes: entry.calls,
    })),
    ...permits.map((row) => ({ key: row.key, kind: "permit", row, writes: 0 })),
  ].sort((a, b) => a.key.localeCompare(b.key));
  for (const entry of rows) {
    console.log(
      `  ${pad(entry.key, 55)} ${pad(entry.kind, 7)} ${pad(entry.row.gate, 15)} ${pad(entry.writes, 7)} ${entry.row.bound}`,
    );
  }
  console.log("");
}

if (findings.length > 0) {
  console.log(`FINDINGS (${findings.length}):`);
  for (const finding of findings) {
    console.log(`  ${pad(finding.kind.toUpperCase(), 18)} ${finding.key}`);
    console.log(`  ${" ".repeat(18)} ${finding.detail}`);
  }
  console.log("");
}

if (readErrors.length > 0) {
  console.log(`UNREADABLE (${readErrors.length}):`);
  for (const error of readErrors) console.log(`  ${error}`);
  console.log("");
}

const senders = detections.filter((entry) => entry.kind === "sender").length;
console.log(
  `census: ${plural(senders, "sender", "senders")}, ${plural(detections.length - senders, "probe", "probes")}, ${plural(ROWS.length, "row", "rows")}, ${plural(findings.length, "finding", "findings")}`,
);

if (findings.length > 0 || readErrors.length > 0) {
  console.log(
    "A path with no row is a way into the owner's chat nobody answered for. Add a row stating why the file exists and which gate it passes, or remove the sender.",
  );
  process.exit(1);
}
process.exit(0);
