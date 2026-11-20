#!/usr/bin/env node
/**
 * emulated-provider.mjs - a local OpenAI chat-completions endpoint that plays
 * the behaviours a real provider shows only while it is failing.
 *
 * WHY THIS EXISTS:
 *   Three provider behaviours decide how a turn ends, and none of them can be
 *   summoned from a paid endpoint on request: a 429 before the answer, a
 *   stream that stops before `[DONE]`, and a normal answer assembled from
 *   deltas. Testing any of them against a real provider costs money, needs
 *   the provider to fail on cue, and reads a different answer on every run.
 *   A local server that speaks the same dialect makes each one a mode flag:
 *   free, deterministic, and reproducible on a box with no network.
 *
 * WHAT A MODE IS:
 *   `normal` streams a complete answer (role chunk, content deltas,
 *   finish_reason, usage, `[DONE]`). `retry` answers the first
 *   `failures` requests with 429 and then behaves like `normal`, which is the
 *   shape a provider-level retry has to absorb inside one turn. `truncated`
 *   streams content and then ends the connection before finish_reason and
 *   before `[DONE]`, which is the shape an assembler must not read as a
 *   completed answer.
 *
 * WHY IT IS NOT A MOCK OF PI:
 *   The client under test is the real one - pi's `openai-completions`
 *   transport, its retry helper, its stream assembler - reached over a real
 *   socket. Only the far end is emulated; nothing on pi's side is stubbed.
 *
 * CLI:
 *   node packages/core/scripts/emulated-provider.mjs [--mode <name>] [--port <n>]
 *     [--failures <n>] [--reply <text>] [--model <id>] [--retry-after-ms <n>]
 *     [--quiet]
 *
 *   It prints the provider block to paste into `~/.pi/agent/models.json`, the
 *   retry line `~/.pi/agent/settings.json` needs for the mode it is running,
 *   the command that reaches it, and one line per request as it arrives.
 *   `GET /__status` returns the same counters as JSON.
 *
 * The fixture `test/runtime/providers/test-emulated-provider.mjs` drives this
 * server through pi and pins the three behaviours; this file is the far end,
 * not a test itself.
 */
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "emulated-model";
const DEFAULT_REPLY = "emulated reply";
const DEFAULT_HOST = "127.0.0.1";

/** One line per mode: what the wire does, and what it is for. */
export const MODES = Object.freeze({
  normal: "a complete answer: role, content deltas, finish_reason stop, usage, [DONE]",
  retry:
    "`failures` requests answered 429 first, then a complete answer: what a provider-level retry has to absorb inside one turn",
  truncated:
    "content deltas, then the connection ends before finish_reason and [DONE]: what an assembler must not read as a completed answer",
});

/**
 * Split a reply into the pieces a provider sends as separate deltas. Whole
 * tokens, never one character per chunk: a single-chunk answer would not
 * distinguish assembly from a single assignment.
 */
function splitIntoDeltas(text) {
  const pieces = text.match(/\s*\S+/g);
  return pieces ?? [text];
}

function chunkId(index) {
  return `chatcmpl-emulated-${index}`;
}

/** One `data:` line of the dialect, newline-terminated as SSE requires. */
function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function completionChunk({ id, created, model, choices, usage }) {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: "emulated",
    choices,
  };
  if (usage !== undefined) {
    payload.usage = usage;
  }
  return sse(payload);
}

/**
 * Send `mode: normal` - the whole answer, in the order a real endpoint sends
 * it. The usage-only chunk with an empty `choices` array is what OpenAI sends
 * when the request carries `stream_options.include_usage`, which pi's
 * transport always asks for.
 */
function writeCompleteAnswer(res, { id, created, model, reply, usage }) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  res.write(
    completionChunk({
      id,
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
  );
  for (const piece of splitIntoDeltas(reply)) {
    res.write(
      completionChunk({
        id,
        created,
        model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      }),
    );
  }
  res.write(
    completionChunk({
      id,
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
  );
  res.write(completionChunk({ id, created, model, choices: [], usage }));
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Send `mode: truncated` - the same opening as a real answer, then the
 * connection closes. No finish_reason, no `[DONE]`: a transport that treats
 * end-of-body as end-of-answer reports a clean stop here, and the fixture
 * exists to fail when it does.
 */
function writeTruncatedAnswer(res, { id, created, model, reply }) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  res.write(
    completionChunk({
      id,
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
  );
  const pieces = splitIntoDeltas(reply);
  const sent = pieces.slice(0, Math.max(1, Math.ceil(pieces.length / 2)));
  for (const piece of sent) {
    res.write(
      completionChunk({
        id,
        created,
        model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      }),
    );
  }
  res.end();
}

/**
 * Start the server. Resolves once it is listening, so a caller can point a
 * client at `url` without racing the bind.
 *
 * Options: `mode` (a key of MODES), `failures` (429s before the answer in
 * `retry`), `reply`, `model`, `retryAfterMs` (the `retry-after-ms` header on a
 * 429; 0 makes a retry immediate), `port` (0 picks a free one), `host`, and
 * `log` (true to print one line per request, or a function taking that line).
 */
export async function startEmulatedProvider(options = {}) {
  const mode = options.mode ?? "normal";
  if (!Object.hasOwn(MODES, mode)) {
    throw new Error(`unknown mode "${mode}": expected one of ${Object.keys(MODES).join(", ")}`);
  }
  const reply = options.reply ?? DEFAULT_REPLY;
  const model = options.model ?? DEFAULT_MODEL;
  const retryAfterMs = options.retryAfterMs ?? 0;
  const log = options.log === true ? (line) => console.log(line) : options.log;

  const state = {
    mode,
    failuresRemaining: mode === "retry" ? Math.max(0, options.failures ?? 1) : 0,
    requests: [],
    counter: 0,
  };

  const record = (entry) => {
    state.requests.push(entry);
    if (typeof log === "function") {
      log(`[emulated] ${entry.method} ${entry.path} -> ${entry.status}`);
    }
  };

  const server = createServer((req, res) => {
    const started = {
      at: Date.now(),
      method: req.method,
      path: req.url,
      headers: req.headers,
      status: 0,
    };

    // Any prefix counts: the printed baseUrl carries `/v1`, and a human who
    // curls the baseUrl should not have to know this route ignores it.
    if (req.method === "GET" && typeof req.url === "string" && req.url.endsWith("/__status")) {
      const body = JSON.stringify(
        {
          mode: state.mode,
          model,
          reply,
          failuresRemaining: state.failuresRemaining,
          requests: state.requests.length,
        },
        null,
        2,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      record({ ...started, status: 200, body: null });
      return;
    }

    const chunks = [];
    req.on("data", (piece) => chunks.push(piece));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        // A body this server cannot parse is still worth recording verbatim:
        // the fixture asserts on what pi sent, and a non-JSON body is evidence
        // about the request rather than a reason to drop it.
        body = raw;
      }

      const isCompletion =
        req.method === "POST" &&
        typeof req.url === "string" &&
        req.url.endsWith("/chat/completions");
      if (!isCompletion) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `emulated provider: no route ${req.url}` } }));
        record({ ...started, status: 404, body });
        return;
      }

      state.counter += 1;
      const id = chunkId(state.counter);
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 };

      if (state.mode === "retry" && state.failuresRemaining > 0) {
        state.failuresRemaining -= 1;
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after-ms": String(retryAfterMs),
        });
        res.end(
          JSON.stringify({
            error: {
              message: "emulated provider: rate limited",
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
            },
          }),
        );
        record({ ...started, status: 429, body });
        return;
      }

      if (state.mode === "truncated") {
        writeTruncatedAnswer(res, { id, created, model, reply });
        record({ ...started, status: 200, body });
        return;
      }

      writeCompleteAnswer(res, { id, created, model, reply, usage });
      record({ ...started, status: 200, body });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? DEFAULT_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const { port } = server.address();
  const baseUrl = `http://${options.host ?? DEFAULT_HOST}:${port}/v1`;

  return {
    mode,
    model,
    reply,
    port,
    /** What `models.json` calls `baseUrl`: the client appends `/chat/completions`. */
    url: baseUrl,
    baseUrl,
    /** Every request the server answered, with its status and parsed body. */
    requests: state.requests,
    status: () => ({
      mode: state.mode,
      failuresRemaining: state.failuresRemaining,
      requests: state.requests.length,
    }),
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

/** The provider block a human pastes into `~/.pi/agent/models.json`. */
export function modelsJson(emulated) {
  return {
    providers: {
      emulated: {
        baseUrl: emulated.baseUrl,
        api: "openai-completions",
        apiKey: "emulated",
        models: [{ id: emulated.model }],
      },
    },
  };
}

/**
 * The settings line a mode needs to do what it advertises. A 429 is retried
 * inside one turn only when `retry.provider.maxRetries` is set; pi's
 * provider retry count has no default, so leaving it out turns `retry` into a
 * failed turn. A truncated stream ends a turn that nothing can complete, so
 * `truncated` turns the turn-level retry off: otherwise the failure is
 * re-attempted three times, each one costing a real request.
 */
export function settingsJsonFor(mode) {
  if (mode === "truncated") {
    return { retry: { enabled: false } };
  }
  return { retry: { provider: { maxRetries: 2 } } };
}

const USAGE = `emulated provider: a local OpenAI chat-completions endpoint

  node packages/core/scripts/emulated-provider.mjs [options]

  --mode <name>            normal | retry | truncated            (default: normal)
  --failures <n>           429 responses before the answer       (default: 1, retry mode)
  --port <n>               listen port, 0 for a free one         (default: 0)
  --failures/--reply/--model/--retry-after-ms/--quiet
  --help                   this text

  normal     ${MODES.normal}
  retry      ${MODES.retry}
  truncated  ${MODES.truncated}

  It prints the models.json block, the settings.json line the mode needs, and
  one line per request. GET /__status returns the counters as JSON.
`;

function parseArgs(argv) {
  const parsed = { mode: "normal", quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${flag} needs a value`);
      }
      return argv[index];
    };
    switch (flag) {
      case "--mode":
        parsed.mode = value();
        break;
      case "--port":
        parsed.port = Number(value());
        break;
      case "--failures":
        parsed.failures = Number(value());
        break;
      case "--reply":
        parsed.reply = value();
        break;
      case "--model":
        parsed.model = value();
        break;
      case "--retry-after-ms":
        parsed.retryAfterMs = Number(value());
        break;
      case "--quiet":
        parsed.quiet = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return parsed;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`emulated-provider: ${error.message}\n`);
    process.stdout.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }

  const emulated = await startEmulatedProvider({ ...parsed, log: !parsed.quiet });
  const provider = modelsJson(emulated);
  const providerBlock = JSON.stringify(provider.providers.emulated, null, 2).replace(/\n/g, "\n  ");

  console.log(`emulated provider listening  ${emulated.baseUrl}  mode=${emulated.mode}`);
  console.log(`  ${MODES[emulated.mode]}`);
  console.log("");
  console.log('1. in ~/.pi/agent/models.json, under "providers":');
  console.log(`  "emulated": ${providerBlock}`);
  console.log("");
  console.log("2. in ~/.pi/agent/settings.json:");
  console.log(`  ${JSON.stringify(settingsJsonFor(emulated.mode))}`);
  console.log("");
  console.log("3. reach it:");
  console.log(`  pi --provider emulated --model ${emulated.model} "say hello"`);
  console.log("");
  console.log("Press Ctrl-C to stop. GET /__status shows the counters.");

  const stop = () => {
    emulated.stop().then(
      () => process.exit(0),
      (error) => {
        console.error(`emulated-provider: ${error.message}`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(`emulated-provider: ${error.message}`);
    process.exitCode = 1;
  });
}
