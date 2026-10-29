---
name: meme
description: "Deprecated: no skill in this pack replaces it, and the animated and collaged GIF work it used to cover has moved out of the pack. Use only when the deliverable is one static image macro: a template with Impact captions, rendered on a canvas, then attached to a post. Gives the canvas recipe, the stroke and fill values that stay legible on any template, template-specific caption coordinates, and the attachment failures that silently drop the image from a post."
status: deprecated
successor: no skill in this pack; animated and collaged GIF work is out of scope for this package
validated: 2026-10-27
verdict: DEPRECATE
governs:
  - browser
triggers:
  - meme
  - image macro
  - impact caption
  - caption this image
  - post meme to x
---

> **Deprecated. No skill in this pack replaces it**, and the animated/collaged
> GIF work this file used to carry has moved out of the pack entirely. What
> remains is the part that works with no browser harness: the canvas recipe and
> the template placement rules. For static image macros, those are still right.

# Meme Generation Skill

One static image macro, rendered on a canvas, then attached to a post. The
canvas technique is self-contained; the posting flows this file used to carry
are gone.

## When to Use

- A single static image macro is the deliverable: template plus Impact captions
- A visual reply where a canvas render is faster than an image model
- Not for animated or collaged GIFs, and not for posting mechanics in general

## Quick Start

```js
// browser_eval — template meme with Impact text
const c = document.createElement("canvas");
const g = c.getContext("2d");
const img = new Image();
img.src = "data:image/jpeg;base64," + b64; // base64-encoded template
await new Promise((r) => {
  img.onload = r;
});
c.width = 600;
c.height = 600;
g.fillStyle = "#ffffff";
g.fillRect(0, 0, 600, 600);

// Scale template, leaving space for text
const scale = 380 / img.height;
g.drawImage(img, (600 - img.width * scale) / 2, 120, img.width * scale, 380);

// Top text with stroke for readability
g.textAlign = "center";
g.strokeStyle = "#000000";
g.lineWidth = 4;
g.lineJoin = "round";
g.fillStyle = "#ffffff";
g.font = "bold 28px Impact, sans-serif";
g.strokeText("TOP TEXT", 300, 65);
g.fillText("TOP TEXT", 300, 65);

// Bottom text
g.strokeText("BOTTOM TEXT", 300, 560);
g.fillText("BOTTOM TEXT", 300, 560);
```

## Attaching the image, and proving it attached

Three methods, in order of reliability. All three assume a browser automation
tool that can evaluate script in the page and attach a file. If your harness
has no such tool, generate the PNG and attach it by hand; that is a legitimate
route, not a degraded one.

1. **File input injection (most reliable).** Locate the compose box's
   `input[type=file]` and set its files through the automation tool's upload
   call, then verify (below). This bypasses the page's state management
   entirely.
2. **Drag-and-drop.** Build a `DataTransfer` with the PNG `File`, dispatch <!-- doc-ref-exempt: browser API named in the drag-and-drop recipe, not a repo identifier -->
   `drop` on the compose box's nearest container, verify (below).
3. **Clipboard paste.** Requires a clipboard permission grant, and loses
   quality on some templates. Verify (below).

### Verify the attachment, never the element count

```js
// Count only blob-backed images inside the open compose dialog.
const imgs = [...document.querySelectorAll('[role="dialog"] img')];
const attached = imgs.filter((img) => img.src?.startsWith("blob:"));
attached.length > 0; // true = an attachment exists
```

Profile pictures (a `pbs.twimg.com` src whose `alt` equals the account name)
and stickers (`alt=""`) are not attachments, and the total `img` count
includes both. If the compose box closes without an image, the attachment
silently failed: re-attach before posting, do not re-post.

### Template provenance and alt text

- Use a template you have the right to publish, or one the platform's own media
  search offers. A generated image of someone's photograph is a rights problem,
  not a joke.
- Every generated macro gets alt text: the caption, in order, as a sentence.

## Style Guidelines

| Element            | Format                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| Font               | Impact, bold, all caps                                                                                    |
| Fill               | White (#ffffff)                                                                                           |
| Stroke             | Black (#000000), 4px width, round join - ensures readability on any template                              |
| Template           | Centered, white background above and below for text                                                       |
| Injection          | 12px monospace, #222222 on dark bg, bottom-left                                                           |
| **Text placement** | **Depends on template - check where background/empty space is. Drake = bottom-right column, not center.** |

## Template Notes

Not all templates are symmetrical. Before placing text, analyze the template:

**Drake template (1200×1200)**: Drake is left-center. Background is right side. Text goes at x=900, y=600 (right column) - NOT center (x=600, overlaps Drake).

**This Is Fine template (580×282)**: Small canvas. Text goes under the dog (bottom third). 16-18px font max. Better to upscale to 1160×564 for readability.

General rule: Place text where the background is clear, not over the subject.

## Quality Checklist

- [ ] Text is all caps (for classic meme impact)
- [ ] Stroke is thick enough (4px minimum) to contrast with image
- [ ] Template image is properly scaled (not stretched)
- [ ] Canvas is 600×600 for standard template layout
- [ ] Template background is tested: white-on-white with stroke works on dark templates but may look faint on bright ones - read the rendered PNG as an image attachment before posting
- [ ] No base64 artifacts (if quality is poor, generate via file instead of clipboard)
- [ ] Target @ tag is NOT at the start of tweet text (to appear in feed, not as reply)

## Common Pitfalls

| Pitfall                               | Fix                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Blurry/pixelated image                | Canvas-to-clipboard loses quality. Save as a file and use file-input attachment instead. |
| Image not appearing in post           | React state issue. Drag-and-drop directly onto compose box.                              |
| Clipboard permission denied           | Use drag-and-drop or file-input attachment instead.                                      |
| CORS blocking template load           | Download template locally, encode as base64, embed in script.                            |
| Image dismissed as "empty" or "blank" | Template needs bright/contrasting colors for visibility.                                 |

## Related Skills

- `visual-validator` - judging the rendered result with measured values
- `visual-creator` - design reasoning for anything beyond a one-off macro
- `adversarial-engagement` - framing for defensive systems, when the meme is a reply
- `socratic-irony` - framing for human audiences

## Lessons Learned

### Zero-Dep PNG Output

- Python with `zlib` compression works for simple canvas-style memes
- Avoid `clipboard.write` chains for quality-sensitive output
