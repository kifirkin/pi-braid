/**
 * Extract a JSON object or array from a free-form LLM response.
 *
 * LLMs wrap JSON in three ways:
 *   1. Markdown code blocks: ```json ... ```
 *   2. Leading prose / explanations before the JSON starts
 *   3. Trailing prose / explanations after the JSON ends
 *
 * The trailing-prose trim is the subtle part: we can't just use
 * `lastIndexOf("}")` because a JSON string value may legitimately
 * contain a `}` character (e.g. `{"key": "a}b"}`). Instead we walk
 * the string tracking string context (with backslash-escape handling)
 * and depth, returning the substring from the opening bracket to the
 * matching closing bracket.
 *
 * Returns null if no balanced JSON object/array is found.
 *
 * Lives in lib/utils/ so every consumer (e.g. the metacognition verify
 * handler) uses the same robust extractor instead of duplicating the
 * algorithm.
 */
export function extractJson(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;

  let s = raw;

  // 1. Strip markdown code block wrapper if present.
  const codeBlock = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock?.[1]) {
    s = codeBlock[1];
  }

  // 2. Find the first opening bracket (object or array).
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{" || ch === "[") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  s = s.slice(start);

  // 3. Walk forward, respecting string contexts, to find the matching
  //    closing bracket. Handles:
  //    - String literals with escape sequences ("a\"b")
  //    - Nested objects and arrays
  //    - Trailing prose after the JSON
  const openCh = s[0];
  const closeCh = openCh === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      // Inside a string literal: only the closing unescaped quote ends it.
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === openCh) {
      depth++;
    } else if (ch === closeCh) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;
  const jsonStr = s.slice(0, end + 1).trim();
  if (jsonStr.length < 2) return null;
  return jsonStr;
}
