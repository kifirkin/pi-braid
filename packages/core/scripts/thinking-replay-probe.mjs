#!/usr/bin/env node
/**
 * thinking-replay-probe.mjs - record what one route does with a stripped reasoning field.
 *
 * The question is narrow and the answer is a measurement, not a policy. On the
 * `openai-completions` wire an assistant turn's thinking is re-sent as
 * `reasoning_content`; DeepSeek's API documentation says that with `tools` in the
 * request every previous turn's `reasoning_content` must be passed back, and that
 * failing to do so returns a 400. The gateway braid's traffic goes through
 * publishes nothing about which upstream rule it enforces, so the only instrument
 * is a request. This script makes that request twice - once with the field, once
 * without - and writes down what came back.
 *
 * Why it records instead of deciding: a policy whose default is `unknown`, and
 * `unknown` never acts, needs exactly one thing from this file, which is a fact.
 * A recorder that also chose the policy would make one request the whole policy,
 * so this is a script under `scripts/` and not a module in the request path:
 * nothing here imports from `src/`, and nothing in `src/` imports this.
 *
 * Classification, in one place so a fixture and a live run cannot disagree:
 *
 *   - 2xx: `accepted: true`.
 *   - 4xx whose body names the reasoning field: `accepted: false`, with the
 *     provider's own code when the body carries one and the field name it matched
 *     when it does not. The rule keys on the field name and not on a word like
 *     "missing", because the same 400 means "required" for the stripped variant
 *     and "refused" for the pass-back variant: the pair of records is what tells
 *     those apart, so one record alone is not a policy input.
 *   - everything else - a 5xx, a 3xx, a 4xx naming something unrelated, an
 *     attempt that produced no status at all - `accepted: "unknown"`. A status
 *     code alone is never a verdict: a gateway in front of the upstream can return
 *     200 for a request the upstream rejected.
 *
 * Every request carries `x-opencode-session`, the per-conversation routing header
 * OpenCode's client fills from `options.sessionId` in
 * `@earendil-works/pi-ai/dist/providers/opencode-headers.js`: the chat body has no
 * field for it, so a request built from the body alone is missing a header that
 * every request sharing this wire carries.
 *
 * Usage:
 *   node packages/core/scripts/thinking-replay-probe.mjs --provider <name> \
 *     --api openai-completions --model <name> --dry-run
 *   node packages/core/scripts/thinking-replay-probe.mjs --provider <name> \
 *     --api openai-completions --model <name> --base-url <url> --record <path> \
 *     [--session-id <id>] [--api-key-env <VAR>] [--force] [--timeout-ms <n>]
 *
 * `--dry-run` prints the header it would send and both request bodies, and opens
 * no socket, so the crafted conversation can be read before it is spent.
 * `--record` is required for a real run: a verdict with nowhere to land is one
 * the next reader cannot consume. The record file is JSON lines, one record per
 * attempt, appended as each attempt completes. `--api-key-env` names the
 * environment variable holding the bearer token; the token is never printed, and
 * a named variable that is unset is a usage error rather than an unauthenticated
 * request whose 401 would be recorded as `unknown`. `--session-id` names the
 * value of the routing header; when it is omitted one is generated per run, so
 * the two attempts of one run route to the same conversation and a second run
 * does not inherit the first one's.
 *
 * A record for the same (provider, api, model, variant) is refused when it would
 * contradict one already in the file, unless `--force` is passed, in which case
 * the new record is appended and the old one stays: the file is a history, and
 * rewriting it would hide the fact that the route changed its mind. `unknown`
 * never contradicts a verdict, because a default cannot disagree with a
 * measurement.
 *
 * Tokens: one short fixed system prompt, a two-turn tool conversation, and
 * `max_tokens` capped at 64. The two bodies carry the same prompt text and differ
 * only in the reasoning field, so a difference between the answers is
 * attributable to that field.
 *
 * Exit codes: 0 both attempts produced an answer and were recorded (a recorded
 * `accepted: false` is an answer, and the caller reads the record rather than the
 * exit code); 2 an attempt produced no answer and the run stopped there, with a
 * record saying `"unknown"` and `httpStatus` null; 3 a record would contradict an
 * existing one and `--force` was not passed, in which case that record is not
 * written; 64 usage.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

const SUPPORTED_APIS = ["openai-completions"];
const VARIANTS = ["pass-back", "stripped"];
const MAX_OUTPUT_TOKENS = 64;
const DEFAULT_TIMEOUT_MS = 30000;

// Fixed prompt text. Both variants carry these bytes, so the only difference
// between the two request bodies is the field under test.
const SYSTEM_PROMPT = "You are a request probe. Use the tool you are given, then answer in one short sentence.";
const USER_PROMPT = "Look up the weight recorded for the key thinking, then tell me what it was.";
const PRIOR_THINKING = "The tool is the only way to read a weight, so call read_weight once and answer from its result.";
const TOOL_RESULT = '{"key":"thinking","weight":"0.42"}';
const TOOL_CALL_ID = "call_probe_1";
const REASONING_FIELD = "reasoning_content";
const SESSION_HEADER = "x-opencode-session";

// The spellings the field travels under in provider error text. This list is the
// whole of what counts as "names the reasoning field"; a body that names none of
// them leaves the attempt `unknown`.
const REASONING_MARKERS = [REASONING_FIELD, "reasoning content"];

const TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "read_weight",
    description: "Read the weight recorded for a key.",
    parameters: {
      type: "object",
      properties: { key: { type: "string", description: "The key to read." } },
      required: ["key"],
      additionalProperties: false,
    },
  },
};

const USAGE = [
  "usage: node packages/core/scripts/thinking-replay-probe.mjs \\",
  "  --provider <name> --api openai-completions --model <name> --dry-run",
  "usage: node packages/core/scripts/thinking-replay-probe.mjs \\",
  "  --provider <name> --api openai-completions --model <name> --base-url <url> --record <path> \\",
  "  [--session-id <id>] [--api-key-env <VAR>] [--force] [--timeout-ms <n>]",
].join("\n");

function usageExit(message) {
  console.error(`thinking-replay-probe: ${message}\n${USAGE}`);
  process.exit(64);
}

function toolCall() {
  return { id: TOOL_CALL_ID, type: "function", function: { name: "read_weight", arguments: '{"key":"thinking"}' } };
}

/** The conversation both variants send, with the field under test in one of them. */
function messagesFor(variant) {
  const assistant =
    variant === "pass-back"
      ? { role: "assistant", content: "", reasoning_content: PRIOR_THINKING, tool_calls: [toolCall()] }
      : { role: "assistant", content: "", tool_calls: [toolCall()] };
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: USER_PROMPT },
    assistant,
    { role: "tool", tool_call_id: TOOL_CALL_ID, content: TOOL_RESULT },
  ];
}

function requestBody({ model }, variant) {
  return {
    model,
    messages: messagesFor(variant),
    tools: [TOOL_DEFINITION],
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: false,
  };
}

/** The provider's own error code, when its body carries one. */
function providerCode(bodyText) {
  if (bodyText === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const candidates = [parsed?.error?.code, parsed?.error?.type, parsed?.code];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

/** The reasoning-field spelling a body names, or null when it names none. */
function matchedMarker(bodyText) {
  const lower = bodyText.toLowerCase();
  return REASONING_MARKERS.find((marker) => lower.includes(marker)) ?? null;
}

function classify(httpStatus, bodyText) {
  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) return { accepted: true, errorCode: null };
  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) {
    const marker = matchedMarker(bodyText);
    if (marker !== null) return { accepted: false, errorCode: providerCode(bodyText) ?? marker };
  }
  return { accepted: "unknown", errorCode: providerCode(bodyText) };
}

function buildRecord(values) {
  return {
    provider: values.provider,
    api: values.api,
    model: values.model,
    variant: values.variant,
    httpStatus: values.httpStatus,
    accepted: values.accepted,
    errorCode: values.errorCode,
    at: new Date().toISOString(),
  };
}

function readRecords(recordPath) {
  if (!existsSync(recordPath)) return [];
  const records = [];
  const lines = readFileSync(recordPath, "utf8").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      usageExit(
        `${recordPath}: line ${index + 1} is not a record - point --record at a record file, or move that one aside, ` +
          "because a file this cannot read is a file whose contradictions it cannot check",
      );
    }
    records.push(parsed);
  }
  return records;
}

/** The existing record this one would contradict, if any. */
function conflictFor(records, record) {
  if (record.accepted !== true && record.accepted !== false) return null;
  const conflict = records.find(
    (existing) =>
      existing !== null &&
      typeof existing === "object" &&
      existing.provider === record.provider &&
      existing.api === record.api &&
      existing.model === record.model &&
      existing.variant === record.variant &&
      (existing.accepted === true || existing.accepted === false) &&
      existing.accepted !== record.accepted,
  );
  return conflict === undefined ? null : conflict;
}

/**
 * One request. A failure with no status line (a refused connection, a TLS
 * failure, the abort below firing before the headers arrived) and a status whose
 * body could not be read are reported through the same field: both mean "no
 * answer", and the caller reads one shape.
 */
async function send({ url, apiKey, sessionId, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let httpStatus = null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SESSION_HEADER]: sessionId,
        ...(apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    httpStatus = response.status;
    const bodyText = await response.text();
    return { httpStatus, bodyText, failure: null };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    const reason = aborted ? `timed out after ${timeoutMs}ms` : String(error instanceof Error ? error.message : error);
    return { httpStatus, bodyText: "", failure: reason };
  } finally {
    clearTimeout(timer);
  }
}

function positiveInt(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) usageExit(`${flag} takes a positive whole number of milliseconds, not ${raw}`);
  return value;
}

function parseArgs(argv) {
  const options = {
    provider: "",
    api: "",
    model: "",
    baseUrl: "",
    record: "",
    sessionId: "",
    apiKeyEnv: "",
    apiKey: "",
    force: false,
    dryRun: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) usageExit(`${flag} needs a value`);
      return next;
    };
    if (flag === "--provider") options.provider = value();
    else if (flag === "--api") options.api = value();
    else if (flag === "--model") options.model = value();
    else if (flag === "--base-url") options.baseUrl = value();
    else if (flag === "--record") options.record = value();
    else if (flag === "--session-id") {
      const id = value();
      if (id.trim() === "") usageExit("--session-id takes a routing id, and an empty one is the header this run is missing");
      options.sessionId = id;
    } else if (flag === "--api-key-env") options.apiKeyEnv = value();
    else if (flag === "--timeout-ms") options.timeoutMs = positiveInt(value(), flag);
    else if (flag === "--force") options.force = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else usageExit(`unknown argument ${flag}`);
  }
  return options;
}

function validate(options) {
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  for (const [field, flag] of [
    ["provider", "--provider"],
    ["api", "--api"],
    ["model", "--model"],
  ]) {
    if (options[field].trim() === "") usageExit(`${flag} is required: a record names the route it is about`);
  }
  if (!SUPPORTED_APIS.includes(options.api)) {
    usageExit(
      `--api ${options.api} is not a wire shape this recorder speaks; supported: ${SUPPORTED_APIS.join(", ")} ` +
        "(a record that names an api the request did not use attests nothing)",
    );
  }
  // Generated here rather than at each request, because the two attempts are one
  // conversation: a value that differed between them would route them apart.
  if (options.sessionId === "") options.sessionId = randomUUID();

  if (options.dryRun) return;

  if (options.baseUrl.trim() === "") {
    usageExit("--base-url is required for a real run; --dry-run needs none, because it sends nothing");
  }
  let base;
  try {
    base = new URL(options.baseUrl);
  } catch {
    usageExit(`--base-url is not a URL: ${options.baseUrl}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") usageExit(`--base-url must be http or https, not ${base.protocol}`);

  if (options.record.trim() === "") {
    usageExit("--record is required for a real run: a verdict with nowhere to land is one the next reader cannot consume");
  }
  const parent = dirname(options.record);
  if (!existsSync(parent)) usageExit(`--record's directory does not exist: ${parent} (this recorder creates no directories)`);
  if (existsSync(options.record) && !statSync(options.record).isFile()) usageExit(`--record is not a file: ${options.record}`);

  if (options.apiKeyEnv !== "") {
    const token = process.env[options.apiKeyEnv] ?? "";
    if (token.trim() === "") {
      usageExit(
        `--api-key-env ${options.apiKeyEnv} is empty in this environment, so the request would go out unauthenticated ` +
          "and a 401 would be recorded as unknown",
      );
    }
    options.apiKey = token;
  }
}

async function run(options) {
  const bodies = VARIANTS.map((variant) => ({ variant, body: requestBody(options, variant) }));

  if (options.dryRun) {
    console.log(`${SESSION_HEADER}: ${options.sessionId}`);
    for (const { variant, body } of bodies) {
      console.log(`variant ${variant}:`);
      console.log(JSON.stringify(body, null, 2));
    }
    return 0;
  }

  const records = readRecords(options.record);
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  for (const { variant, body } of bodies) {
    const attempt = await send({
      url,
      apiKey: options.apiKey,
      sessionId: options.sessionId,
      body,
      timeoutMs: options.timeoutMs,
    });
    const verdict = classify(attempt.httpStatus, attempt.bodyText);
    const record = buildRecord({
      provider: options.provider,
      api: options.api,
      model: options.model,
      variant,
      httpStatus: attempt.httpStatus,
      accepted: verdict.accepted,
      errorCode: verdict.errorCode,
    });
    const conflict = conflictFor(records, record);
    if (conflict !== null && !options.force) {
      console.error(
        `refused: ${options.record} already records accepted=${JSON.stringify(conflict.accepted)} for ` +
          `${options.provider}/${options.api}/${options.model} (${variant}) at ${conflict.at}; ` +
          "pass --force to append the contradicting record instead",
      );
      return 3;
    }
    appendFileSync(options.record, `${JSON.stringify(record)}\n`, "utf8");
    records.push(record);
    console.log(
      `${variant}: httpStatus=${attempt.httpStatus === null ? "none" : attempt.httpStatus} ` +
        `accepted=${JSON.stringify(verdict.accepted)} errorCode=${verdict.errorCode === null ? "null" : verdict.errorCode} ` +
        `recorded in ${options.record}`,
    );
    if (attempt.failure !== null) {
      console.error(`no answer for ${variant}: ${attempt.failure} - the record says unknown and the run stops here`);
      return 2;
    }
  }
  return 0;
}

const options = parseArgs(process.argv.slice(2));
validate(options);
process.exit(await run(options));
