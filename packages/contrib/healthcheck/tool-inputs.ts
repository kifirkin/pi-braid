/**
 * Input resolution for healthcheck's `categories` filter.
 *
 * Why this module exists: `Type.Optional(Type.Array(Type.String()))` keeps a
 * blank element, and a bare blank is converted to the one-element array `[""]`.
 * The filter then matched no category name, every `shouldRun` answered false,
 * and the run returned an empty report instead of the documented default set:
 * nothing was tested, and nothing in the output said so.
 *
 * The rule: a blank element names no category, so it is dropped. If nothing
 * named survives the filter, the request is "not provided" and the documented
 * default (every category) applies rather than running nothing. Elements that
 * do name a category are passed through untouched, spelling included.
 */
export function resolveCategories(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const named = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim() !== "",
  );
  return named.length > 0 ? named : undefined;
}
