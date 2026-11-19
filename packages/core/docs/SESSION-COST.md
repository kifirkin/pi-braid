<!-- status: current -->

# Session cost: the tokens a session spent, by class and by tool

`packages/core/scripts/session-cost-report.mjs` reads one pi session file and
answers three questions a budget owner asks before any style question: which
token class the money went into, which tool bought it, and what that costs at
rates the caller supplies. It ships no tariff and reads no recorded cost.

```bash
npm run report:session-cost -- --file <path> --rate-in 3 --rate-cache-read 0.3 --rate-out 15
```

## The four classes are disjoint, and that is load-bearing

Every assistant message pi-core writes carries `message.usage` with `input`,
`cacheRead`, `cacheWrite`, `output`, and `totalTokens`. `input` counts the prompt
tokens served _uncached_; `cacheRead` counts the ones served from the cache;
`cacheWrite` counts the ones written into it. `totalTokens` is their sum, and two
readings in pi-core confirm the classes do not overlap:

- `dist/models.js` sizes a prompt as `usage.input + usage.cacheRead + usage.cacheWrite`,
  and `dist/utils/overflow.js` measures a full context window as `input + cacheRead`.
- `dist/api/openai-completions.js` sets `input = prompt_tokens - cached_tokens - cache_write_tokens`,
  because OpenAI's `prompt_tokens` counts the cached part while Anthropic's
  `input_tokens` does not. The harness normalizes to the narrower meaning. <!-- doc-ref-exempt: Anthropic's API field name, not a symbol in this repository -->

A reader that treated `input` as inclusive would double-count every cached token,
which is most of them in a long session. `cacheWrite` is reported as a fourth
class for the same reason: it is nonzero on providers that bill cache creation,
and a report that dropped it would print a total that is not the sum of the rows
above it. The census below has a session writing 3.4M of them.

## The attribution rule, stated so it can be checked

No file records which tool bought which tokens. The rule this reader applies:

1. Each assistant message's usage is charged to the **tool results that entered
   the context since the previous assistant message**, in file order.
2. Inside that window, the split is **proportional to the characters each tool's
   result contributed**. A tool that returned 300 characters takes three quarters
   of a window it shares with one that returned 100.
3. A window with no tool result is the `(prompt)` row. The user turn and the
   system prompt bought those tokens, and putting them in a tool row would credit
   a tool that did not run.
4. Whole tokens are distributed by largest remainder inside each turn, so a
   class's per-tool column sums to that class's total exactly. The residual of
   that rounding is printed if it is ever nonzero, never folded into a row.

Proportional, not even, because the window's size _is_ the tool results: the
input the model then reads is the prompt plus what the tools wrote into it. An
even split would report equal blame whatever a result weighed.

### What the rule cannot measure

- It measures **marginal context**: what the tools in this window added to the
  prompt the model read next. Cached tokens are charged at the window that read
  them, not at the turn that first wrote them, so `cached input` in a long session
  is a re-charge rather than a lifetime cause. A tool that dumped a large result
  once and was never called again shows a small column, because later windows are
  charged to later tools.
- It cannot see a provider that prices cache reads separately from cache writes
  unless the caller passes both rates.
- `usage.cost` in the file is pi's own figure from its model table. This reader
  never reads it: a price here is a function of the rates on the command line, so
  a wrong table cannot become a wrong report.

## A turn that was cut off is counted, and its usage is left out

`lib/detection/context-usage.ts` skips turns pi stopped as `aborted` or `error`
when it reads the same file, and this reader follows it: those turns are counted
and printed, their tokens are not added. A turn with no `usage` object at all is
counted separately. A field a provider did not report is `n/a`, never zero, and
the number of turns that omitted it is printed beside the value. A class no turn
reported renders as `n/a` for the session, including the cached share derived
from it. The ten-session census had 353 such turns, so the rule is not theoretical.

## A price comes only from the caller

`--rate-in`, `--rate-cache-read`, `--rate-cache-write`, `--rate-out` are USD per
million tokens. The arithmetic is printed class by class so it can be checked
against a provider's price list:

```
    uncached input: 3900 tokens x 10 USD/1M = 0.039000 USD
    cached input: 7600 tokens x 1 USD/1M = 0.007600 USD
```

When a class has tokens and no rate, the report prints **no total** and names
what it cannot price:

```
    price: n/a, no rate for cached input (7600 tokens, needs --rate-cache-read)
```

A partial sum is a wrong number presented as a right one, so it is refused
rather than printed with a footnote. With no rate flag at all the line says the
price was not requested.

## A worked session

Session `01a18d2c`, 457 billed turns, 4 aborted/error turns excluded, 97.8% of its
input served from cache. `bash` holds 82% of its 135,554,929 tokens; `edit` and
`write` together hold 14.6%.

| tool             | calls | results | result chars | uncached input | cached input | cache write | output  |
| ---------------- | ----- | ------- | ------------ | -------------- | ------------ | ----------- | ------- |
| bash             | 397   | 397     | 367,529      | 1,357,091      | 109,139,979  | 0           | 306,958 |
| edit             | 63    | 63      | 6,576        | 447,743        | 10,580,704   | 0           | 31,493  |
| write            | 43    | 43      | 3,476        | 182,881        | 8,510,098    | 0           | 22,252  |
| read             | 8     | 8       | 34,250       | 11,630         | 1,870,891    | 0           | 14,204  |
| (prompt)         | 0     | 0       | 0            | 998,501        | 385,792      | 0           | 18,097  |
| context_navigate | 2     | 2       | 90           | 5,269          | 589,568      | 0           | 1,938   |
| think            | 1     | 1       | 2,448        | 1,444          | 441,600      | 0           | 836     |
| memory_store     | 5     | 5       | 222          | 4,910          | 342,744      | 0           | 3,469   |
| context_compress | 1     | 1       | 437          | 1,054          | 283,520      | 0           | 263     |

Its assistant characters are 6.5% prose and 93.5% tool arguments: on this
session the model wrote almost nothing and called tools almost continuously.

## Ten sessions from the local tree

Ten session files from different projects, chosen to span the shapes rather than
the newest ten: two models with no prompt caching at all, one session with a
large cache-write bill, and the rest between. Tokens as recorded; the price
column applies the rates in the command below, which are the example's numbers
and not a tariff the script ships.

| session  | models | turns | uncached in | cached in | cache write | output | cached share | top tool (share) | price   |
| -------- | ------ | ----- | ----------- | --------- | ----------- | ------ | ------------ | ---------------- | ------- |
| 01a1c490 | 1      | 1236  | 102.26M     | 175.30M   | 0           | 485.2k | 63.2%        | bash (55%)       | 366.64  |
| 01a1e5ac | 1      | 1205  | 19.11M      | 210.60M   | 0           | 752.3k | 91.7%        | bash (58%)       | 131.79  |
| 01a1c705 | 2      | 531   | 4.68M       | 120.84M   | 0           | 292.6k | 96.3%        | bash (80%)       | 54.67   |
| 01a18d2c | 1      | 457   | 3.01M       | 132.14M   | 0           | 399.5k | 97.8%        | bash (82%)       | 54.67   |
| 019f2d81 | 2      | 341   | 2.08M       | 74.30M    | 0           | 230.0k | 97.3%        | bash (61%)       | 31.98   |
| 019e2302 | 3      | 1390  | 17.15M      | 162.86M   | 159.2k      | 524.0k | 90.5%        | bash (35%)       | 108.76  |
| 019d9e4a | 1      | 1070  | 52.32M      | 53.69M    | 3.44M       | 354.7k | 50.6%        | bash (33%)       | 191.28  |
| 0d1ffc54 | 7      | 2720  | 77.44M      | 211.81M   | 0           | 1.15M  | 73.2%        | bash (53%)       | 313.19  |
| 1e622403 | 2      | 1757  | 368.35M     | 0         | 0           | 1.98M  | 0.0%         | bash (34%)       | 1134.73 |
| 2dc5a80d | 1      | 1480  | 162.84M     | 0         | 0           | 971.3k | 0.0%         | bash (36%)       | 503.10  |

All ten together: 12,187 billed turns, 809,230,500 uncached input,
1,141,547,892 cached input, 3,597,444 cache write, 7,143,176 output, which is
1,961,519,012 tokens and 2,890.793923 USD at the rates in the reproduction
command. One result arrived after the last turn and was never read by a window.

What the table says:

- **`bash` is the top tool in all ten sessions and holds 50.1% of every token
  counted.** Whatever the tool inventory looks like, the bill is the shell, and
  the second-order effect is that a result a shell command dumps is then re-read
  as cached input on every later turn.
- **The two sessions with no prompt caching carry 65.6% of the uncached input and
  56.7% of the price** while holding 20% of the rows, because an uncached token
  costs what the input rate says and a cached one is a tenth of it at these rates.
  The model choice moves the bill more than the turn count does.
- **Cache share is a property of the harness, not of the work.** The same agent,
  same tools, same workflow lands between 0% and 97.8% depending on whether the
  provider caches prompts at all, and the four classes are the only place that
  difference is visible.
- **`(prompt)` is not a rounding error.** In the worked session it holds 998,501
  uncached input tokens without a single tool call: user turns and the system
  prompt are a measurable share of what a session reads.

## The fixture, and the control that proves it can fail

`test/runtime/lib/test-session-cost-report.mjs` builds a session on paper: two
tools, one window weighted 3:1 and one weighted 1:2, one turn per bucket (prompt,
aborted, no usage), one malformed line, one JSON array, one field a provider never
reported, and one result that arrives after the last turn. Every expected number
is hand-checkable, and the 3:1 and 1:2 windows mean an even split produces
different numbers than the weighted one, so the fixture discriminates the rule
rather than agreeing with whatever the code does.

Fifteen cases. The control that shows they can fail: doubling one recorded number
(`cacheRead` on the third turn, 1200 to 2400) turned five cases red and the first
failure was

```
AssertionError [ERR_ASSERTION]: cached input total

8800 !== 7600
```

The class is named in the message, so the failure says which number moved rather
than "a total was wrong". Restoring the fixture returns all fifteen to green.

## Reproducing every number here

The census rows are session ids. Name them and the reader reads exactly those:

```bash
node packages/core/scripts/session-cost-report.mjs \
  --dir "$HOME/.pi/agent/sessions" --limit 10 \
  --session 1e622403-4f6f --session 2dc5a80d-822a --session 0d1ffc54-42d4 \
  --session 01a1c490-2c94 --session 019d9e4a-20ef --session 019e2302-a702 \
  --session 01a1e5ac-ce54 --session 01a1c705-b0fd --session 01a18d2c-865e \
  --session 019f2d81-d8f7 \
  --rate-in 3 --rate-cache-read 0.3 --rate-cache-write 3.75 --rate-out 15
```

`--json` prints the same figures as a payload. `--dir` takes pi's layout (one
directory per project, one JSONL per session) and reads the newest files first,
so `--limit` bounds the work; a census that names ten sessions reads ten heads
and ten files, not every session on the disk. The session files grow while a
session runs, so a figure for a live session is a snapshot: every row above comes
from a session that had already ended.

The fixture runs with the rest of the core suite:

```bash
node packages/core/test/runtime/lib/test-session-cost-report.mjs
```
