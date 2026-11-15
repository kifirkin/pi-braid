/**
 * The command-shape reader the two `run` instruments share.
 *
 * A bash call is text; the tool takes argv. Reading one into the other is a
 * quote-aware job, and both instruments that measure the tool (the differential
 * control and the corpus census) must do it the same way or their numbers are
 * about different classes. This module holds the reading, and nothing else: it
 * does not decide what is in the class, and it never executes.
 *
 * `firstShellOnlyCharacter` reports the first character bash would act on
 * outside quotes. `tokenize` splits the same way bash splits a simple command:
 * single quotes are literal, double quotes keep backslash escapes, and an
 * unquoted backslash escapes the next character.
 *
 * Test-side only. Not counted by the core runner (test/manual is outside its
 * walked tree).
 */

/**
 * The first character a non-interactive bash would act on outside quotes, or
 * null when the whole command is literal text. `$` is reported for any
 * unquoted dollar, including `$(`: both are expansion to bash.
 */
export function firstShellOnlyCharacter(command) {
  let quote = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === "\\" && quote === '"') {
        index++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\n" || char === "\r") return "newline";
    if (char === "$" || char === "`") return char;
    if (char === "~" || char === "\\") return char;
    if ("|&;<>*?[{".includes(char)) return char;
  }
  return null;
}

/** Quote-aware argv, the way bash would hand it to execve. */
export function tokenize(command) {
  const tokens = [];
  let current = "";
  let started = false;
  let quote = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[++index];
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      current += command[++index];
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started || current !== "") {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current !== "") tokens.push(current);
  return tokens;
}
