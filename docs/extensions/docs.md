# Extension: docs

**Status**: ✅ Working
**Tests**: None
**Version**: v0.7.x

## Purpose

Document reading tools — read PDF, DOC, DOCX, RTF, HTML, and TXT files. Uses macOS-native `textutil` for Office formats and `pdf-parse` for PDFs. Provides `read_document` (text extraction) and `render_pdf_page` (page-as-image) tools.

## Architecture

Two-tier PDF handling:

1. `read_document` — try `pdf-parse` for text extraction, fall through to render-as-image if binary
2. `render_pdf_page` — render PDF page as PNG image for visual analysis (scanned docs, complex layouts)

## Events Handled

None — tools are called directly by the agent.

## Tools

| Tool              | Description                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_document`   | Extract text from documents. Supports `doc`, `docx`, `rtf`, `html`, `txt` (via textutil), `pdf` (via pdf-parse). Returns text with line count limit. |
| `render_pdf_page` | Render a PDF page as PNG image. Parameters: `path`, `page` (1-indexed), `scale` (1.0=72dpi, 1.5=108dpi, 2=144dpi).                                   |

## Key Patterns

- **Binary detection**: `isBinaryContent()` checks for null bytes and control character ratios to detect binary/content before attempting text extraction.
- **macOS integration**: Uses `textutil` command-line tool for Office format conversion — no external libraries needed for DOC/DOCX/RTF.
- **Format routing**: Automatic format detection from file extension — `textutil` for everything except PDF, which goes through `pdf-parse`.
- **Screenshot fallback**: If `read_document` on a PDF yields no text or binary content, suggests using `render_pdf_page` + `analyze_image` instead.
