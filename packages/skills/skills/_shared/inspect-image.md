---
name: inspect-image
description: "Fragment: how to get the pixels in front of the agent when no image-specific tool is guaranteed. Read by the visual skills; not a skill itself."
---

# Looking at an image

The visual skills all need the same first step: the pixels, in front of the
agent. Three routes, in the order that works.

1. **Read the file.** An image path handed to the `read` tool (png, jpg, gif,
   webp, bmp) comes back as an attachment the model can see. This is pi core's
   own read tool, so it needs no extra package.
2. **Render, then read.** A PDF page, a slide deck, or a design-tool export is
   not an image yet. `document_screenshot` (the pi-docparser extension) renders
   a page to PNG; read that PNG. If the extension is not installed, ask the user
   for a screenshot.
3. **Ask for a better source.** A file, a crop, a larger export. Asking costs
   one turn; a guessed measurement costs the whole review.

Some harnesses also ship a dedicated image-description tool. Use it if it is in
your tool list; do not assume it is there, and do not name one that is not.

## What breaks

- **A dark or low-contrast image gets described as empty.** Vision models
  dismiss low-contrast images far more often than high-contrast ones. If a
  description comes back "blank", "empty", or "abstract", re-render or brighten
  before concluding the image is wrong.
- **A downscaled image loses the detail you were asked about.** Letterforms,
  one-pixel alignment offsets, and sprite silhouettes disappear below roughly
  16px. Crop the region instead of scaling the whole page.
- **A measurement you did not make.** Never report a hex value, a contrast
  ratio, a font size, or a percentage that did not come from an image you
  actually saw. Say which numbers are unmeasured.
