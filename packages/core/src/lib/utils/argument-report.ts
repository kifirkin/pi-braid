/**
 * Tool-argument refusal text.
 *
 * pi validates a tool call against its schema and reports the failure in
 * schema terms: an out-of-list value says "must be equal to one of the allowed
 * values", a missing required field says "must have required properties
 * decision". Neither names the values, so the model that guessed one learns
 * nothing it can act on and guesses again.
 *
 * The accepted values, and the sentence explaining a required field, are
 * already in the schema. This module reads them from there at the moment the
 * refusal is built: no list is written twice, so no copy can drift from the
 * one the validator enforces.
 *
 * Seat: a tool's `prepareArguments`. pi calls it first, inside the same
 * guarded block as its own schema validation, so a throw here is what the
 * model reads — and the schema stays exactly as strict as it was. The checks
 * below are equivalences, not relaxations: a call refused here is one pi would
 * have refused too, only with a message the model can use.
 *
 * Scope is the top level of the argument object. A nested list is left to pi
 * rather than described from a guess about its parent.
 */

/** A schema node, as far as this module needs to read it. */
interface SchemaNode {
  const?: unknown;
  enum?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  description?: unknown;
  properties?: unknown;
  required?: unknown;
  [keyword: string]: unknown;
}

function nodeOf(value: unknown): SchemaNode | undefined {
  return value && typeof value === "object" ? (value as SchemaNode) : undefined;
}

/**
 * The values a schema node accepts, read from the node.
 *
 * A single-valued node (`const`, which is what `Type.Literal` builds) yields
 * one value; an `enum` yields its list; a union of those yields all of them.
 * A node that constrains nothing yields no values, and the caller then leaves
 * the message to pi.
 */
export function acceptedValues(node: unknown): string[] {
  const schema = nodeOf(node);
  if (!schema) return [];
  if (typeof schema.const === "string") return [schema.const];
  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === "string")) {
    return [...new Set(schema.enum as string[])];
  }
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (!branches) return [];
  return [...new Set(branches.flatMap((branch) => acceptedValues(branch)))];
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/**
 * Throw the refusal a model can act on, when this module can say more than the
 * validator does. Returns silently otherwise, leaving pi's own message intact.
 *
 * `schema` is the same object the tool declares as its `parameters`, and
 * `args` the arguments the call carried.
 */
export function checkArgumentValues(toolName: string, schema: unknown, args: unknown): void {
  const root = nodeOf(schema);
  const properties = nodeOf(root?.properties);
  const input = nodeOf(args);
  if (!root || !properties || !input) return;

  // A required field with a stated purpose: say both, once.
  if (Array.isArray(root.required)) {
    for (const key of root.required) {
      if (typeof key !== "string") continue;
      const value = (input as Record<string, unknown>)[key];
      if (value !== undefined && value !== null) continue;
      const purpose = nodeOf(properties[key])?.description;
      if (typeof purpose !== "string" || purpose.length === 0) continue;
      throw new Error(`${toolName}: ${key} is required (${purpose})`);
    }
  }

  // A value outside its declared list: name the list.
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    const values = acceptedValues(properties[key]);
    if (values.length === 0 || values.includes(raw)) continue;
    throw new Error(
      `${toolName}: ${key} ${quoted(raw)} is not accepted. Accepted: ${values
        .map(quoted)
        .join(", ")}`,
    );
  }
}
