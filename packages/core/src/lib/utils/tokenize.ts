/**
 * The tree's one tokenizer: a token is a maximal run of letters, the marks that
 * decorate them, and digits, in any script.
 *
 * Why one. Every matcher used to spell its own Latin-only split:
 * `/[^a-z0-9]+/` in the skills matcher and the memory read path,
 * `/[a-z][a-z0-9-]{3,}/` for a ruling's topic tags, `\W` in the reasoning
 * metrics. In JavaScript `\W` is `[^A-Za-z0-9_]`, and `[a-z]` is what it says,
 * so a Cyrillic, Greek or Hebrew sentence has no tokens at all at those sites.
 * Each then reports the zero as a fact about the text ("no keywords", "no
 * anchors", "not a topic"), and nothing downstream can tell an empty text from
 * an unreadable one. The alphabet is not a policy a caller can decide, so the
 * split lives here once, over `\p{L}`, `\p{M}` and `\p{N}` with the `u` flag.
 *
 * What this does not do: no stemming, no length threshold, no vocabulary test,
 * no case folding beyond `toLowerCase()`. A caller keeps its own thresholds and
 * filters, so for Latin-script input `tokenize` returns the same runs the old
 * split returned and every score keeps the value it shipped with.
 *
 * The one deliberate difference is `_`. It was a word character to `\W` and a
 * separator to `[^a-z0-9]`, so the same identifier was one token at the
 * reasoning metrics and two at every other site. It is a separator here,
 * because a token is a word and `read_path` is two.
 *
 * Why `\p{M}` sits beside `\p{L}`. A combining mark belongs to the letter it
 * decorates, and the case fold can produce one: `"İstanbul".toLowerCase()` is
 * `i` plus U+0307 COMBINING DOT ABOVE, so a letters-only class tears the word in
 * two ("i", "stanbul"). The same class would tear every Devanagari, Tamil or
 * Thai word at its vowel signs. A mark is therefore part of the run it follows.
 */

/** What a token's script decides: which stop list applies to it. */
type TokenScript = "latin" | "cyrillic" | "other";

const TOKEN = /[\p{L}\p{M}\p{N}]+/gu;
const TOKEN_WITH_HYPHEN = /[\p{L}\p{M}\p{N}-]+/gu;
const CYRILLIC = /\p{Script=Cyrillic}/u;
/** A word carries a letter or a number; a run of bare marks or bare hyphens carries neither. */
const NAMES_SOMETHING = /[\p{L}\p{N}]/u;

export interface TokenizeOptions {
  /**
   * Keep a hyphen that sits inside a run of letters and digits, so that
   * `cross-session` is one token and not two. The run's own leading and
   * trailing hyphens come back with it; a caller that wants a word-shaped
   * token drops them (see the topic-tag read in decision-grammar).
   */
  innerHyphen?: boolean;
}

/**
 * The tokens of a text, lowercased.
 *
 * Pure and total: any input, including an empty string, a string of
 * punctuation or a string of emoji, returns an array, and a string with no
 * letter or digit in it returns an empty one.
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const lowered = String(text ?? "").toLowerCase();
  const runs = lowered.match(options.innerHyphen ? TOKEN_WITH_HYPHEN : TOKEN) ?? [];
  return runs.filter((run) => NAMES_SOMETHING.test(run));
}

/** The script a token is written in, as far as stop-word resolution needs to know. */
function scriptOf(token: string): TokenScript {
  if (CYRILLIC.test(token)) return "cyrillic";
  if (/\p{Script=Latin}/u.test(token)) return "latin";
  return "other";
}

/**
 * The closed-class words of Russian: pronouns in their case forms, the
 * prepositions, the conjunctions and particles, the copula and the future forms
 * of `быть`, the modal predicates, and the deictic adverbs that name no
 * subject.
 *
 * Membership rule, the same one each English list is argued from: a word that
 * can name a subject, an action, an object or a quantity is NOT in the list,
 * however frequent, so `работа`, `проверка`, `сборка` and `тест` are absent
 * while `его`, `через` and `будет` are present. Inflected forms are listed one
 * by one, because the tokenizer does not stem: `книга` and `книги` are both
 * content words and both absent, while `этого` and `этой` are both listed.
 *
 * Source: the closed-class inventory of Russian, enumerated by hand. It is not
 * a frequency list and not a translation of any English list: a corpus list
 * ranks by frequency, and frequency is exactly the signal that puts content
 * words (`работа`, `время`) in a stop list. It answers the same question an
 * English list answers, for a text written in the script the owner types.
 *
 * The sites keep their own length floors (3 and 4 characters), so most entries
 * of one and two letters are unreachable from them; they stay because the list
 * is a statement about the language, not about one caller's floor.
 */
const CYRILLIC_STOP_WORDS: ReadonlySet<string> = new Set([
  // pronouns: personal, possessive, reflexive
  "я",
  "меня",
  "мне",
  "мной",
  "мною",
  "мы",
  "нас",
  "нам",
  "нами",
  "ты",
  "тебя",
  "тебе",
  "тобой",
  "вы",
  "вас",
  "вам",
  "вами",
  "он",
  "его",
  "ему",
  "им",
  "ним",
  "него",
  "она",
  "ее",
  "её",
  "ей",
  "ею",
  "нею",
  "нее",
  "неё",
  "оно",
  "они",
  "их",
  "них",
  "ими",
  "ними",
  "себя",
  "себе",
  "собой",
  "собою",
  // pronouns: possessive
  "свой",
  "своя",
  "свое",
  "своё",
  "свои",
  "своего",
  "своей",
  "своем",
  "своём",
  "своих",
  "своим",
  "своими",
  "мой",
  "моя",
  "мое",
  "моё",
  "мои",
  "моего",
  "моей",
  "моих",
  "моим",
  "наш",
  "наша",
  "наше",
  "наши",
  "нашего",
  "нашей",
  "наших",
  "нашим",
  "ваш",
  "ваша",
  "ваше",
  "ваши",
  "вашего",
  "вашей",
  "ваших",
  "вашим",
  // pronouns: demonstrative and determinative
  "этот",
  "эта",
  "это",
  "эти",
  "этого",
  "этой",
  "этом",
  "этих",
  "этим",
  "этими",
  "тот",
  "та",
  "те",
  "того",
  "той",
  "тех",
  "тем",
  "теми",
  "такой",
  "такая",
  "такое",
  "такие",
  "такого",
  "таких",
  "весь",
  "вся",
  "все",
  "всё",
  "всего",
  "всей",
  "всех",
  "всем",
  "всеми",
  "каждый",
  "каждая",
  "каждое",
  "каждые",
  "каждого",
  "каждой",
  "каждых",
  "любой",
  "любая",
  "любое",
  "любые",
  "другой",
  "другая",
  "другое",
  "другие",
  "другого",
  "других",
  "сам",
  "сама",
  "само",
  "сами",
  "самого",
  "самой",
  "самих",
  // prepositions
  "в",
  "во",
  "на",
  "с",
  "со",
  "к",
  "ко",
  "по",
  "за",
  "из",
  "изо",
  "от",
  "ото",
  "до",
  "для",
  "при",
  "без",
  "безо",
  "под",
  "подо",
  "над",
  "надо",
  "о",
  "об",
  "обо",
  "про",
  "через",
  "между",
  "после",
  "перед",
  "передо",
  "около",
  "кроме",
  "вместо",
  "среди",
  "вокруг",
  "против",
  "мимо",
  "сквозь",
  "вдоль",
  "ради",
  "благодаря",
  "согласно",
  "сверх",
  // conjunctions and particles
  "и",
  "а",
  "но",
  "или",
  "либо",
  "если",
  "что",
  "чтобы",
  "как",
  "когда",
  "пока",
  "ли",
  "бы",
  "же",
  "не",
  "ни",
  "нет",
  "да",
  "вот",
  "вон",
  "только",
  "даже",
  "уже",
  "еще",
  "ещё",
  "ведь",
  "хотя",
  "зато",
  "причем",
  "причём",
  "тоже",
  "также",
  "поэтому",
  "потому",
  "будто",
  "словно",
  "якобы",
  "именно",
  // copula and auxiliary
  "быть",
  "был",
  "была",
  "было",
  "были",
  "буду",
  "будешь",
  "будет",
  "будем",
  "будете",
  "будут",
  "есть",
  // modal predicates
  "можно",
  "нельзя",
  "нужно",
  "нужен",
  "нужна",
  "нужны",
  // deictic and degree adverbs
  "здесь",
  "тут",
  "там",
  "тогда",
  "сейчас",
  "теперь",
  "очень",
  "более",
  "менее",
  "совсем",
  "слишком",
  "почти",
  "просто",
  "снова",
  "опять",
  "всегда",
  "никогда",
]);

/**
 * Is this token a stop word for the script it is written in?
 *
 * `latin` is the caller's own English list, passed in unchanged: each site's
 * list was tuned against its own matcher (one is 97 words, one is 159, the
 * keyword leg's is a third), so collapsing them into one would move three
 * scores at once. A Cyrillic token is tested against the list above. A token in
 * any other script is not a stop word, because no list exists for it: removing
 * nothing is the same answer the English list gave it before, and a script with
 * no list is a gap in coverage rather than a judgement about the word.
 */
export function isStopWord(token: string, latin: ReadonlySet<string>): boolean {
  return scriptOf(token) === "cyrillic" ? CYRILLIC_STOP_WORDS.has(token) : latin.has(token);
}
