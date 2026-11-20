/**
 * Test: scripts/check-preferences.mjs - the gate over the store and its projection.
 *
 * The store is the truth; the markdown file is a projection of it. Each case
 * below pins one thing the store cannot check about itself, and each runs the
 * real script against a pinned BRAID_HOME rather than importing it:
 *
 * 1. a store with a rendered projection passes;
 * 2. a rule with no surface and no mark is refused, with the id in the message;
 * 3. two rules on one surface that contradict are refused, both ids named;
 * 4. two rules that name each other are refused even across surfaces;
 * 5. a store rule missing from the projection is refused, named;
 * 6. a projection rule the store does not have is refused, named;
 * 7. `--render` writes a file the next run accepts, carrying surface, date and source;
 * 8. a store version this build does not read is refused, both versions named;
 * 9. an entry the reader cannot use is refused with the reason, not skipped;
 * 10. `--render` refuses to write from a store that already has refusals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const GATE = join(ROOT, "scripts", "check-preferences.mjs");

/** A timestamp, not a bare date: the store accepts both and keeps the day. */
const SINCE = "2020-01-02T00:00:00Z";

const RULES = {
  buttons: {
    id: "telegram-buttons-single-word",
    surface: "telegram",
    rule: "Button labels carry a single word, never a description.",
    since: SINCE,
    source: "owner message",
  },
  english: {
    id: "reply-language-english",
    surface: "reply",
    rule: "Write every reply in English.",
    since: SINCE,
    source: "owner message",
  },
  unbound: {
    id: "unbound-no-flattery",
    surface: null,
    unbound: true,
    rule: "Answer without flattery.",
    since: SINCE,
    source: "owner message",
  },
};

/**
 * A braid home with a store in it. Returns the home and a runner bound to it, so
 * a case never reaches the live tree: `braidDir()` honours the pin on every call.
 */
function braidHome(t) {
  const home = mkdtempSync(join(tmpdir(), "preferences-gate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    storePath: join(home, "preferences.json"),
    docPath: join(home, "preferences.md"),
    writeStore(store) {
      writeFileSync(this.storePath, JSON.stringify(store, null, 2), "utf-8");
    },
    writeDoc(text) {
      writeFileSync(this.docPath, text, "utf-8");
    },
    readDoc() {
      return readFileSync(this.docPath, "utf-8");
    },
    run(...args) {
      const result = spawnSync(process.execPath, [GATE, ...args], {
        env: { ...process.env, BRAID_HOME: home },
        encoding: "utf-8",
      });
      return {
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      };
    },
  };
}

/** A store document holding the given entries. */
function storeOf(entries, extra = {}) {
  return { version: 1, entries, ...extra };
}

describe("check-preferences", () => {
  it("passes a store whose projection was rendered from it", (t) => {
    const braid = braidHome(t);
    braid.writeStore(storeOf([RULES.buttons, RULES.english, RULES.unbound]));
    const render = braid.run("--render");
    assert.equal(render.status, 0, `--render must succeed on a clean store: ${render.output}`);
    assert.ok(existsSync(braid.docPath), "--render must write the projection");

    const check = braid.run();
    assert.equal(check.status, 0, `the rendered file must satisfy the gate: ${check.output}`);
    assert.match(check.output, /Preference gate: PASS/);
    assert.match(check.output, /surface telegram: 1 rule/);
    assert.match(check.output, /surface reply: 1 rule/);
  });

  it("refuses a rule with no surface and no mark, naming the id", (t) => {
    const braid = braidHome(t);
    braid.writeStore(
      storeOf([{ ...RULES.unbound, unbound: undefined }, RULES.english]),
    );
    const { status, output } = braid.run();
    assert.equal(status, 1, output);
    assert.match(output, /unbound-without-mark/);
    assert.match(output, new RegExp(RULES.unbound.id));
  });

  it("refuses two rules on one surface that contradict, naming both ids", (t) => {
    const braid = braidHome(t);
    braid.writeStore(
      storeOf([
        { ...RULES.buttons, contradicts: ["telegram-buttons-with-descriptions"] },
        {
          id: "telegram-buttons-with-descriptions",
          surface: "telegram",
          rule: "Buttons carry a label and a one-line description.",
          since: SINCE,
          source: "owner message",
        },
      ]),
    );
    const { status, output } = braid.run();
    assert.equal(status, 1, output);
    assert.match(output, /\[contradiction\]/);
    assert.match(output, /telegram-buttons-single-word/);
    assert.match(output, /telegram-buttons-with-descriptions/);
    assert.match(output, /surface "telegram"/);
  });

  it("refuses a pair that names each other, whatever their surfaces", (t) => {
    const braid = braidHome(t);
    braid.writeStore(
      storeOf([
        { ...RULES.buttons, contradicts: [RULES.english.id] },
        { ...RULES.english, contradicts: [RULES.buttons.id] },
      ]),
    );
    const { status, output } = braid.run();
    assert.equal(status, 1, output);
    assert.match(output, /\[contradiction\]/);
    assert.match(output, new RegExp(RULES.buttons.id));
    assert.match(output, new RegExp(RULES.english.id));
    assert.match(output, /mutual declaration/);
  });

  it("refuses a store rule that is missing from the projection, naming it", (t) => {
    const braid = braidHome(t);
    braid.writeStore(storeOf([RULES.buttons, RULES.english]));
    assert.equal(braid.run("--render").status, 0);
    braid.writeStore(storeOf([RULES.buttons, RULES.english, RULES.unbound]));
    const { status, output } = braid.run();
    assert.equal(status, 1, output);
    assert.match(output, /projection-missing-rule/);
    assert.match(output, new RegExp(RULES.unbound.id));
  });

  it("refuses a projection rule the store does not have, naming it", (t) => {
    const braid = braidHome(t);
    braid.writeStore(storeOf([RULES.buttons]));
    assert.equal(braid.run("--render").status, 0);
    const doc = braid.readDoc();
    const extra = [
      doc.trimEnd(),
      "",
      "## reply",
      "",
      "### `reply-language-english`",
      "",
      "- surface: reply",
      "- rule: Write every reply in English.",
      "- since: 2020-01-02",
      "- source: owner message",
      "",
    ].join("\n");
    braid.writeDoc(extra);
    const { status, output } = braid.run();
    assert.equal(status, 1, output);
    assert.match(output, /projection-extra-rule/);
    assert.match(output, /reply-language-english/);
  });

  it("renders surface, date and source, and the next run accepts the file", (t) => {
    const braid = braidHome(t);
    braid.writeStore(storeOf([RULES.buttons, RULES.unbound]));
    assert.equal(braid.run("--render").status, 0);
    const doc = braid.readDoc();
    assert.match(doc, /## telegram/);
    assert.match(doc, /## no surface \(unbound\)/);
    assert.match(doc, /- surface: telegram/);
    assert.match(doc, /- since: 2020-01-02/);
    assert.match(doc, /- source: owner message/);
    const second = braid.run();
    assert.equal(second.status, 0, `a rendered file must pass without being touched: ${second.output}`);
  });

  it("refuses a store version it does not read, naming both versions", (t) => {
    const braid = braidHome(t);
    braid.writeStore({ version: 7, entries: [] });
    const { status, output } = braid.run();
    assert.equal(status, 1, output);
    assert.match(output, /declares version 7/);
    assert.match(output, /this build reads version 1/);
  });

  it("refuses an entry it cannot use, with the reason", (t) => {
    const braid = braidHome(t);
    braid.writeStore(storeOf([RULES.buttons, { ...RULES.english, rule: "   " }]));
    const { status, output } = braid.run();
    assert.equal(status, 1, output);
    assert.match(output, /entry-unreadable/);
    assert.match(output, new RegExp(RULES.english.id));
    assert.match(output, /missing "rule"/);
    assert.match(output, /1 unreadable entry/);
  });

  it("refuses to render from a store that already has refusals", (t) => {
    const braid = braidHome(t);
    braid.writeStore(storeOf([{ ...RULES.unbound, unbound: undefined }]));
    const { status, output } = braid.run("--render");
    assert.equal(status, 1, output);
    assert.ok(!existsSync(braid.docPath), "a refused render must leave no file behind");
    assert.match(output, /refusing to write a projection/);
  });

  it("passes an empty store with no projection at all", (t) => {
    const braid = braidHome(t);
    braid.writeStore(storeOf([]));
    const { status, output } = braid.run();
    assert.equal(status, 0, output);
    assert.match(output, /surfaces: none/);
    assert.ok(!existsSync(braid.docPath), "the gate never writes a projection on its own");
  });

  it("reports a surface with no rules as none, not as a failure", (t) => {
    const braid = braidHome(t);
    mkdirSync(braid.home, { recursive: true });
    braid.writeStore(storeOf([]));
    braid.writeDoc("# Standing preferences\n");
    const { status, output } = braid.run();
    assert.equal(status, 0, output);
    assert.match(output, /surfaces: none/);
  });
});
