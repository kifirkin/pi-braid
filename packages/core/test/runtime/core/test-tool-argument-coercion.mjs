/**
 * Tool-argument validation: one contract for both schema vocabularies.
 *
 * WHY THIS EXISTS:
 *   pi validates a model's tool-call arguments before any handler runs. Which
 *   vocabulary braid declares a tool with decided which coercion the arguments
 *   got: a TypeBox tool accepted `tags: "solo"` for a `string[]` field, a
 *   hand-written JSON Schema refused the same call. A model that sends one
 *   value where the schema says array therefore succeeded or failed on a
 *   property of braid's declaration, not on its call.
 *
 * WHAT THIS GATES:
 *   The same cases through both vocabularies produce the same arguments or the
 *   same refusal, and the refusal is the shape the model reads: the dotted
 *   path to the field and a reason, under a header naming the tool, followed
 *   by the arguments it sent.
 *     - a numeric string into a `number` field arrives as a number;
 *     - a single value into an array field arrives as a one-element array;
 *     - a null for an optional field is dropped, not delivered;
 *     - a missing required field is refused at its own path and the field's
 *       name appears once in that line: the path already says it;
 *     - a value of the wrong kind inside an array is refused at its index, so
 *       coercion never turns a type error into a silent pass.
 *
 * HOW THIS DRIVES THE REAL PATH:
 *   The framework's own `validateToolArguments`, the function the agent loop
 *   calls before a tool runs. Nothing is stubbed: one tool carries a plain
 *   JSON Schema object, the other a real TypeBox schema, and both are handed
 *   the tool-call envelope a provider response produces.
 *
 * Run: node test/runtime/core/test-tool-argument-coercion.mjs
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Type } from "typebox";

/**
 * A plain JSON Schema tool: no TypeBox kind symbol anywhere on it. This is the
 * declaration shape an MCP server's schema arrives in.
 */
const plainTool = {
  name: "plain",
  parameters: {
    type: "object",
    properties: {
      count: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
      text: { type: "string" },
      nested: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: { oldText: { type: "string" } },
              required: ["oldText"],
            },
          },
        },
      },
    },
    required: ["text"],
  },
};

/** The same declaration built with braid's own builder, for the parity legs. */
const typeboxTool = {
  name: "boxed",
  parameters: Type.Object({
    count: Type.Optional(Type.Number()),
    tags: Type.Optional(Type.Array(Type.String())),
    text: Type.String(),
    nested: Type.Optional(
      Type.Object({
        edits: Type.Optional(
          Type.Array(Type.Object({ oldText: Type.String() })),
        ),
      }),
    ),
  }),
};

/** The validated arguments, or the message the model would read. */
function validate(tool, args) {
  try {
    return { ok: true, value: validateToolArguments(tool, { name: tool.name, arguments: args }) };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

/** The `  - <path>: <reason>` lines of a refusal, in order. */
function refusalLines(message) {
  return message
    .split("\n")
    .filter((line) => line.startsWith("  - "))
    .map((line) => line.slice(4));
}

describe("tool-argument coercion", () => {
  for (const [vocabulary, tool] of [
    ["plain JSON Schema", plainTool],
    ["TypeBox", typeboxTool],
  ]) {
    it(`${vocabulary}: a numeric string arrives as a number`, () => {
      const result = validate(tool, { text: "hi", count: "42" });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.value.count, 42);
      assert.equal(typeof result.value.count, "number");
    });

    it(`${vocabulary}: a single value arrives as a one-element array`, () => {
      const result = validate(tool, { text: "hi", tags: "solo" });
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(result.value.tags, ["solo"]);
    });

    it(`${vocabulary}: a null for an optional field is dropped`, () => {
      const result = validate(tool, { text: "hi", count: null });
      assert.equal(result.ok, true, result.message);
      assert.equal("count" in result.value, false);
    });

    it(`${vocabulary}: a missing required field is refused at its own path, named once`, () => {
      const result = validate(tool, { count: 1 });
      assert.equal(result.ok, false);
      assert.equal(refusalLines(result.message).length, 1);
      const [line] = refusalLines(result.message);
      const [path, ...reason] = line.split(": ");
      assert.equal(path, "text");
      assert.ok(reason.join(": ").length > 0, `no reason in "${line}"`);
      // The path is the field; a reason that repeats the field name makes the
      // model read the same word twice and leaves less room for the why.
      assert.equal(
        line.split("text").length - 1,
        1,
        `the field name appears twice in "${line}"`,
      );
    });
  }
});

describe("refusal shape", () => {
  it("names the tool, then one indented line per error, then the arguments", () => {
    const result = validate(plainTool, { count: 1 });
    assert.equal(result.ok, false);
    const lines = result.message.split("\n");
    assert.equal(lines[0], 'Validation failed for tool "plain":');
    assert.match(lines[1], /^ {2}- \S.*: .+$/);
    assert.equal(lines[2], "");
    assert.equal(lines[3], "Received arguments:");
    assert.deepEqual(JSON.parse(lines.slice(4).join("\n")), { count: 1 });
  });

  it("reaches a required field inside an array with a dotted index path", () => {
    const result = validate(plainTool, { text: "hi", nested: { edits: [{ n: 1 }] } });
    assert.equal(result.ok, false);
    const [line] = refusalLines(result.message);
    const [path] = line.split(": ");
    assert.equal(path, "nested.edits.0.oldText");
  });

  it("refuses a wrong-kind value inside an array at its index", () => {
    const result = validate(plainTool, { text: "hi", tags: { not: "a string" } });
    assert.equal(result.ok, false);
    const [path] = refusalLines(result.message)[0].split(": ");
    // The value was still not accepted as a string: coercion moved the refusal
    // from the field to the element, it did not swallow it.
    assert.equal(path, "tags.0");
  });

  it("reports each missing required field as its own line", () => {
    const twoRequired = {
      name: "two",
      parameters: {
        type: "object",
        properties: { first: { type: "string" }, second: { type: "string" } },
        required: ["first", "second"],
      },
    };
    const result = validate(twoRequired, {});
    assert.equal(result.ok, false);
    const paths = refusalLines(result.message).map((line) => line.split(": ")[0]);
    assert.deepEqual(paths, ["first", "second"]);
  });
});
