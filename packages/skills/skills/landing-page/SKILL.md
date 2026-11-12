---
name: landing-page
description: "Use when a marketing page has to be built or polished from a reference design: a hero that must convert, a tab strip that jumps while the price cards do not line up, a rail-and-panel switcher or a carousel borrowed from that reference, a page that must work with JavaScript off, or a layout that has to pass a rendered-layout gate at phone widths. Gives the mechanics that make the borrowed shape safe, the build order, the honesty rules for claims a page may not make, and the gate that sees what a text check cannot. Not for choosing a palette or type scale (visual-creator) and not for auditing a finished screen (visual-validator)."
validated: 2026-11-09
verdict: UNVALIDATED
governs:
  - design
triggers:
  - "landing page"
  - "landing pages"
  - "marketing page"
  - "polish the landing page"
  - "reference layout"
  - "hero section"
  - "tab switcher"
  - "accordion faq"
  - "price cards"
  - "work without javascript"
---

# Landing Page

A landing page is a single HTML document that must survive three readers: someone with JavaScript off, someone on a 320px phone, and someone deciding whether to trust the page. Every mechanic below exists because one of those three broke.

## Before you touch the page

**A reference design gives you shapes, not claims.** When someone hands you a professional layout to copy, take the structure and the craft and leave the content behind. The reference will have client testimonials, a phone number, years in business, and a photography budget. A page whose promise is "every fact here has a source" cannot open with a quote from a client nobody has served. Take the band, drop the claim, and say in the diff what you dropped and why.

**Read the page's own promises first.** Prices, guarantees, consent lines and legal sentences are the page's contract with a stranger. A polish that quietly rewords one has changed the business, not the layout. Diff them separately: if a promised number moved, that is a decision for the owner, never a formatting casualty.

## The mechanics worth copying

**Rail and panel, not a card grid, for a set of five or more.** The reference's mechanic is exclusivity: N items in a rail, one panel beside them, the chosen item filled and flush against the panel so the pair reads as one object, and the panel's height set by the tallest member of the set so the page does not jump as the choice moves. A `grid-3` of six cards leaves an orphan row and makes every item pay full height at once.

**The markup is the no-script page; the script upgrades it.** Write the five items as jump links and five stacked panels, then let the script add `role="tablist"`, `aria-selected`, `aria-controls`, roving `tabindex` and `role="tabpanel"`, and hide the unselected panels. Arrow keys, Home and End move selection; activation does not write to the URL. A stylesheet rule scoped to `:not([role="tablist"])` underlines the links so they look like links while the script is absent. Never build the interactive version and bolt on a fallback: the fallback is the fallback because it came first.

**A carousel is a decision, not a default.** Arrows over content that already fits hide what the reader could have seen. Use one only when the set is too long for the band, and then make the arrows real buttons with visible focus and confine the overflow to the strip's own scroller so the page itself never scrolls sideways.

**A timeline is a line with stops, not a numbered list.** If the four steps describe a process, draw the rail: numbered stops on a connector, labels under the stops, and the line drawn in segments that stop at the last stop rather than dying where a graphic is missing.

**Price tiers share their rows.** Each tier gets one line naming who it is for, then the price, then the body, then the CTA, all on shared grid rows so the three prices land on one horizontal line and can be compared at a glance. A tier whose extra border costs it 2px of body should pay that back in padding, not in a mismatched row.

**A contact form with no endpoint is a lie.** A name-and-phone form that posts nowhere either silently drops someone's number or pretends to have received it. If there is no endpoint, the real action is a chat link, and it should be reachable from the header, the hero, each price tier and the footer.

## Claim discipline

- **No invented social proof.** No testimonials, no client counts, no logos, no star ratings. If the page has no evidence, the trust band must be built from what is true: the artifact, the process, the provenance rule.
- **No invented numbers.** Every figure comes from the repository's own data or its source is named on the page.
- **No invented contact.** One configured handle or address, substituted at build; nothing else invents one.
- **One call to action, repeated.** Every CTA on the page goes to the same place. Two destinations means the page has not decided what it wants.

## The gate that sees what text checks cannot

A text audit cannot see a page that scrolls sideways, and neither can a test
that reads HTML. The gate is `design_audit`, run at its default widths - 320,
390, 768, 1440 - against the page as served:

```
design_audit(target: "<url-or-file>", widths: [320, 390, 768, 1440])
```

Two of its outputs are this page's gate, and both are per width:

- **`overflow[]`** - every element that crosses the viewport, with `path`,
  `reason` (`scroll` when the document scrolls sideways, `viewport` when a box
  crosses the edge from outside every clipping ancestor), `right`,
  `scrollWidth`, `clientWidth`. An empty list is the gate passing at that
  width. The tool reads the ancestor's computed `overflow-x` before it exempts a
  clipped box, so the exemption is proven, not asserted.
- **`findings.total`** - the one number to put in front of the owner: contrast,
  off-grid values, values not in the token file, tap targets and overflow,
  summed. `findings` also carries the five counts separately, so a regression
  names its class.

The loop that turns those numbers into a change is owned by `visual-validator`:
measure, decide, build, re-measure at the same widths, compare in a pasted
table. A landing page's special case is sequence: it is bands, not one screen,
so attribute each finding to a band by its selector (`contrast.failures[].path`,
`overflow[].path`, `tapTargets[].path`). For a band's own numbers, extract it
into a standalone file and audit it at the same widths; the tool measures a
whole page, not a section.

Two stylesheet facts that trip this gate: `[hidden]` loses to any class rule that sets `display`, so the sheet must state `[hidden]{display:none}`; and a `.switch-rail` that becomes a horizontal strip on phones must be a real `overflow-x:auto` scroller, or the page inherits its width.

## Build order

1. Read the existing page and list its promises (prices, guarantees, consent lines).
2. Read the reference and write down per band: the shape, and the claim you will not copy.
3. Change the markup first, with the no-script version complete and readable.
4. Add the script upgrade; prove keyboard operation.
5. Run `design_audit` at its four widths; fix `overflow[]` before beautifying.
6. Read the PNGs `design_audit` wrote, at the phone and desktop widths, band by band; the gate sees geometry, not cheapness.

## What this does not cover

Palette and type scale belong to visual-creator; the token contract and its linter belong to design-system; the measure-decide-build-remeasure-compare loop belongs to visual-validator. This file is the building procedure and the claim discipline between them.
