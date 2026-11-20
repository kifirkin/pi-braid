<!-- status: current -->

# Upgrading pi

Braid reads pi's declarations across far more of the surface than the extension
API, and the version braid ends up running under is not always the version this
repository pins: `package.json` pins the workspace's dev copy, four packages
carry peer ranges, and the pi a session actually loads is installed under the
agent directory by pi itself. Nothing used to compare those numbers, and nothing
recorded what braid takes from pi.

Two records exist now. `scripts/check-extension-api.mjs` keeps the frozen
`ctx.<member>` member set. `pi-surface.json` keeps the rest, symbol by symbol,
read from the installed declarations.

## What the record holds

`packages/core/pi-surface.json` is written by `--record` and is not meant to be
edited by hand. It carries the version of every recorded package, then one entry
per surface:

- the package and the declaration file the symbol lives in,
- one sentence naming the braid call that would break,
- one entry per symbol: its kind, its declaration head, and, for a declaration
  with a body, one entry per member holding that member's signature lines.

Signatures are normalized: comments removed, whitespace collapsed to one space,
generic parameters and optional markers kept as written. Overloads stay separate
lines, so `pi.on`'s forty-odd event overloads diff one event at a time. The file
is large; the thing to read on an upgrade is its diff.

The surface list itself is data in `packages/core/scripts/pi-surface.mjs`. A
symbol gets a row when braid imports it, or when braid calls members on an
object pi hands it (`ctx.ui.notify`, `ctx.sessionManager.getBranch`). The list
is the audit of the claim, and the record is the audit of the list.

## Commands

```
node packages/core/scripts/check-pi-surface.mjs
```

The reconciliation: the pi root it read, the installed versions, the versions the
record was taken against, every dependency field in the workspace that names a
recorded package with whether the installed version satisfies it, then the symbol
comparison. Exit 0 when the symbols agree. A version mismatch is printed and is
not a failure: the record compares symbols, not version strings.

```
node packages/core/scripts/check-pi-surface.mjs --check
```

The gate: one line on agreement, one line per difference. Exit 0 or 1.

```
node packages/core/scripts/check-pi-surface.mjs --record
```

Rewrite the record from the installed declarations. It refuses when a row names a
symbol its declared file does not declare, and prints where the symbol actually
is; a record that quietly dropped a symbol would compare clean forever after.

`PI_SURFACE_PI_ROOT` points any of the three at another pi install, which is how
to judge the tree a running session actually loads:

```
PI_SURFACE_PI_ROOT=<install>/node_modules/@earendil-works/pi-coding-agent \
  node packages/core/scripts/check-pi-surface.mjs --check
```

## Which pi the record follows

The record follows the version this workspace compiles against, which is the
version its lockfile installs, and it says so: `packages` in the record carries
the versions it was read from. It does not follow whatever pi a session happens
to be running. Three reasons:

- The gate has to run where the tree is. CI installs from the lockfile and has
  no agent directory at all, so a record taken from a runtime install would be
  one no fresh clone and no CI job can reproduce.
- `npm run typecheck` holds braid's call sites to the same declarations the
  record does. A record and a compiler that disagree about which pi they describe
  is the arrangement that makes a green run mean nothing.
- The runtime install is a fact about a machine, not about the repository. On the
  machine this was written on there are three pi trees: the workspace's 1.5.0, the
  release the pi process runs (`~/.pi/agent/install/releases/<version>/`), and the
  npm tree braid's own imports resolve through (`~/.pi/agent/npm/node_modules/`).
  A record that followed any one of them would be wrong on the next box.

So the runtime drift is read, never gated: point `PI_SURFACE_PI_ROOT` at it, read
what comes back, and fix the pin when the drift matters. Nothing about that run
changes the committed record.

## The first real diff it produced

Against the workspace, clean:

```
$ node packages/core/scripts/check-pi-surface.mjs --check
check-pi-surface: 29 surfaces, 82 symbols, 686 members match (pi-coding-agent 1.5.0, pi-ai 1.5.0, pi-agent-core 1.5.0, pi-tui 1.5.0)
```

Against the release the pi process was running at the time, 1.5.2:

```
$ PI_SURFACE_PI_ROOT=~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent \
    node packages/core/scripts/check-pi-surface.mjs --check
check-pi-surface: 1 difference(s) between .../pi-surface.json (recorded against pi-coding-agent 1.5.0, ...) and the installed pi-coding-agent 1.5.2, pi-ai 1.5.2, pi-agent-core 1.5.2, pi-tui 1.5.2
  extension-api/ExtensionAPI: member "registerMarkdownTransformer" changed: recorded "registerMarkdownTransformer(transformer: MarkdownTransformer): void", now "registerMarkdownTransformer(transformer: MarkdownTransformer, options?: MarkdownTransformerOptions): void" (the difference adds an optional parameter, so callers of the recorded shape are unaffected: re-record when the pinned range moves)
  also, 2 additive change(s), not counted as differences:
    model-runtime/ModelRuntime: new member "settleCredentialWrites"
    ai-models/Provider: new member "refreshModelsAuth"
```

Three lines, one reading: a registration call braid never makes gained an
automatic option, and two types gained members braid never calls. Nothing braid
does breaks, so nothing is done: the pin stays, the record stays, and the next
`--record` after a range bump will absorb all three.

A signature is compared as text, so a line that appends only optional parameters
is still a difference and still exits 1. It is not a break for a caller, and the
line says so when the text can settle it: everything around the parameter list
identical, the appended parameters all omittable. It never says so for an added
required parameter, a changed return type or a reordered parameter, because
telling assignability apart from text needs the type checker, and a gate that
guesses which changes are safe is a gate that silences one.

## The upgrade

1. Change the pi range everywhere it is declared: `package.json`,
   `packages/core/package.json`, `packages/contrib/package.json`,
   `packages/providers/package.json`, `packages/telegram/package.json`.
2. Install, then run the reconciliation and read the declared section: every
   range against the version that landed.
3. `--record`, then `git diff packages/core/pi-surface.json`. Each changed line
   is a member braid can reach; the removed and retyped ones are the work.
4. For a difference, follow it to the call site. A member that is gone or retyped
   is the compiler's problem where braid imports the type and a silent one where
   the handler types its event as `any`, which is most of them.
5. Run the suite, then commit the range and the record in one commit.

## Reading a difference

```
session/ReadonlySessionManager: member "getBranch" is gone
```

The member is no longer on the type `ctx.sessionManager` carries. Either pi
renamed it, or it moved to a different view of the session.

```
ai-types/Model: signature changed: recorded "export interface Model<TApi extends Api> {", now "..."
```

The declaration head changed: a type parameter, an `extends` clause, or the kind.

```
ai-types/Model: member "contextWindow" changed: recorded "contextWindow: number", now "contextWindow?: number"
```

One member was retyped, and the line shows both sides.

An added member, or an added overload line, prints as an addition and does not
fail: pi adding to an interface cannot break a caller. Everything else is a
difference, and a difference whose only change is trailing optional parameters
carries that reading in the line itself.

## What the record cannot see

- A value that is not in a declaration. `DEFAULT_MAX_BYTES` is recorded as
  `number`; a release that changes the number changes nothing here.
- A payload whose type is unchanged. If pi's compaction handler keeps its
  signature and starts filling the same fields differently, the record is silent.
- A shape braid passes without naming: an object literal handed to
  `pi.registerProvider` is checked against pi's type by the compiler in this
  repository only, so a runtime pi that expects another field is invisible.
- Anything pi does not declare: the JSON schemas, the prompt text, the skill
  discovery walk, the loader's behavior.
- Which members braid uses. A member is recorded because its symbol is, so a
  change to a member braid never calls still fails. Read the diff; if the member
  is unused, re-record and say so in the commit.

## When braid starts using more of pi

Add the symbol to the row in `packages/core/scripts/pi-surface.mjs` and re-record
in the same commit. The gate holds the record to the rows it is given; a call
into a part of pi no row names is invisible to it, and the review of a new call
site is where the row gets added.
