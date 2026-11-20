/**
 * Test: prompt-builder/preferences-section.ts - a preference renders on its surface.
 *
 * The section exists because a rule retrieved by association fires only when the
 * incoming text resembles it. Here presence is decided by the tool set, so every
 * case below is about the gate rather than about wording:
 *
 * 1. a rule filed for the Telegram channel renders when the Telegram send tool
 *    is in the session's tool set;
 * 2. the same store with that tool absent renders no Telegram block - asserted
 *    twice, no section named for the surface and no rule text anywhere in the
 *    composition, because a section that renders every rule always passes a
 *    single assertion by accident;
 * 3. a rule bound to nothing renders in one block that is labelled unbound;
 * 4. an empty store renders nothing at all;
 * 5. a store this build cannot read renders nothing and says why (a store read
 *    halfway is worse than a missing one);
 * 6. a rule naming a surface this build has no binding for is reported, not
 *    rendered;
 * 7. the reply surface needs no tool: the prompt is only built for a turn, so
 *    that surface is in play whenever the section runs;
 * 8. entries the store reader could not use are counted, and the usable ones
 *    still render;
 * 9. one line per rule, in store order, on one section per surface.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { preferenceSectionsFrom, PREFERENCES_SECTION_PREFIX, SURFACE_BINDINGS } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "preferences-section.js")
);

const TELEGRAM_TOOL = "telegram_send";
const READ_TOOL = "read";

/** A store entry with the defaults every case needs and the fields it changes. */
function entry(overrides) {
  return {
    id: "rule-id",
    surface: "telegram",
    rule: "the rule text",
    since: "2020-01-02T00:00:00Z",
    source: "owner message",
    ...overrides,
  };
}

/** A store read in the shape the reader returns, with no rejections. */
function store(entries) {
  return { ok: true, path: "/tmp/preferences.json", version: 1, entries, rejected: [] };
}

/** Every rendered section, name and text, so a case can assert on both halves. */
function sectionsFor(read, toolNames) {
  const { sections, report } = preferenceSectionsFrom(read, toolNames);
  return {
    names: sections.map((section) => section.name),
    texts: sections.map((section) => section.render()),
    joined: sections.map((section) => section.render()).join("\n\n"),
    report,
  };
}

describe("preferences-section", () => {
  it("renders a surface the tool set carries", () => {
    const rendered = sectionsFor(
      store([entry({ id: "buttons", rule: "Button labels carry a single word." })]),
      [TELEGRAM_TOOL, READ_TOOL],
    );
    assert.ok(
      rendered.names.includes(`${PREFERENCES_SECTION_PREFIX}telegram`),
      `the telegram section must render when ${TELEGRAM_TOOL} is enabled; got ${rendered.names.join(", ")}`,
    );
    assert.match(rendered.joined, /Button labels carry a single word\./);
    assert.deepEqual(rendered.report.rendered, [{ surface: "telegram", count: 1 }]);
  });

  it("renders no surface the tool set does not carry, and no rule text either", () => {
    const rendered = sectionsFor(
      store([entry({ id: "buttons", rule: "Button labels carry a single word." })]),
      [READ_TOOL],
    );
    assert.ok(
      !rendered.names.includes(`${PREFERENCES_SECTION_PREFIX}telegram`),
      "no section may be named for a surface the session cannot reach",
    );
    assert.ok(
      !rendered.joined.includes("Button labels carry a single word."),
      "a rule the session cannot reach must not appear in any rendered section",
    );
    assert.deepEqual(rendered.report.rendered, []);
    assert.deepEqual(rendered.report.unknownSurfaces, []);
  });

  it("renders a rule bound to nothing in one block labelled unbound", () => {
    const rendered = sectionsFor(
      store([
        entry({ id: "unbound-one", surface: null, unbound: true, rule: "Prefer short answers." }),
        entry({ id: "unbound-two", surface: null, unbound: true, rule: "Name the file being changed." }),
      ]),
      [TELEGRAM_TOOL],
    );
    const unbound = rendered.names.filter((name) => name === `${PREFERENCES_SECTION_PREFIX}unbound`);
    assert.equal(unbound.length, 1, "unbound rules share one block");
    const block = rendered.texts[rendered.names.indexOf(unbound[0])];
    assert.match(block, /Unbound preferences/);
    assert.match(block, /Prefer short answers\./);
    assert.match(block, /Name the file being changed\./);
    assert.equal(rendered.report.unbound, 2);
    assert.deepEqual(rendered.report.rendered, []);
  });

  it("renders nothing for an empty store", () => {
    const rendered = sectionsFor(store([]), [TELEGRAM_TOOL, READ_TOOL]);
    assert.deepEqual(rendered.names, []);
    assert.deepEqual(rendered.texts, []);
  });

  it("renders nothing when the store declares a version this build does not read", () => {
    const rendered = sectionsFor(
      {
        ok: false,
        path: "/tmp/preferences.json",
        error: "declares version 7; this build reads version 1",
      },
      [TELEGRAM_TOOL],
    );
    assert.deepEqual(rendered.names, [], "a store read halfway must not render a part of itself");
    assert.match(rendered.report.storeError, /version 7/);
    assert.match(rendered.report.storeError, /version 1/);
  });

  it("reports a surface no binding names instead of rendering it", () => {
    const rendered = sectionsFor(
      store([
        entry({ id: "known", surface: "telegram", rule: "Button labels carry a single word." }),
        entry({ id: "unknown", surface: "hover-card", rule: "Hover cards stay two lines." }),
      ]),
      [TELEGRAM_TOOL],
    );
    assert.deepEqual(rendered.report.unknownSurfaces, ["hover-card"]);
    assert.ok(!rendered.joined.includes("Hover cards stay two lines."));
    assert.ok(rendered.joined.includes("Button labels carry a single word."));
  });

  it("renders the reply surface with no tools enabled at all", () => {
    const reply = SURFACE_BINDINGS.find((binding) => binding.surface === "reply");
    assert.ok(reply, "the registry must carry the reply surface");
    assert.equal(reply.tools, null, "the reply surface is unconditional by construction");
    const rendered = sectionsFor(
      store([entry({ id: "language", surface: "reply", rule: "Write every reply in English." })]),
      [],
    );
    assert.ok(rendered.names.includes(`${PREFERENCES_SECTION_PREFIX}reply`));
    assert.match(rendered.joined, /Write every reply in English\./);
  });

  it("counts unreadable entries and renders the usable ones", () => {
    const read = store([entry({ id: "usable", rule: "Button labels carry a single word." })]);
    read.rejected = [{ index: 1, id: "broken", reason: 'missing "rule"' }];
    const rendered = sectionsFor(read, [TELEGRAM_TOOL]);
    assert.equal(rendered.report.rejected, 1);
    assert.match(rendered.joined, /Button labels carry a single word\./);
  });

  it("renders one line per rule, in store order, on one section per surface", () => {
    const rendered = sectionsFor(
      store([
        entry({ id: "first", surface: "telegram", rule: "Buttons carry one word." }),
        entry({ id: "second", surface: "reply", rule: "Write every reply in English." }),
        entry({ id: "third", surface: "telegram", rule: "Never put a description in a button." }),
      ]),
      [TELEGRAM_TOOL],
    );
    assert.deepEqual(rendered.names, [
      `${PREFERENCES_SECTION_PREFIX}telegram`,
      `${PREFERENCES_SECTION_PREFIX}reply`,
    ]);
    const telegram = rendered.texts[0].split("\n");
    assert.equal(telegram.length, 3, "one header line and two rule lines");
    assert.match(telegram[1], /Buttons carry one word\./);
    assert.match(telegram[2], /Never put a description in a button\./);
  });
});
