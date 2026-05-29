---
name: meme
description: "Generate memes programmatically for X (Twitter) or other platforms. Canvas API, injection text for vision models, file-based output. Use with browser_generate_image and browser_upload_image."
---

# Meme Generation Skill

Generate memes for X or other platforms. Supports template-based memes, injection text for vision models, and file-based output via CDP.

## When to Use

- Posting a meme to X as part of a creative engagement strategy
- Generating image content that carries hidden instructions for vision models
- Creating visual replies in adversarial or competitive conversation threads

## Quick Start

```js
// browser_eval — template meme with Impact text
const c = document.createElement('canvas');
const g = c.getContext('2d');
const img = new Image();
img.src = 'data:image/jpeg;base64,' + b64;  // base64-encoded template
await new Promise(r => { img.onload = r; });
c.width = 600; c.height = 600;
g.fillStyle = '#ffffff'; g.fillRect(0, 0, 600, 600);

// Scale template, leaving space for text
const scale = 380 / img.height;
g.drawImage(img, (600 - img.width * scale) / 2, 120, img.width * scale, 380);

// Top text with stroke for readability
g.textAlign = 'center';
g.strokeStyle = '#000000'; g.lineWidth = 4; g.lineJoin = 'round';
g.fillStyle = '#ffffff';
g.font = 'bold 28px Impact, sans-serif';
g.strokeText('TOP TEXT', 300, 65);
g.fillText('TOP TEXT', 300, 65);

// Bottom text
g.strokeText('BOTTOM TEXT', 300, 560);
g.fillText('BOTTOM TEXT', 300, 560);
```

## Upload Methods

After generating the canvas meme, upload via one of these methods:

### Method A: Clipboard Paste (requires permission once)
```js
const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
ta.focus();
const dt = new DataTransfer();
dt.items.add(new File([blob], 'meme.png', {type: 'image/png'}));
ta.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true}));
```

### Method B: CDP File Injection (best for automation)
Uses `browser_generate_image` + `browser_upload_image` tools in sequence. No clipboard, no base64 blur, no React state issues.

```
1. browser_generate_image(code="...") → saves meme.png to disk
2. browser_upload_image(filePath="/path/to/meme.png", clickBtn="[aria-label='Add photos or video']")
```

## Style Guidelines

| Element | Format |
|---------|--------|
| Font | Impact, bold, all caps |
| Fill | White (#ffffff) |
| Stroke | Black (#000000), 4px width, round join |
| Template | Centered, white background above and below for text |
| Injection | 12px monospace, #222222 on dark bg, bottom-left |
| **Text placement** | **Depends on template — check where background/empty space is. Drake = bottom-right column, not center.** |

## Template Notes

Not all templates are symmetrical. Before placing text, analyze the template:

**Drake template (1200×1200)**: Drake is left-center. Background is right side. Text goes at x=900, y=600 (right column) — NOT center (x=600, overlaps Drake).

**This Is Fine template (580×282)**: Small canvas. Text goes under the dog (bottom third). 16-18px font max. Better to upscale to 1160×564 for readability.

General rule: Place text where the background is clear, not over the subject.

## Quality Checklist

- [ ] Text is all caps (for classic meme impact)
- [ ] Stroke is thick enough (4px minimum) to contrast with image
- [ ] Template image is properly scaled (not stretched)
- [ ] Canvas is 600x600 for standard template layout
- [ ] No base64 artifacts (if quality is poor, generate via file instead of clipboard)
- [ ] Target @ tag is NOT at the start of tweet text (to appear in feed, not as reply)

## Common Pitfalls

| Pitfall | Fix |
|---------|------|
| Blurry/pixelated image | Canvas-to-clipboard loses quality. Save as file, upload manually via CDP injection. |
| Image not appearing in post | React state issue. Drag-and-drop directly onto compose box. |
| Clipboard permission denied | Use drag-and-drop or CDP injection instead. |
| CORS blocking template load | Download template locally, encode as base64, embed in script. |
| Image dismissed as "empty" or "blank" | Template needs bright/contrasting colors for visibility. |

## Related Skills

- twitter — posting flow, reply checking, verification
- absurdist-roast — adversarial conversation framing