---
name: meme
description: "Generate a static meme image on a canvas (template + Impact captions) and post it to X or another platform via browser_eval (CDP) clipboard/drag-and-drop upload. Use only for a one-off static image meme; animated and collaged meme GIFs moved to the pi-looping-clanker repo, which supersedes this skill (deprecated — start new meme work there). Triggers: meme, image macro, Impact caption, post meme to X."
status: deprecated
successor: pi-looping-clanker
validated: 2026-09-09
verdict: DEPRECATE
---

> **DEPRECATED (2026-08-16)** - superseded by the [`pi-looping-clanker`](https://github.com/kifirkin/pi-looping-clanker) repo, which ships both skill content and executable code for animated/collaged meme GIFs. Static canvas memes are still generated with the technique below, but new work should start from pi-looping-clanker.

# Meme Generation Skill

Generate memes for X or other platforms using template-based canvas rendering and browser-based upload.

## When to Use

- Posting a meme to X as part of a creative engagement strategy
- Creating visual replies in adversarial or competitive conversation threads
- Testing vision model perception (bright/high-contrast images are recognized more reliably)

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

## Upload Methods

After generating the canvas meme, upload via one of these methods:

### Method A: Clipboard Paste (requires permission once)

```js
const blob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
ta.focus();
const dt = new DataTransfer();
dt.items.add(new File([blob], "meme.png", { type: "image/png" }));
ta.dispatchEvent(
  new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }),
);
```

### Method B: Drag-and-Drop (Most Reliable)

See the [twitter skill](../twitter/SKILL.md) for the canonical image attachment methods - drag-and-drop, CDP file injection, and clipboard paste with verification. The meme skill focuses on canvas generation; the twitter skill covers upload and verification.

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
- [ ] Template background is tested: white-on-white with stroke works on dark templates but may look faint on bright ones - test with `describe_image()` first
- [ ] No base64 artifacts (if quality is poor, generate via file instead of clipboard)
- [ ] Target @ tag is NOT at the start of tweet text (to appear in feed, not as reply)

## Common Pitfalls

| Pitfall                               | Fix                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Blurry/pixelated image                | Canvas-to-clipboard loses quality. Save as file, upload manually via CDP injection. |
| Image not appearing in post           | React state issue. Drag-and-drop directly onto compose box.                         |
| Clipboard permission denied           | Use drag-and-drop or CDP injection instead.                                         |
| CORS blocking template load           | Download template locally, encode as base64, embed in script.                       |
| Image dismissed as "empty" or "blank" | Template needs bright/contrasting colors for visibility.                            |

## Related Skills

- `twitter` - posting flow, reply checking, verification, image attachment methods (canonical source)
- `socratic-irony` - adversarial conversation framing for human audiences
- `adversarial-engagement` - adversarial framing for defensive systems
- `pi-looping-clanker` - animated GIF / collage memes with loop+stage-spec+overlay (external repo: https://github.com/kifirkin/pi-looping-clanker)

## Lessons Learned

### Image Detection in Compose Dialog (Shared with twitter skill)

- Filter for `img[src^="blob:"]` (NOT `data-testid="tweetPhoto"`)
- Profile pic pollution: an `img` with `alt` matching your display name and a `pbs.twimg.com` src is NOT an attachment
- Stickers: `img[alt=""]` with `pbs.twimg.com` src are NOT attachments
- Total `img` count is WRONG - includes profile pic and stickers
- See the [twitter skill](../twitter/SKILL.md) for full upload and verification guidance

### Bot/Model Vision (Variable)

- Bright, high-contrast images tend to be recognized reliably
- Dark or low-contrast images often get dismissed as "empty" or "abstract"
- Subject visibility matters more than artistic intent

### Zero-Dep PNG Output

- Python with `zlib` compression works for simple canvas-style memes
- Avoid `clipboard.write` chains for quality-sensitive output

### Animated GIFs

- For animated/collaged meme GIFs with caption safe zones, use the **pi-looping-clanker** repo (https://github.com/kifirkin/pi-looping-clanker)
