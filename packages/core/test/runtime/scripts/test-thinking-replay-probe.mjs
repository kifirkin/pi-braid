/**
 * thinking-replay-probe.mjs contract: the recorder classifies an answer from the
 * status AND the body, prints both request bodies without opening a socket, and
 * appends a record per attempt rather than rewriting the file.
 *
 * Every case runs the real script against a loopback HTTP server this file
 * starts, so what is asserted is the record the recorder wrote and the bytes it
 * put on the wire, not an internal function that could drift from either. No
 * case reaches a real provider: the only host any case dials is the fixture's.
 *
 * The socket guard is the instrument behind "no network". It is a preload that
 * replaces `net.Socket.prototype.connect` and refuses every target but the one
 * string it was given, and it is installed on the dry run (where it allows
 * nothing at all) as well as on the real runs. A case proves the guard is live
 * before any case relies on it, because a guard that silently failed to install
 * would make every "no socket" assertion below vacuously true.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const probe = resolve(here, "..", "..", "..", "scripts", "thinking-replay-probe.mjs");

const ROUTE = { provider: "fixture-route", api: "openai-completions", model: "fixture-model" };
const ACCEPTED_BODY = JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "0.42" } }] });
const REFUSED_BODY = JSON.stringify({
  error: {
    message: "Missing reasoning_content in the assistant message at index 2",
    type: "invalid_request_error",
    code: "reasoning_content_missing",
  },
});
const LIMIT_BODY = JSON.stringify({ error: { message: "upstream refused the request", code: "server_error" } });
const UNRELATED_BODY = JSON.stringify({ error: { message: "model not found", code: "model_not_found" } });
const CODED_PHRASE_BODY = JSON.stringify({
  error: { message: "reasoning_content must be passed back for every previous turn" },
});

const root = mkdtempSync(join(tmpdir(), "thinking-replay-probe-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

let caseCount = 0;
/** A fresh directory for one case, so a record file or a guard cannot be shared. */
function scratch(label) {
  const dir = join(root, `${caseCount++}-${label}`);
  mkdirSync(dir);
  return dir;
}

function recordPath(dir) {
  return join(dir, "records.jsonl");
}

/** Arguments naming the route, without the endpoint: each case supplies its own. */
function routeArgs(dir, extra = []) {
  return [
    "--provider",
    ROUTE.provider,
    "--api",
    ROUTE.api,
    "--model",
    ROUTE.model,
    "--record",
    recordPath(dir),
    ...extra,
  ];
}

/** One child run; a non-zero exit is a result to assert on, not a throw. */
function runNode(argv, { cwd, env, timeoutMs = 30000 } = {}) {
  return new Promise((done) => {
    execFile(process.execPath, argv, { cwd, env: { ...process.env, ...env }, timeout: timeoutMs }, (error, stdout, stderr) => {
      done({
        code: error === null ? 0 : typeof error.code === "number" ? error.code : -1,
        killed: error !== null && error.killed === true,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

function runProbe(args, options) {
  return runNode([probe, ...args], options);
}

/**
 * A loopback route standing in for the provider. `answer(variant)` returns
 * `{ status, body }`, `{ destroy: true }` to close the connection with no status
 * line, or `{ hold: true }` to leave the request unanswered so the recorder's own
 * timeout is what ends it.
 */
async function startRoute(answer) {
  const state = { requests: [], connections: 0 };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        // A body that is not JSON names no variant; the request is still recorded.
        body = null;
      }
      const variant = body?.messages?.[2]?.reasoning_content === undefined ? "stripped" : "pass-back";
      state.requests.push({ variant, text, url: request.url, method: request.method, headers: request.headers });
      const reply = answer(variant, { body, text });
      if (reply.destroy === true) {
        request.socket.destroy();
        return;
      }
      if (reply.hold === true) return;
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(reply.body ?? "");
    });
  });
  server.on("connection", () => {
    state.connections += 1;
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    origin: `127.0.0.1:${port}`,
    async close() {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/**
 * The preload that refuses every socket but `allowed` (`host:port`, or "" to
 * refuse all of them). `net.Socket.prototype.connect` is the one choke point
 * every client in this runtime passes through, so a fetch to another host dies
 * before a packet leaves the machine.
 */
function writeGuard(dir, allowed) {
  const path = join(dir, "socket-guard.mjs");
  const body = `import net from "node:net";
const allowed = ${JSON.stringify(allowed)};
const real = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const first = args[0];
  let host = "127.0.0.1";
  let port;
  if (typeof first === "number") {
    port = first;
    if (typeof args[1] === "string") host = args[1];
  } else if (typeof first === "string") {
    throw new Error("socket-guard: refusing an IPC connect (" + first + ")");
  } else if (Array.isArray(first)) {
    port = first[0] && first[0].port;
    host = (first[0] && first[0].host) || host;
  } else if (first && typeof first === "object") {
    port = first.port;
    host = first.host || host;
  }
  const target = host + ":" + port;
  if (target !== allowed) throw new Error("socket-guard: refusing a socket to " + target);
  return real.apply(this, args);
};
`;
  writeFileSync(path, body);
  return path;
}

/** The records in `dir`'s record file, in file order. */
function recordsIn(dir) {
  const file = recordPath(dir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** The bodies `--dry-run` printed, keyed by the variant label above each one. */
function printedBodies(stdout) {
  const bodies = {};
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current !== null) bodies[current] = JSON.parse(buffer.join("\n"));
  };
  for (const line of stdout.split("\n")) {
    const label = /^variant (\S+):$/.exec(line);
    if (label !== null) {
      flush();
      current = label[1];
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return bodies;
}

/**
 * Run one full probe against a fixture route and return every surface: the exit
 * code, both streams, the record file, and what the route received.
 */
async function probeWithRoute(dir, answer, { extra = [], env, timeoutMs, nodeArgs = [] } = {}) {
  const route = await startRoute(answer);
  try {
    const result = await runProbe([...routeArgs(dir, extra), "--base-url", route.baseUrl], { env, timeoutMs, nodeArgs });
    return { ...result, state: route.state, records: recordsIn(dir) };
  } finally {
    await route.close();
  }
}

// ── The guard is live ────────────────────────────────────────────────────────
// Run first and standing alone: every "no socket" assertion below is worthless
// if this preload never installed. TEST-NET-1 (192.0.2.0/24) is reserved for
// documentation, so a guard that failed to install would not reach a real host.
test("the socket guard refuses a connection to any host but the one it allows", async () => {
  const dir = scratch("guard-control");
  const guard = writeGuard(dir, "127.0.0.1:9");
  const program = [
    'fetch("http://192.0.2.1:81/probe").then(',
    '() => { console.log("connected"); },',
    'error => { console.error(String(error?.cause?.message ?? error)); process.exit(1); });',
  ].join("\n");
  const result = await runNode(["--import", guard, "-e", program]);
  assert.equal(result.code, 1, `a socket to another host was allowed: ${result.stdout}`);
  assert.match(result.stderr, /socket-guard: refusing a socket to 192\.0\.2\.1:81/);
});

// ── B1: one row per classification ──────────────────────────────────────────
test("a 2xx answer records accepted true", async () => {
  const dir = scratch("accepted");
  const result = await probeWithRoute(dir, () => ({ status: 200, body: ACCEPTED_BODY }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.records.map((record) => record.variant),
    ["pass-back", "stripped"],
  );
  for (const record of result.records) {
    assert.equal(record.httpStatus, 200);
    assert.equal(record.accepted, true);
    assert.equal(record.errorCode, null);
  }
  // The key set is the contract's and it is closed: a policy reader that meets
  // an extra field cannot tell a newer recorder from a typo.
  assert.deepEqual(Object.keys(result.records[0]), [
    "provider",
    "api",
    "model",
    "variant",
    "httpStatus",
    "accepted",
    "errorCode",
    "at",
  ]);
  assert.match(result.records[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test("a 400 whose body names the reasoning field records false and the provider's own code", async () => {
  const dir = scratch("refused");
  const result = await probeWithRoute(dir, (variant) =>
    variant === "stripped" ? { status: 400, body: REFUSED_BODY } : { status: 200, body: ACCEPTED_BODY },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.records.map((record) => [record.variant, record.accepted, record.errorCode]),
    [
      ["pass-back", true, null],
      ["stripped", false, "reasoning_content_missing"],
    ],
  );
});

test("a 400 that names the field and carries no code records the field name", async () => {
  const dir = scratch("refused-phrase");
  const result = await probeWithRoute(dir, (variant) =>
    variant === "stripped" ? { status: 400, body: CODED_PHRASE_BODY } : { status: 200, body: ACCEPTED_BODY },
  );
  assert.equal(result.code, 0, result.stderr);
  const stripped = result.records.find((record) => record.variant === "stripped");
  assert.equal(stripped.accepted, false);
  assert.equal(stripped.errorCode, "reasoning_content");
});

test("a 500 records accepted unknown, never false", async () => {
  const dir = scratch("server-error");
  const result = await probeWithRoute(dir, () => ({ status: 500, body: LIMIT_BODY }));
  assert.equal(result.code, 0, result.stderr);
  for (const record of result.records) {
    assert.equal(record.httpStatus, 500);
    assert.equal(record.accepted, "unknown");
    assert.equal(record.errorCode, "server_error");
  }
});

test("a 400 that names something unrelated records accepted unknown", async () => {
  const dir = scratch("unrelated");
  const result = await probeWithRoute(dir, () => ({ status: 400, body: UNRELATED_BODY }));
  assert.equal(result.code, 0, result.stderr);
  for (const record of result.records) {
    assert.equal(record.accepted, "unknown");
    assert.equal(record.errorCode, "model_not_found");
  }
});

// ── B2: the dry run is silent and the two bodies differ in one field ────────
test("--dry-run prints both request bodies and opens no socket", async () => {
  const dir = scratch("dry-run");
  const guard = writeGuard(dir, "");
  const result = await runProbe(
    ["--provider", ROUTE.provider, "--api", ROUTE.api, "--model", ROUTE.model, "--dry-run"],
    { nodeArgs: ["--import", guard] },
  );
  assert.equal(result.code, 0, result.stderr);
  const bodies = printedBodies(result.stdout);
  assert.deepEqual(Object.keys(bodies), ["pass-back", "stripped"]);

  const passBack = bodies["pass-back"];
  const stripped = bodies.stripped;
  assert.equal(typeof passBack.messages[2].reasoning_content, "string");
  assert.equal("reasoning_content" in stripped.messages[2], false);
  // Nothing but the field: the parsed pass-back body with that one key removed
  // is the stripped body, key for key and value for value.
  const copy = JSON.parse(JSON.stringify(passBack));
  delete copy.messages[2].reasoning_content;
  assert.deepEqual(copy, stripped);
  assert.equal(passBack.max_tokens, 64);
});

// ── The wire ────────────────────────────────────────────────────────────────
test("both variants send the same bytes apart from the reasoning field", async () => {
  const dir = scratch("wire");
  const route = await startRoute((variant) =>
    variant === "stripped" ? { status: 400, body: REFUSED_BODY } : { status: 200, body: ACCEPTED_BODY },
  );
  const guard = writeGuard(dir, route.origin);
  try {
    // The guard allows this route only, so the run itself proves that no other
    // host was dialled.
    const result = await runProbe([...routeArgs(dir), "--base-url", route.baseUrl], {
      nodeArgs: ["--import", guard],
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(route.state.requests.length, 2);
    const [passBack, stripped] = route.state.requests;
    assert.equal(passBack.variant, "pass-back");
    assert.equal(stripped.variant, "stripped");
    assert.equal(passBack.method, "POST");
    assert.equal(passBack.url, "/v1/chat/completions");

    const parsed = JSON.parse(passBack.text);
    assert.equal(parsed.model, ROUTE.model);
    assert.equal(parsed.max_tokens, 64);
    assert.equal(parsed.tools.length, 1);
    assert.equal(parsed.tools[0].function.name, "read_weight");
    assert.equal(parsed.messages.length, 4);

    // Byte equality on the wire: re-serializing the pass-back body after
    // removing the one field reproduces the stripped body exactly, so no other
    // byte of the prompt differs.
    const copy = JSON.parse(passBack.text);
    delete copy.messages[2].reasoning_content;
    assert.equal(JSON.stringify(copy), stripped.text);
    assert.equal(stripped.text.includes("reasoning_content"), false);
    assert.equal(passBack.text.includes("reasoning_content"), true);
  } finally {
    await route.close();
  }
});

// ── B3: a contradiction is refused, and --force appends ─────────────────────
test("a contradicting record is refused without --force and appended with it", async () => {
  const dir = scratch("conflict");
  const planted = {
    provider: ROUTE.provider,
    api: ROUTE.api,
    model: ROUTE.model,
    variant: "pass-back",
    httpStatus: 400,
    accepted: false,
    errorCode: "reasoning_content_missing",
    at: new Date().toISOString(),
  };
  const plantedLine = `${JSON.stringify(planted)}\n`;
  writeFileSync(recordPath(dir), plantedLine, "utf8");

  const refused = await probeWithRoute(dir, () => ({ status: 200, body: ACCEPTED_BODY }));
  assert.equal(refused.code, 3, refused.stderr);
  assert.equal(readFileSync(recordPath(dir), "utf8"), plantedLine);
  assert.match(refused.stderr, /accepted=false/);
  assert.ok(refused.stderr.includes(planted.at), `the refusal names no existing record: ${refused.stderr}`);
  // Refused after the first verdict existed and before the second request: a
  // contradiction is a relation between two verdicts, so the new one has to be
  // measured before it can be called a contradiction.
  assert.equal(refused.state.requests.length, 1);

  const forced = await probeWithRoute(
    dir,
    () => ({ status: 200, body: ACCEPTED_BODY }),
    { extra: ["--force"] },
  );
  assert.equal(forced.code, 0, forced.stderr);
  const lines = readFileSync(recordPath(dir), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], planted);
  assert.deepEqual(
    lines.slice(1).map((record) => [record.variant, record.accepted]),
    [
      ["pass-back", true],
      ["stripped", true],
    ],
  );
});

// ── An attempt with no status is "unknown", and the run stops ───────────────
test("an attempt with no status line records unknown and exits non-zero", async () => {
  const dir = scratch("no-answer");
  const result = await probeWithRoute(dir, () => ({ destroy: true }));
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.records.length, 1, "the run continued after an attempt with no answer");
  assert.equal(result.records[0].variant, "pass-back");
  assert.equal(result.records[0].httpStatus, null);
  assert.equal(result.records[0].accepted, "unknown");
  assert.equal(result.records[0].errorCode, null);
  assert.match(result.stderr, /no answer for pass-back/);
});

test("a request that is never answered times out as no answer", async () => {
  const dir = scratch("timeout");
  const result = await probeWithRoute(dir, () => ({ hold: true }), {
    extra: ["--timeout-ms", "200"],
    timeoutMs: 20000,
  });
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].httpStatus, null);
  assert.equal(result.records[0].accepted, "unknown");
  assert.match(result.stderr, /timed out after 200ms/);
});

// ── B4: the record file is the only file written ────────────────────────────
test("a run writes the record file and nothing under cwd or TMPDIR", async () => {
  const base = scratch("no-writes");
  const work = join(base, "cwd");
  const temp = join(base, "tmp");
  const records = join(base, "records");
  mkdirSync(work);
  mkdirSync(temp);
  mkdirSync(records);
  const route = await startRoute(() => ({ status: 200, body: ACCEPTED_BODY }));
  try {
    const result = await runProbe(
      [
        "--provider",
        ROUTE.provider,
        "--api",
        ROUTE.api,
        "--model",
        ROUTE.model,
        "--base-url",
        route.baseUrl,
        "--record",
        join(records, "records.jsonl"),
      ],
      { cwd: work, env: { TMPDIR: temp } },
    );
    assert.equal(result.code, 0, result.stderr);
    // The two places a program creates a file without naming a path. An absolute
    // path outside both would not be caught here, and there is none: the
    // recorder's only write call takes the path it was given.
    assert.deepEqual(readdirSync(work), []);
    assert.deepEqual(readdirSync(temp), []);
    assert.deepEqual(readdirSync(records), ["records.jsonl"]);
  } finally {
    await route.close();
  }
});

// ── Usage and the key ───────────────────────────────────────────────────────
test("a real run refuses a missing --record, a foreign api, no --base-url and an absent record directory", async () => {
  const dir = scratch("usage");
  const endpoint = "http://127.0.0.1:9/v1";
  const missingRecord = await runProbe([
    "--provider",
    ROUTE.provider,
    "--api",
    ROUTE.api,
    "--model",
    ROUTE.model,
    "--base-url",
    endpoint,
  ]);
  assert.equal(missingRecord.code, 64);
  assert.match(missingRecord.stderr, /--record is required/);

  const foreignApi = await runProbe([
    "--provider",
    ROUTE.provider,
    "--api",
    "anthropic-messages",
    "--model",
    ROUTE.model,
    "--base-url",
    endpoint,
    "--record",
    recordPath(dir),
  ]);
  assert.equal(foreignApi.code, 64);
  assert.match(foreignApi.stderr, /anthropic-messages is not a wire shape this recorder speaks/);

  const missingBaseUrl = await runProbe([
    "--provider",
    ROUTE.provider,
    "--api",
    ROUTE.api,
    "--model",
    ROUTE.model,
    "--record",
    recordPath(dir),
  ]);
  assert.equal(missingBaseUrl.code, 64);
  assert.match(missingBaseUrl.stderr, /--base-url is required/);

  const absentDir = await runProbe([
    "--provider",
    ROUTE.provider,
    "--api",
    ROUTE.api,
    "--model",
    ROUTE.model,
    "--base-url",
    endpoint,
    "--record",
    join(dir, "absent", "records.jsonl"),
  ]);
  assert.equal(absentDir.code, 64);
  assert.match(absentDir.stderr, /creates no directories/);
  assert.equal(existsSync(join(dir, "absent")), false, "the recorder created the directory it was told did not exist");
  assert.equal(recordsIn(dir).length, 0);
});

test("the bearer token comes from the named variable and is never printed", async () => {
  const dir = scratch("key");
  const route = await startRoute(() => ({ status: 200, body: ACCEPTED_BODY }));
  const token = "fixture-token-9f2c";
  try {
    const result = await runProbe(
      [...routeArgs(dir, ["--api-key-env", "PROBE_FIXTURE_TOKEN"]), "--base-url", route.baseUrl],
      { env: { PROBE_FIXTURE_TOKEN: token } },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(route.state.requests.length, 2);
    for (const request of route.state.requests) assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(result.stdout.includes(token), false);
    assert.equal(result.stderr.includes(token), false);
  } finally {
    await route.close();
  }

  const unset = await runProbe(
    [...routeArgs(dir, ["--api-key-env", "PROBE_FIXTURE_TOKEN_ABSENT"]), "--base-url", "http://127.0.0.1:9/v1"],
    { env: { PROBE_FIXTURE_TOKEN: "" } },
  );
  assert.equal(unset.code, 64);
  assert.match(unset.stderr, /PROBE_FIXTURE_TOKEN_ABSENT is empty/);
});
