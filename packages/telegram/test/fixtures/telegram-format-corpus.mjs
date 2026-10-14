/**
 * The adversarial Telegram-format corpus, committed from the fidelity review
 * (WAVE-REVIEW-TELEGRAM-FORMAT-FIDELITY-2026-10-14): the 69 hostile bodies
 * from the review's harness plus the shapes its later probes added (the four
 * remaining crossing pairs, the F2 sentinel shapes, the code-span neutralizer
 * case), the 21-cell `{requested} × {body}` resolution matrix, the live parse
 * verdicts the review recorded for the dialect and nesting probes, and the
 * cap-crossing bodies.
 *
 * `test/corpus-runner.mjs` replays these through the package and asserts every
 * wire chunk the sender would emit is one Telegram accepts; `test/live-html-probe.mjs`
 * re-verifies the checker's verdicts against the live API (opt-in).
 */

/** The 69 hostile bodies from the review harness plus its later probe shapes. */
export const HOSTILE_CASES = [
  // ── delimiter runs ──────────────────────────────────────────────────────
  ["run: ~~x~~ (GFM strike run)", "~~x~~"],
  ["run: ~~~~ (4 tildes)", "~~~~"],
  ["run: ~~~x~~~ (3+3)", "~~~x~~~"],
  ["run: ~x~ (control)", "~x~"],
  ["run: |||x||| (3+3 pipes)", "|||x|||"],
  ["run: ||||x|||| (4+4 pipes)", "||||x||||"],
  ["run: |||| (4 pipes alone)", "||||"],
  ["run: ||a||||b|| (adjacent pairs)", "||a||||b||"],
  ["run: ~a~~b~ (adjacent strike pairs)", "~a~~b~"],
  ["run: ~~x~~ |||y|||", "~~x~~ |||y|||"],
  ["run: ~x~~y~", "~x~~y~"],
  ["run: ~~x~y~~", "~~x~y~~"],

  // ── spaced / operator forms ─────────────────────────────────────────────
  ["spaced: ~ x ~", "~ x ~"],
  ["spaced: 5 ~ 10", "5 ~ 10"],
  ["spaced: cd ~ && ls ~", "cd ~ && ls ~"],
  ["spaced: x ~ y ~ z", "x ~ y ~ z"],
  ["spaced: a || b || c", "a || b || c"],
  ["spaced: cmd || fallback", "cmd || fallback"],
  ["spaced: a ~b~ c ~d~ e", "a ~b~ c ~d~ e"],
  ["spaced: || x ||", "|| x ||"],

  // ── nesting and crossing ────────────────────────────────────────────────
  ["nest: __a ~b~ c__", "__a ~b~ c__"],
  ["nest: ~a __b__ c~", "~a __b__ c~"],
  ["nest: **a ~b~ c**", "**a ~b~ c**"],
  ["nest: ~a **b** c~", "~a **b** c~"],
  ["nest: __a ||b|| c__", "__a ||b|| c__"],
  ["nest: ||a __b__ c||", "||a __b__ c||"],
  ["nest: ~a ||b|| c~", "~a ||b|| c~"],
  ["nest: ||a ~b~ c||", "||a ~b~ c||"],
  ["cross: __a ~b__ c~", "__a ~b__ c~"],
  ["cross: ~a __b~ c__", "~a __b~ c__"],
  ["cross: **a ~b** c~", "**a ~b** c~"],
  ["cross: ~a **b~ c**", "~a **b~ c**"],
  ["cross: __a ||b__ c||", "__a ||b__ c||"],
  ["cross: ||a __b|| c__", "||a __b|| c__"],
  ["adjacent: **a**~b~", "**a**~b~"],
  ["adjacent: ~a~__b__", "~a~__b__"],
  ["adjacent: __a__||b||", "__a__||b||"],

  // ── identifier-like ─────────────────────────────────────────────────────
  ["ident: snake__case__name", "snake__case__name"],
  ["ident: x__y__z", "x__y__z"],
  ["ident: __x__y", "__x__y"],
  ["ident: y__x__", "y__x__"],
  ["ident: a__b__ c__d__ e", "a__b__ c__d__ e"],
  ["ident: foo~~bar~~baz", "foo~~bar~~baz"],

  // ── code spans ──────────────────────────────────────────────────────────
  ["code: `~x~`", "`~x~`"],
  ["code: `||x||`", "`||x||`"],
  ["code: `__x__`", "`__x__`"],
  ["code: `~~x~~`", "`~~x~~`"],
  ["code: ~a `b` c~ (pair wraps span)", "~a `b` c~"],
  ["code: ~a `b~ c` (span into)", "~a `b~ c`"],
  ["code: `a~ b` c~ (span out)", "`a~ b` c~"],
  ["code: **b** `~x~`", "**b** `~x~`"],
  ["code: **b** `**x**` (neutralizer must not rewrite code)", "**b** `**x**`"],
  ["code: sentinel content `\uE0009\uE001`", "`\uE0009\uE001`"],

  // ── author HTML, attributes, tags ───────────────────────────────────────
  ["html: ~a<b>c~", "~a<b>c~"],
  ["html: ||a <i>x</i> b||", "||a <i>x</i> b||"],
  ['html: ~x~ <a href="a~b">y</a>', '~x~ <a href="a~b">y</a>'],
  ["html: __a <b>b</b> c__", "__a <b>b</b> c__"],
  ["html: ~x~ <span>y</span>", "~x~ <span>y</span>"],
  ["html: ~x~ <b>unclosed", "~x~ <b>unclosed"],
  ["html: ||x|| </b>", "||x|| </b>"],
  ['html: ~x~ <a href="a>b">y</a>', '~x~ <a href="a>b">y</a>'],

  // ── sentinel-shaped characters (prior review F2) ────────────────────────
  ["sentinels: **b** \uE0009\uE001", "**b** \uE0009\uE001"],
  ["sentinels: ~x~ \uE0009\uE001", "~x~ \uE0009\uE001"],
  ["sentinels: \uE0029\uE003 ~x~", "\uE0029\uE003 ~x~"],
  ["sentinels: ~\uE0009\uE001~", "~\uE0009\uE001~"],
  ["sentinels: ~y~ &amp;\uE0020\uE003;", "~y~ &amp;\uE0020\uE003;"],
  [
    'sentinels: `c` <a href="\uE0000\uE001">x</a> ~y~',
    '`c` <a href="\uE0000\uE001">x</a> ~y~',
  ],

  // ── unbalanced runs ─────────────────────────────────────────────────────
  ["unbalanced: ~x", "~x"],
  ["unbalanced: x~", "x~"],
  ["unbalanced: ||x|", "||x|"],
  ["unbalanced: |x||", "|x||"],
  ["unbalanced: ~x~~", "~x~~"],
  ["unbalanced: ~~x~", "~~x~"],
  ["unbalanced: ||x|||", "||x|||"],
  ["unbalanced: ~~~", "~~~"],
  ["unbalanced: |||", "|||"],
].map(([name, body]) => ({ name, body }));

/**
 * Lives-verified wires from the review's probe scripts: name, wire text, the
 * parse mode it was probed with, and the verdict Telegram returned
 * (`PARSES` = the message parsed and only the chat was rejected). The corpus
 * test replays the HTML rows through the local checker; the live probe
 * re-queries every row.
 */
export const VERDICT_WIRES = [
  // parse-verdict probe: the new mappings + the failures the review found
  ["control <u>", "<u>x</u>", "HTML", "PARSES"],
  ["control <s>", "<s>x</s>", "HTML", "PARSES"],
  ["control <tg-spoiler>", "<tg-spoiler>x</tg-spoiler>", "HTML", "PARSES"],
  ["control nested <u><s>", "<u>a <s>b</s> c</u>", "HTML", "PARSES"],
  ["control nested <s><code>", "<s>a <code>b</code> c</s>", "HTML", "PARSES"],
  [
    "control u+spoiler",
    "<u>a <tg-spoiler>b</tg-spoiler> c</u>",
    "HTML",
    "PARSES",
  ],
  ["control empty <s></s>", "<s></s>", "HTML", "PARSES"],
  ["cross __a ~b__ c~", "<u>a <s>b</u> c</s>", "HTML", "REJECTED"],
  ["cross ~a __b~ c__", "<s>a <u>b</s> c</u>", "HTML", "REJECTED"],
  ["cross **a ~b** c~", "<b>a <s>b</b> c</s>", "HTML", "REJECTED"],
  ["cross ~a **b~ c**", "<s>a <b>b</s> c</b>", "HTML", "REJECTED"],
  [
    "cross __a ||b__ c||",
    "<u>a <tg-spoiler>b</u> c</tg-spoiler>",
    "HTML",
    "REJECTED",
  ],
  [
    "cross ||a __b|| c__",
    "<tg-spoiler>a <u>b</tg-spoiler> c</u>",
    "HTML",
    "REJECTED",
  ],
  ["f1 ~x~ <b>unclosed", "<s>x</s> <b>unclosed", "HTML", "REJECTED"],
  ["f1 ||x|| </b>", "<tg-spoiler>x</tg-spoiler> </b>", "HTML", "REJECTED"],
  [
    'f1 ~x~ <a href="a>b">y</a>',
    '<s>x</s> <a href="a>b"&gt;y</a>',
    "HTML",
    "REJECTED",
  ],
  ["f1 ~x~ <span>y</span>", "<s>x</s> <span>y</span>", "HTML", "REJECTED"],
  ["f1 ~a<b>c~", "<s>a<b>c</s>", "HTML", "REJECTED"],
  ["f2 ~x~ \\uE0009\\uE001", "<s>x</s> ", "HTML", "PARSES"],
  ["code wrap ~a `b` c~", "<s>a <code>b</code> c</s>", "HTML", "PARSES"],
  // before-probe: the pre-merge texts (what the review says must stay deliverable)
  ["before __a ~b__ c~", "<i>a ~b</i> c~", "HTML", "PARSES"],
  ["before ~a __b~ c__", "~a <i>b~ c</i>", "HTML", "PARSES"],
  ["before **a ~b** c~", "<b>a ~b</b> c~", "HTML", "PARSES"],
  ["before ~x~ <b>unclosed", "~x~ unclosed", "Markdown", "PARSES"],
  ["before ||x|| </b>", "||x|| ", "Markdown", "PARSES"],
  ["before ~x~ \\uE0009\\uE001", "~x~ \uE0009\uE001", "Markdown", "PARSES"],
  ["before **a __b** c__", "<b>a <i>b</b> c</i>", "HTML", "REJECTED"],
  ["before2 ~a **b~ c**", "~a <b>b~ c</b>", "HTML", "PARSES"],
  ["before2 __a ||b__ c||", "<i>a ||b</i> c||", "HTML", "PARSES"],
  ["before2 ||a __b|| c__", "||a <i>b|| c</i>", "HTML", "PARSES"],
  ["before2 ~a ||b~ c||", "~a ||b~ c||", "Markdown", "PARSES"],
  ["before2 ||a ~b|| c~", "||a ~b|| c~", "Markdown", "PARSES"],
  // nest-probe: the nine legitimate mixed nestings the passes produce
  ["nest ~a __b__ c~", "<s>a <u>b</u> c</s>", "HTML", "PARSES"],
  [
    "nest ~a ||b|| c~",
    "<s>a <tg-spoiler>b</tg-spoiler> c</s>",
    "HTML",
    "PARSES",
  ],
  [
    "nest ||a ~b~ c||",
    "<tg-spoiler>a <s>b</s> c</tg-spoiler>",
    "HTML",
    "PARSES",
  ],
  [
    "nest ||a **b** c||",
    "<tg-spoiler>a <b>b</b> c</tg-spoiler>",
    "HTML",
    "PARSES",
  ],
  ["nest ~a **b** c~", "<s>a <b>b</b> c</s>", "HTML", "PARSES"],
  ["nest **a ~b~ c**", "<b>a <s>b</s> c</b>", "HTML", "PARSES"],
  [
    "nest **a ||b|| c**",
    "<b>a <tg-spoiler>b</tg-spoiler> c</b>",
    "HTML",
    "PARSES",
  ],
  ["nest **a __b__ c**", "<b>a <u>b</u> c</b>", "HTML", "PARSES"],
  [
    "nest __a ||b|| c__",
    "<u>a <tg-spoiler>b</tg-spoiler> c</u>",
    "HTML",
    "PARSES",
  ],
  // dialect probe: MarkdownV2 verdicts (no local checker; probe-only)
  ["dialect **bold* (control)", "**bold*", "MarkdownV2", "REJECTED"],
  ["dialect __underline__", "__underline__", "MarkdownV2", "PARSES"],
  ["dialect ~strike~", "~strike~", "MarkdownV2", "PARSES"],
  ["dialect ~~double~~", "~~double~~", "MarkdownV2", "PARSES"],
  ["dialect ~ spaced ~", "~ spaced ~", "MarkdownV2", "PARSES"],
  ["dialect x ~ y ~ z", "x ~ y ~ z", "MarkdownV2", "PARSES"],
  ["dialect a ~ b", "a ~ b", "MarkdownV2", "REJECTED"],
  ["dialect 5 ~ 10", "5 ~ 10", "MarkdownV2", "REJECTED"],
  ["dialect ||spoiler||", "||spoiler||", "MarkdownV2", "PARSES"],
  ["dialect || spaced ||", "|| spaced ||", "MarkdownV2", "PARSES"],
  ["dialect x || y || z", "x || y || z", "MarkdownV2", "PARSES"],
  ["dialect literal tilde tail x~", "x~", "MarkdownV2", "REJECTED"],
  ["dialect single pipe |", "a | b", "MarkdownV2", "REJECTED"],
].map(([name, wire, parseMode, verdict]) => ({
  name,
  wire,
  parseMode,
  verdict,
}));

/** The review's `{requested} × {body}` resolution matrix (21 cells). */
export const MATRIX_BODIES = {
  plain: "deploy finished, 12 tests green",
  mdv2: "**deploy finished** and __12 tests green__",
  strike: "~deploy finished~ and the ~~literal~~ run",
  spoiler: "||deploy finished|| and ||12 tests green||",
  legacy: "*deploy finished* and _12 tests green_",
  mixed: "**deploy finished** <i>12 tests green</i>",
  unbalanced: "**deploy finished",
};

const COUNTS = (kinds) => ({
  bold: 0,
  underline: 0,
  strike: 0,
  spoiler: 0,
  code: 0,
  ...kinds,
});

/** [requested, body key, expected mode, expected text, expected counts|undefined] */
export const MATRIX_CELLS = [
  [undefined, "plain", undefined, MATRIX_BODIES.plain, undefined],
  [
    undefined,
    "mdv2",
    "HTML",
    "<b>deploy finished</b> and <u>12 tests green</u>",
    COUNTS({ bold: 1, underline: 1 }),
  ],
  [
    undefined,
    "strike",
    "HTML",
    "<s>deploy finished</s> and the ~~literal~~ run",
    COUNTS({ strike: 1 }),
  ],
  [
    undefined,
    "spoiler",
    "HTML",
    "<tg-spoiler>deploy finished</tg-spoiler> and <tg-spoiler>12 tests green</tg-spoiler>",
    COUNTS({ spoiler: 2 }),
  ],
  [undefined, "legacy", undefined, MATRIX_BODIES.legacy, undefined],
  [
    undefined,
    "mixed",
    "HTML",
    "<b>deploy finished</b> <i>12 tests green</i>",
    COUNTS({ bold: 1 }),
  ],
  [undefined, "unbalanced", undefined, MATRIX_BODIES.unbalanced, undefined],
  ["Markdown", "plain", "Markdown", MATRIX_BODIES.plain, undefined],
  [
    "Markdown",
    "mdv2",
    "HTML",
    "<b>deploy finished</b> and <u>12 tests green</u>",
    COUNTS({ bold: 1, underline: 1 }),
  ],
  [
    "Markdown",
    "strike",
    "HTML",
    "<s>deploy finished</s> and the ~~literal~~ run",
    COUNTS({ strike: 1 }),
  ],
  [
    "Markdown",
    "spoiler",
    "HTML",
    "<tg-spoiler>deploy finished</tg-spoiler> and <tg-spoiler>12 tests green</tg-spoiler>",
    COUNTS({ spoiler: 2 }),
  ],
  ["Markdown", "legacy", "Markdown", MATRIX_BODIES.legacy, undefined],
  [
    "Markdown",
    "mixed",
    "HTML",
    "<b>deploy finished</b> <i>12 tests green</i>",
    COUNTS({ bold: 1 }),
  ],
  ["Markdown", "unbalanced", undefined, MATRIX_BODIES.unbalanced, undefined],
  ["HTML", "plain", "HTML", MATRIX_BODIES.plain, undefined],
  [
    "HTML",
    "mdv2",
    "HTML",
    "<b>deploy finished</b> and <u>12 tests green</u>",
    COUNTS({ bold: 1, underline: 1 }),
  ],
  [
    "HTML",
    "strike",
    "HTML",
    "<s>deploy finished</s> and the ~~literal~~ run",
    COUNTS({ strike: 1 }),
  ],
  [
    "HTML",
    "spoiler",
    "HTML",
    "<tg-spoiler>deploy finished</tg-spoiler> and <tg-spoiler>12 tests green</tg-spoiler>",
    COUNTS({ spoiler: 2 }),
  ],
  ["HTML", "legacy", "HTML", "*deploy finished* and 12 tests green", undefined],
  [
    "HTML",
    "mixed",
    "HTML",
    "<b>deploy finished</b> <i>12 tests green</i>",
    COUNTS({ bold: 1 }),
  ],
  ["HTML", "unbalanced", "HTML", MATRIX_BODIES.unbalanced, undefined],
];

/**
 * Cap-crossing bodies (R2: converted bodies split inside tags; F8: a converted
 * body crosses a configured cap). Each entry names the wire contract the
 * runner asserts against the capturing client — never against the stub's
 * return value.
 */
export const CAP_CASES = [
  {
    name: "R2 strike 4094 (rendered 4101)",
    params: { text: "~" + "x".repeat(4092) + "~", parse_mode: "Markdown" },
    deps: {},
    expect: {
      // Refused conversion: the authored body ships verbatim as one message.
      sends: 1,
      parseMode: "Markdown",
      maxChars: 4096,
      mode: "conversion-refused",
      htmlValid: false,
    },
  },
  {
    name: "R2 spoiler 4094 (rendered 4109)",
    params: { text: "||" + "x".repeat(4090) + "||", parse_mode: "Markdown" },
    deps: {},
    expect: {
      sends: 1,
      parseMode: "Markdown",
      maxChars: 4096,
      mode: "conversion-refused",
      htmlValid: false,
    },
  },
  {
    name: "R2 underline 4096 (rendered 4103)",
    params: { text: "__" + "x".repeat(4092) + "__", parse_mode: "Markdown" },
    deps: {},
    expect: {
      sends: 1,
      parseMode: "Markdown",
      maxChars: 4096,
      mode: "conversion-refused",
      htmlValid: false,
    },
  },
  {
    name: "R2 bold 4094 (rendered 4101)",
    params: { text: "**" + "x".repeat(4090) + "**", parse_mode: "Markdown" },
    deps: {},
    expect: {
      sends: 1,
      parseMode: "Markdown",
      maxChars: 4096,
      mode: "conversion-refused",
      htmlValid: false,
    },
  },
  {
    name: "R2 rich pair wrapping a long body (4096-cap tag-aware chunks)",
    params: {
      text: "**" + "y".repeat(9000) + "**",
      rich: true,
      parse_mode: "Markdown",
    },
    deps: {},
    expect: {
      minSends: 3,
      parseMode: "HTML",
      maxChars: 4096,
      mode: "tag-aware-chunks",
      htmlValid: true,
    },
  },
  {
    name: "R2 rich body whose tags nest (tag-aware chunks keep every chunk valid)",
    params: {
      text: "**" + "a".repeat(3000) + " __" + "b".repeat(3000) + "__" + " c**",
      rich: true,
      parse_mode: "Markdown",
    },
    deps: {},
    expect: {
      minSends: 2,
      parseMode: "HTML",
      maxChars: 4096,
      mode: "tag-aware-chunks",
      htmlValid: true,
    },
  },
  {
    name: "R2 raised limit keeps HTML chunks valid across Telegram's 4096",
    params: {
      text: "**" + "z".repeat(6000) + "**",
      limit: 7000,
      parse_mode: "Markdown",
    },
    deps: {},
    expect: {
      minSends: 2,
      parseMode: "HTML",
      maxChars: 4096,
      mode: "tag-aware-chunks",
      htmlValid: true,
    },
  },
  {
    name: "F8 strike 297 authored → 302 rendered under sendMaxChars 300",
    params: { text: "~" + "x".repeat(295) + "~" },
    deps: { sendMaxChars: 300 },
    expect: {
      sends: 1,
      parseMode: undefined,
      maxChars: 300,
      mode: "conversion-refused",
      htmlValid: false,
    },
  },
  {
    name: "F8 spoiler 297 authored → 315 rendered under sendMaxChars 300",
    params: { text: "||" + "x".repeat(293) + "||" },
    deps: { sendMaxChars: 300 },
    expect: {
      sends: 1,
      parseMode: undefined,
      maxChars: 300,
      mode: "conversion-refused",
      htmlValid: false,
    },
  },
  {
    name: "F8 underline 297 authored → 302 rendered under sendMaxChars 300",
    params: { text: "__" + "x".repeat(295) + "__" },
    deps: { sendMaxChars: 300 },
    expect: {
      sends: 1,
      parseMode: undefined,
      maxChars: 300,
      mode: "conversion-refused",
      htmlValid: false,
    },
  },
  {
    name: "cap: a converted body inside the cap still converts (control)",
    params: { text: "~" + "x".repeat(200) + "~" },
    deps: { sendMaxChars: 300 },
    expect: {
      sends: 1,
      parseMode: "HTML",
      maxChars: 300,
      mode: "converted",
      htmlValid: true,
    },
  },
];

/**
 * The checker calibration corpus: every case was sent to the live API with
 * `parse_mode: "HTML"` (undeliverable chat id; parse verdicts precede chat
 * validation) and its verdict recorded. The corpus test replays the verdicts
 * against the local checker; the live probe re-queries them.
 */
export const HTML_PARSE_CASES = [
  ["<b>x</b>", "<b>x</b>", "PARSES"],
  ["nested u>s", "<u>a <s>b</s> c</u>", "PARSES"],
  ["nested s>spoiler", "<s>a <tg-spoiler>b</tg-spoiler> c</s>", "PARSES"],
  ["same tag nested", "<b><b>x</b></b>", "PARSES"],
  ["span tg-spoiler", '<span class="tg-spoiler">x</span>', "PARSES"],
  ["span no class", "<span>x</span>", "REJECTED"],
  ["span other class", '<span class="other">x</span>', "REJECTED"],
  ["span single quotes", "<span class='tg-spoiler'>x</span>", "PARSES"],
  ["a href double", '<a href="https://x">y</a>', "PARSES"],
  ["a href single", "<a href='https://x'>y</a>", "PARSES"],
  ["a href unquoted", "<a href=https://x>y</a>", "REJECTED"],
  ["a href empty", '<a href="">y</a>', "PARSES"],
  ["a href with > inside", '<a href="a>b">y</a>', "PARSES"],
  ["a without href", "<a>y</a>", "PARSES"],
  ["a nested a", '<a href="x"><a href="y">z</a></a>', "PARSES"],
  ["b with attr", '<b class="x">y</b>', "PARSES"],
  ["u with attr", '<u class="x">y</u>', "PARSES"],
  ["code", "<code>x</code>", "PARSES"],
  ["code language class", '<code class="language-python">x</code>', "PARSES"],
  ["code other class", '<code class="other">x</code>', "PARSES"],
  ["pre", "<pre>x</pre>", "PARSES"],
  [
    "pre+code language",
    '<pre><code class="language-python">x</code></pre>',
    "PARSES",
  ],
  ["code+pre", "<code><pre>x</pre></code>", "PARSES"],
  ["blockquote", "<blockquote>x</blockquote>", "PARSES"],
  [
    "blockquote nested",
    "<blockquote><blockquote>x</blockquote></blockquote>",
    "PARSES",
  ],
  ["tg-emoji", '<tg-emoji emoji-id="123">x</tg-emoji>', "PARSES"],
  ["tg-emoji unquoted", "<tg-emoji emoji-id=123>x</tg-emoji>", "PARSES"],
  ["tg-emoji no id", "<tg-emoji>x</tg-emoji>", "REJECTED"],
  ["tg-emoji id abc", '<tg-emoji emoji-id="abc">x</tg-emoji>', "REJECTED"],
  ["tg-emoji id empty", '<tg-emoji emoji-id="">x</tg-emoji>', "REJECTED"],
  ["tg-emoji id single", "<tg-emoji emoji-id='123'>x</tg-emoji>", "PARSES"],
  ["tg-emoji other attr", '<tg-emoji id="123">x</tg-emoji>', "REJECTED"],
  [
    "strong/em/ins/del/strike",
    "<strong>a</strong><em>b</em><ins>c</ins><del>d</del><strike>e</strike><i>f</i>",
    "PARSES",
  ],
  ["uppercase tags", "<B>x</B>", "PARSES"],
  ["mixed case close", "<B>x</b>", "PARSES"],
  ["space in tag", "<b >x</b >", "PARSES"],
  ["space close", "<b></b >", "PARSES"],
  ["crossing tags", "<u>a <s>b</u> c</s>", "REJECTED"],
  ["unclosed b", "<b>x", "REJECTED"],
  ["unexpected close", "</b>", "REJECTED"],
  ["unclosed then close other", "<b>x</u>", "REJECTED"],
  ["tg-spoiler crossing", "<tg-spoiler>a <b>b</tg-spoiler> c</b>", "REJECTED"],
  ["entity amp", "a &amp; b", "PARSES"],
  ["entity numeric", "a &#65; b", "PARSES"],
  ["entity hex", "a &#x41; b", "PARSES"],
  ["entity nbsp", "a &nbsp; b", "PARSES"],
  ["entity unknown", "a &unknown; b", "PARSES"],
  ["bare amp", "a & b", "PARSES"],
  ["bare amp semi", "a &; b", "PARSES"],
  ["stray lt mid text", "a < b", "REJECTED"],
  ["dangling lt", "a <b", "REJECTED"],
  ["stray gt", "a > b", "PARSES"],
  ["lt then invalid tag name", "a <1b> c", "REJECTED"],
  ["self closing br", "a<br>b", "REJECTED"],
  ["comment", "a<!-- c -->b", "REJECTED"],
  ["span class + extra", '<span class="tg-spoiler" x="1">x</span>', "PARSES"],
  ["span extra + class", '<span x="1" class="tg-spoiler">x</span>', "PARSES"],
  [
    "span class two values",
    '<span class="tg-spoiler other">x</span>',
    "REJECTED",
  ],
  ["a href + extra attr", '<a href="x" y="1">y</a>', "PARSES"],
  ["a href mixed quote", "<a href='a\"b'>y</a>", "PARSES"],
  ["a href apostrophe", '<a href="a\'b">y</a>', "PARSES"],
  ["a href newline in value", '<a href="a\nb">y</a>', "PARSES"],
  ["b newline in tag", '<b\nclass="x">y</b>', "PARSES"],
  ["pre class language", '<pre class="language-python">x</pre>', "PARSES"],
  ["blockquote attr", '<blockquote class="x">x</blockquote>', "PARSES"],
  ["tg-spoiler attr", '<tg-spoiler class="x">x</tg-spoiler>', "PARSES"],
  ["self closing b", "<b/>", "REJECTED"],
  ["unknown tag pair", "<foo>x</foo>", "REJECTED"],
  ["empty tag", "<>", "REJECTED"],
  ["lt space gt", "< >", "REJECTED"],
  ["code nested code", "<code><code>x</code></code>", "PARSES"],
  ["pre nested pre", "<pre><pre>x</pre></pre>", "PARSES"],
  ["a wraps spoiler", '<a href="x"><tg-spoiler>y</tg-spoiler></a>', "PARSES"],
  ["code wraps a", '<code><a href="x">y</a></code>', "PARSES"],
  ["a wraps code", '<a href="x"><code>y</code></a>', "PARSES"],
  ["entity hex zz", "a &#xZZ; b", "PARSES"],
  ["entity huge", "a &#999999999; b", "PARSES"],
  ["attr no value", "<b x>y</b>", "PARSES"],
  ["attr empty name", '<b ="x">y</b>', "REJECTED"],
  ["attr no value eq", "<b class=>y</b>", "PARSES"],
  ["uppercase close space", "<B >x</B>", "PARSES"],
  ["gt inside attr double", '<b class="a>b">y</b>', "PARSES"],
  ["lt inside attr double", '<b class="a<b">y</b>', "PARSES"],
  ["quote inside attr", '<b class="a\\"b">y</b>', "REJECTED"],
  ["unclosed quote attr", '<b class="x>y</b>', "REJECTED"],
  ["a href unquoted plain", "<a href=xyz>y</a>", "PARSES"],
  [
    "span nested in span",
    '<span class="tg-spoiler"><span class="tg-spoiler">x</span></span>',
    "PARSES",
  ],
].map(([name, body, verdict]) => ({ name, body, verdict }));

/**
 * Cases whose delivered wire legitimately changes against the pre-wave
 * baseline, with the reason. The runner asserts the observed diff set equals
 * exactly this list — a fidelity change outside it is a regression, and a
 * changed case that stops changing means the fix regressed to the old
 * behaviour. `modes` lists the requested modes whose wire changed.
 */
export const EXPECTED_FIDELITY_CHANGES = [
  {
    name: "cross: __a ~b__ c~",
    modes: ["none", "Markdown", "HTML"],
    reason: "R1: crossing pair no longer converges to invalid HTML",
  },
  {
    name: "cross: ~a __b~ c__",
    modes: ["none", "Markdown", "HTML"],
    reason: "R1",
  },
  {
    name: "cross: **a ~b** c~",
    modes: ["none", "Markdown", "HTML"],
    reason: "R1",
  },
  {
    name: "cross: ~a **b~ c**",
    modes: ["none", "Markdown", "HTML"],
    reason: "R1",
  },
  {
    name: "cross: __a ||b__ c||",
    modes: ["none", "Markdown", "HTML"],
    reason: "R1",
  },
  {
    name: "cross: ||a __b|| c__",
    modes: ["none", "Markdown", "HTML"],
    reason: "R1",
  },
  {
    name: "html: ~a<b>c~",
    modes: ["none", "Markdown", "HTML"],
    reason: "F1: interleaved author tag refuses the conversion",
  },
  {
    name: "html: ~x~ <span>y</span>",
    modes: ["none", "Markdown", "HTML"],
    reason: "F1: span without tg-spoiler refuses the conversion",
  },
  {
    name: "html: ~x~ <b>unclosed",
    modes: ["none", "Markdown", "HTML"],
    reason: "F1: unbalanced author tag refuses the conversion",
  },
  {
    name: "html: ||x|| </b>",
    modes: ["none", "Markdown", "HTML"],
    reason: "F1: stray end tag refuses the conversion",
  },
  {
    name: 'html: ~x~ <a href="a>b">y</a>',
    modes: ["none", "Markdown", "HTML"],
    reason: "F1: quote-aware tag keeps the valid attribute intact",
  },
  {
    name: "code: **b** `**x**` (neutralizer must not rewrite code)",
    modes: ["none", "Markdown", "HTML"],
    reason: "F3: code-span content is exempt from neutralization",
  },
  {
    name: "sentinels: **b** \uE0009\uE001",
    modes: ["none", "Markdown", "HTML"],
    reason: "F2: author characters survive",
  },
  {
    name: "sentinels: ~x~ \uE0009\uE001",
    modes: ["none", "Markdown", "HTML"],
    reason: "F2",
  },
  {
    name: "sentinels: \uE0029\uE003 ~x~",
    modes: ["none", "Markdown", "HTML"],
    reason: "F2",
  },
  {
    name: "sentinels: ~\uE0009\uE001~",
    modes: ["none", "Markdown", "HTML"],
    reason: "F2",
  },
  {
    name: "sentinels: ~y~ &amp;\uE0020\uE003;",
    modes: ["none", "Markdown", "HTML"],
    reason: "F2: no substitution of a forged slot reference",
  },
  {
    name: 'sentinels: `c` <a href="\uE0000\uE001">x</a> ~y~',
    modes: ["none", "Markdown", "HTML"],
    reason: "F2: no cross-scan of a restored attribute",
  },
].map((entry) => ({
  ...entry,
  modes: entry.modes.map((m) => (m === "none" ? undefined : m)),
}));
