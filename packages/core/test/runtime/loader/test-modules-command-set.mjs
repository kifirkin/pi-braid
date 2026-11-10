/**
 * The module surface is one `modules` command.
 *
 * WHY THIS TEST EXISTS:
 *   Six command names were folded into one command with a verb dispatch and
 *   kept registered as forwarding aliases for one release. The aliases are now
 *   gone, and the palette is where a user reads the surface: an alias still
 *   registered is a second name for one object, while a missing `modules`
 *   command leaves the resolver unreachable from a prompt. The exact set is
 *   asserted so either direction fails by name.
 *
 * WHAT IS PINNED HERE:
 *   1. The exact sorted set: `modules` alone.
 *   2. Every retired name is absent on its own, so a re-add has to change this
 *      test on purpose.
 *   3. The entry carries a handler.
 *   4. The rendered header says a contrib extension is toggled through
 *      `braid.contrib` in settings, so the list cannot omit that fact silently.
 *
 * HOME and BRAID_HOME point at temp dirs before the dist modules load: the
 * loader resolves its settings sources at module load, and the command must
 * not read or write the real agent tree from a test.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

process.env.HOME = mkdtempSync(join(tmpdir(), "modules-command-set-home-"));
process.env.PI_CODING_AGENT_DIR = join(process.env.HOME, ".pi", "agent");
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "modules-command-set-braid-"));

const { default: modulesApiExtension } = await import(join(ROOT, "dist", "loader", "api.js"));

const RETIRED = [
  "modules-disable",
  "modules-enable",
  "modules-list",
  "modules-reset",
  "modules-status",
  "modules-toggle",
];

/** Load the extension the way pi does, capturing the commands it registers. */
async function loadExtension() {
  const commands = new Map();
  const pi = {
    on() {},
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };
  await modulesApiExtension(pi);
  return commands;
}

/** A command context that records notifications instead of rendering. */
function rpcContext() {
  const notices = [];
  return {
    ctx: {
      mode: "rpc",
      hasUI: true,
      ui: {
        notify(message, type) {
          notices.push({ message, type });
        },
      },
    },
    notices,
  };
}

test("the registered command set is modules alone", async () => {
  const names = [...(await loadExtension()).keys()].sort();
  assert.deepEqual(names, ["modules"], "the module surface must be one command");
});

test("no retired name is registered", async () => {
  const commands = await loadExtension();
  for (const name of RETIRED) {
    assert.equal(
      commands.has(name),
      false,
      `${name} is retired; a second name for one object must not come back`,
    );
  }
});

test("the registered entry carries a handler", async () => {
  for (const [name, definition] of await loadExtension()) {
    assert.equal(typeof definition.handler, "function", `${name} must have a handler`);
  }
});

test("the rendered header names braid.contrib as the home of contrib toggles", async () => {
  const { ctx, notices } = rpcContext();
  await loadExtension().then((commands) => commands.get("modules").handler("list", ctx));

  assert.equal(notices.length, 1, "list prints exactly one block");
  assert.match(
    notices[0].message,
    /Contrib extensions are toggled through braid\.contrib in settings, not from this list\./,
    "the header must not leave a contrib extension looking forgotten",
  );
});
