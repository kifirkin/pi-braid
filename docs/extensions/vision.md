# Extension: vision

**Status**: ✅ Working
**Tests**: None
**Version**: v0.10.x

## Purpose

Image analysis — the `analyze_image` tool uses a vision-capable model to analyze images (UI elements, sprites, screenshots, document scans). Auto-detects pixel art, spritesheets, and grid layouts for specialized analysis.

## Architecture

Vision model selection via `resolveVisionModel()` from `lib/model-resolver.ts`. The vision-capable model is selected from the available model registry, preferring models with vision support.

## Events Handled

None — the tool is called directly by the agent.

## Tools

| Tool | Description |
|------|-------------|
| `analyze_image` | Analyze image file. Auto-detects: pixel art, spritesheets, grid layouts. Extracts: text, visual elements, technical details, color palettes. Reports dimensions + aspect ratio warnings. |

## Key Patterns

- **Auto-detection**: Detects pixel art (low resolution, indexed colors), spritesheets (regular grid layout), and general images automatically — no manual mode switching.
- **Model routing**: Vision-capable models are pre-filtered via `scopedModels` in ModelSelectorComponent. `resolveVisionModel()` picks the best available vision model.
- **Grid analysis**: For spritesheets, divides the image into a grid and analyzes each cell independently, identifying unique sprites.
- **Color palette extraction**: Extracts dominant colors from images for design analysis. Reports color harmony and contrast issues.
