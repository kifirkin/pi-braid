/**
 * What the session-start journal pointer says about work still open.
 *
 * The pointer used to be built from a line count alone, so a journal holding a
 * pending install and a journal holding forty closed outcomes printed the same
 * sentence: the seat beginning the day could not tell that something was
 * waiting for it. Naming the open intents costs a sentence in the first prompt
 * of every session, so the whole text keeps a fixed ceiling and gives up detail
 * in a fixed order instead of growing with the journal.
 *
 * Reading is line-level: an entry counts when its `kind` is `intent` and its
 * `status` is `open`. The digest printer derives a subject's status across
 * supersession chains and stays the authority on the full program, so a name
 * here can be an intent a later line retired; against this project's journal
 * when the pointer was written, five of the seven open-status intents were
 * already retired that way. The trade is deliberate and the digest is where a
 * seat confirms what is live: naming work already closed costs a line of
 * attention, while hiding an install nobody was told about is the failure this
 * pointer exists to repair. Honoring the journal's own `supersedes` edges is
 * what would narrow it, and that is one line of selection, not one of wording.
 */

/** Ceiling for the whole pointer text. A line delivered into every session is
 *  paid for by every turn that follows it, so the cost is per session, not per
 *  journal entry. */
export const JOURNAL_PRIOR_BUDGET = 480;

/** Named intents in the text; the rest are counted. Three subjects are about as
 *  many as a reader can carry into the work they were about to start. */
const NAMED_INTENT_LIMIT = 3;

/** Longest subject rendered. The journal writer admits slugs up to 64
 *  characters, so one hostile line would otherwise spend the budget alone. */
const SUBJECT_LIMIT = 32;

const HOUR_MS = 3_600_000;

const DIGEST_COMMAND = "packages/core/scripts/check-journal.mjs --digest";

/** The closing sentence of the pointer when nothing is open. Shown to every
 *  session, so it keeps its exact words. */
const DIGEST_POINTER = `Read the open program before acting (digest printer: ${DIGEST_COMMAND}), so a decision gets superseded, not rediscovered.`;

/** The same printer, said shorter: naming what is open already answers the
 *  question the long form motivates, and the room it frees is what pays for
 *  the names. */
const DIGEST_POINTER_SHORT = `Full program: ${DIGEST_COMMAND}.`;

const CLOSE_SINGLE = "Run the install it names, or close it with the reason it will not run.";
const CLOSE_PLURAL = "Run the install each names, or close it with the reason it will not run.";

/** What the pointer needs from the handler: the line count it always printed,
 *  and the path it names. */
export interface JournalPointerFacts {
  count: number;
  journalFile: string;
}

/** One intent whose `status` says `open`. */
export interface OpenIntent {
  subject: string;
  /** Whole hours since the entry's own `at`; null when that stamp is unusable,
   *  which is reported as no age rather than as a guess. */
  ageHours: number | null;
  /** The entry's `expires_at`, kept only when it parses. A broken stamp is a
   *  missing detail, never a reason to hide the intent behind it. */
  expiresAt: string | null;
  expired: boolean;
}

/**
 * The journal lines that name open work.
 *
 * Anything unreadable is skipped: a line that is not JSON, a value that is not
 * an object, an entry without a usable `subject`, and an `expires_at` that does
 * not parse (the stamp is dropped, the intent is not). A journal is written by
 * a different process and edited by hand, so a reader that throws on the first
 * malformed line would take the whole session-start bundle down with it.
 */
export function selectOpenIntents(journalText: string, now: Date): OpenIntent[] {
  const open: OpenIntent[] = [];
  for (const line of journalText.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseEntry(line);
    if (!entry) continue;
    if (entry.kind !== "intent" || entry.status !== "open") continue;
    const subject = typeof entry.subject === "string" ? entry.subject.trim() : "";
    if (!subject) continue;

    const writtenAt = typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN;
    const expiresAt =
      typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : Number.NaN;

    open.push({
      subject,
      ageHours: Number.isNaN(writtenAt)
        ? null
        : Math.max(0, Math.floor((now.getTime() - writtenAt) / HOUR_MS)),
      expiresAt: Number.isNaN(expiresAt) ? null : (entry.expires_at as string),
      expired: !Number.isNaN(expiresAt) && expiresAt < now.getTime(),
    });
  }
  // The intent whose window already closed is the one a reader has to act on,
  // so it is named before the rest; journal order stands inside each group.
  return [...open.filter((intent) => intent.expired), ...open.filter((intent) => !intent.expired)];
}

/**
 * The journal pointer, complete: the sentence this step has always printed,
 * extended with what is open.
 *
 * With nothing open the result is the original text byte for byte. With work
 * open the count-and-path sentence is kept and the digest printer is restated
 * in its short form: with a 91-character journal path the long form plus one
 * expired intent is 527 characters against the 480 ceiling, and the sentence
 * that motivates reading the journal is the one with room to yield.
 */
export function journalPriorText(
  facts: JournalPointerFacts,
  journalText: string,
  now: Date,
): string {
  const intro = journalIntro(facts);
  const open = selectOpenIntents(journalText, now);
  if (open.length === 0) return `${intro} ${DIGEST_POINTER}`;

  // Detail is given up in order of what a reader needs it for: the name of a
  // waiting install, then the moment its window closes, then the standing
  // pointer to the full program, then the count alone. Dropping the names to
  // keep the pointer would save the cheaper fact and hide the dearer one.
  const ladder = [
    `${intro} ${describeOpen(open, "stamped")} ${DIGEST_POINTER_SHORT}`,
    `${intro} ${describeOpen(open, "plain")} ${DIGEST_POINTER_SHORT}`,
    `${intro} ${describeOpen(open, "stamped")}`,
    `${intro} ${describeOpen(open, "plain")}`,
    `${intro} ${countedSentence(open)} ${DIGEST_POINTER_SHORT}`,
    `${intro} ${countedSentence(open)}`,
    `${intro} ${open.length} open intent${open.length === 1 ? "" : "s"}.`,
  ];
  // Richest description that fits. The last rung is printed rather than
  // dropped when nothing fits: a journal path long enough to spend the ceiling
  // alone is a reason to say less, never a reason to leave a pending install
  // unmentioned.
  return ladder.find((text) => text.length < JOURNAL_PRIOR_BUDGET) ?? ladder[ladder.length - 1];
}

function journalIntro({ count, journalFile }: JournalPointerFacts): string {
  return (
    `The project journal holds ${count} entr${count === 1 ? "y" : "ies"} at ${journalFile} -- ` +
    `what earlier seats decided and why, readable without their sessions.`
  );
}

type Detail = "stamped" | "plain" | "counted";

function describeOpen(open: OpenIntent[], detail: Detail): string {
  if (detail === "counted") return countedSentence(open);
  const withStamp = detail === "stamped";
  return open.length === 1 ? singleSentence(open[0], withStamp) : listSentence(open, withStamp);
}

/** One open intent reads as a sentence: a list of one is a fragment, and the
 *  instruction that follows it addresses a single install. */
function singleSentence(intent: OpenIntent, withStamp: boolean): string {
  const opening = intent.expired
    ? "One intent is still open and EXPIRED"
    : "One intent is still open";
  return `${opening}: ${named(intent)}${roundStamp(intent, withStamp)}. ${CLOSE_SINGLE}`;
}

function listSentence(open: OpenIntent[], withStamp: boolean): string {
  const items = open.slice(0, NAMED_INTENT_LIMIT).map((intent) => listItem(intent, withStamp));
  const rest = open.length - Math.min(open.length, NAMED_INTENT_LIMIT);
  const more = rest > 0 ? `; +${rest} more open` : "";
  return `Open intents: ${items.join("; ")}${more}. ${CLOSE_PLURAL}`;
}

/** The expired marker stays in the lean form: it is the fact a reader acts on,
 *  while the exact moment is one the digest can restate. */
function listItem(intent: OpenIntent, withStamp: boolean): string {
  const expired = intent.expired ? ", EXPIRED" : "";
  if (!withStamp || intent.expiresAt === null) return `${named(intent)}${expired}`;
  return intent.expired
    ? `${named(intent)}, EXPIRED (expires_at ${intent.expiresAt})`
    : `${named(intent)}, expires ${intent.expiresAt}`;
}

/** In the single sentence the opening clause already carries the EXPIRED word,
 *  so this adds the moment alone. */
function roundStamp(intent: OpenIntent, withStamp: boolean): string {
  if (!withStamp || intent.expiresAt === null) return "";
  return intent.expired ? ` (expires_at ${intent.expiresAt})` : ` (expires ${intent.expiresAt})`;
}

function countedSentence(open: OpenIntent[]): string {
  const expired = open.filter((intent) => intent.expired).length;
  const ages = open
    .map((intent) => intent.ageHours)
    .filter((hours): hours is number => hours !== null);
  const oldest = ages.length > 0 ? `, oldest ${Math.max(...ages)}h old` : "";
  const lapsed = expired > 0 ? `, ${expired} EXPIRED` : "";
  const count = `${open.length} open intent${open.length === 1 ? "" : "s"} in this journal`;
  return `${count}${oldest}${lapsed}. ${open.length === 1 ? CLOSE_SINGLE : CLOSE_PLURAL}`;
}

function named(intent: OpenIntent): string {
  const age = intent.ageHours === null ? "" : ` ${intent.ageHours}h old`;
  return `"${clipSubject(intent.subject)}"${age}`;
}

function clipSubject(subject: string): string {
  return subject.length <= SUBJECT_LIMIT ? subject : `${subject.slice(0, SUBJECT_LIMIT - 1)}…`;
}

function parseEntry(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
