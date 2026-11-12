/**
 * The page: one HTML file a reader can open with no server, no script and no
 * network. Every screenshot travels inside it as a data URI, and the numbers
 * printed under each shot are the manifest's own numbers.
 *
 * The page is a record, not a tool. It never computes a metric: it prints what
 * `./board.ts` decided, so the table, the shots and the manifest cannot
 * disagree. A human's verdict is the one thing left blank, because that is the
 * only column the ruler does not fill.
 */

import type {
  BoardManifest,
  BoardManifestMetric,
  BoardTable,
  BoardWidthRecord,
} from "./board.js";

export interface BoardShot {
  name: string;
  width: number;
  /** Base64 PNG, or null when the render was asked for no screenshots. */
  data: string | null;
  height: number | null;
}

export interface BoardPageInput {
  manifest: BoardManifest;
  table: BoardTable;
  shots: BoardShot[];
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(value: number | null, digits = 0): string {
  if (value === null) return "—";
  return digits === 0 ? String(value) : value.toFixed(digits);
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f6f6f4;
    color: #14140f;
    font: 15px/22px system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 1400px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 30px; line-height: 36px; margin: 4px 0 8px; }
  h2 { font-size: 20px; line-height: 26px; margin: 40px 0 12px; }
  h3 { font-size: 16px; line-height: 22px; margin: 0 0 4px; }
  p { margin: 0 0 8px; }
  .kicker {
    font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: #5c5c52;
  }
  .meta, .note, figcaption, .source { color: #4a4a42; font-size: 13px; line-height: 19px; }
  .decision {
    margin-top: 16px; padding: 12px 16px; border-radius: 8px;
    background: #14140f; color: #f6f6f4; font-size: 14px;
  }
  .decision strong { color: #ffd9a0; }
  .decision--open { background: #ffefd0; color: #4a3a10; }
  .decision--open strong { color: #4a3a10; text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  caption { caption-side: top; text-align: left; color: #4a4a42; font-size: 13px; padding-bottom: 8px; }
  th, td { border: 1px solid #d8d8d0; padding: 6px 8px; text-align: left; vertical-align: top; }
  thead th { background: #ecece6; font-size: 12px; text-transform: none; }
  tbody th { background: #fafaf6; font-weight: 600; white-space: nowrap; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.best { background: #e8f3e4; font-weight: 700; }
  td.best .mark {
    display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 4px;
    background: #2f6b2a; color: #fff; font-size: 10px; font-weight: 700;
    letter-spacing: 0.06em; vertical-align: 1px;
  }
  .swatch {
    display: inline-block; width: 11px; height: 11px; border-radius: 2px;
    border: 1px solid #9a9a90; vertical-align: -1px; margin-right: 4px;
  }
  td.verdict-cell { background: #fffdf7; border-bottom: 2px dotted #b9b9ad; min-width: 150px; }
  .gallery td { padding: 10px; }
  figure { margin: 0; }
  .frame {
    max-height: 420px; overflow: auto; background: #e9e9e2;
    border: 1px solid #d8d8d0; border-radius: 4px;
  }
  .frame img { display: block; width: 100%; height: auto; }
  .frame--empty {
    display: flex; align-items: center; justify-content: center;
    min-height: 120px; color: #6a6a60; font-size: 12px; padding: 8px;
    text-align: center;
  }
  .shot-numbers {
    margin-top: 6px; font-size: 12px; line-height: 17px;
    color: #3d3d36; font-variant-numeric: tabular-nums;
  }
  .detail { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 24px; }
  .card { background: #fff; border: 1px solid #d8d8d0; border-radius: 8px; padding: 16px; }
  .verdict { margin-top: 12px; }
  .verdict .prompt { font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #5c5c52; }
  .verdict .rule { display: block; height: 26px; border-bottom: 1px solid #c9c9bd; }
  footer { margin-top: 48px; border-top: 1px solid #d8d8d0; padding-top: 12px; color: #5c5c52; font-size: 12px; }
  code { font: 12px/18px ui-monospace, SFMono-Regular, Menlo, monospace; }
  @media print {
    body { background: #fff; }
    .frame { max-height: none; overflow: visible; }
    .card, table { break-inside: avoid; }
  }
`;

function metricHeader(metric: BoardManifestMetric): string {
  const arrow =
    metric.direction === "lower"
      ? " ↓"
      : metric.direction === "higher"
        ? " ↑"
        : "";
  const unit = metric.unit === "" ? "" : ` (${esc(metric.unit)})`;
  return `<th scope="col" class="num">${esc(metric.label)}${arrow}${unit}</th>`;
}

function comparisonRow(
  name: string,
  cells: BoardTable["rows"][number]["cells"],
): string {
  const printed = cells
    .map((cell) => {
      const swatch =
        cell.colour === null
          ? ""
          : `<span class="swatch" style="background:${esc(cell.colour)}"></span>`;
      const detail =
        cell.colour === null ? "" : ` <code>${esc(cell.colour)}</code>`;
      const mark = cell.best ? ` <span class="mark">best</span>` : "";
      const klass = cell.best ? "num best" : "num";
      return `<td class="${klass}">${swatch}${esc(cell.display)}${detail}${mark}</td>`;
    })
    .join("");
  return `<tr><th scope="row">${esc(name)}</th>${printed}<td class="verdict-cell"></td></tr>`;
}

function shotCell(
  variant: string,
  record: BoardWidthRecord | undefined,
  shot: BoardShot | undefined,
): string {
  if (record === undefined) {
    return `<td class="num">—</td>`;
  }
  const caption = `${record.width}px · page ${record.documentHeight}px tall`;
  const frame =
    shot === undefined || shot.data === null
      ? `<div class="frame frame--empty">no screenshot recorded at ${record.width}px</div>`
      : `<div class="frame"><img alt="${esc(variant)} at ${record.width}px" src="data:image/png;base64,${shot.data}"></div>`;
  const numbers =
    `${record.contrast.failing}/${record.contrast.checked} failing · ` +
    `weakest ${num(record.contrast.smallest, 2)} · ` +
    `taps ${record.tapTargets} · overflow ${record.overflow} · ` +
    `values ${record.values.total} · palette ${record.palette}`;
  const dominant =
    record.dominant === null
      ? ""
      : ` · <span class="swatch" style="background:${esc(record.dominant.value)}"></span>` +
        `<code>${esc(record.dominant.value)}</code> ${record.dominant.coverage.toFixed(1)}%`;
  return (
    `<td><figure>${frame}<figcaption>${esc(caption)}</figcaption>` +
    `<p class="shot-numbers">${esc(numbers)}${dominant}</p></figure></td>`
  );
}

function detailCard(variant: BoardManifest["variants"][number]): string {
  const headers = [
    "width",
    "page height",
    "contrast pair (checked)",
    "contrast failures",
    "weakest ratio",
    "tap targets",
    "overflow",
    "distinct values",
    "off-grid values",
    "palette",
    "dominant colour",
  ]
    .map((label, index) =>
      index === 0
        ? `<th scope="col">${label}</th>`
        : `<th scope="col" class="num">${label}</th>`,
    )
    .join("");
  const rows = variant.widths
    .map((record) => {
      const dominant =
        record.dominant === null
          ? "—"
          : `<span class="swatch" style="background:${esc(record.dominant.value)}"></span>` +
            `<code>${esc(record.dominant.value)}</code> ${record.dominant.coverage.toFixed(1)}%`;
      return (
        `<tr><th scope="row">${record.width}px</th>` +
        `<td class="num">${record.documentHeight}</td>` +
        `<td class="num">${record.contrast.checked}</td>` +
        `<td class="num">${record.contrast.failing}</td>` +
        `<td class="num">${num(record.contrast.smallest, 2)}</td>` +
        `<td class="num">${record.tapTargets}</td>` +
        `<td class="num">${record.overflow}</td>` +
        `<td class="num">${record.values.total}</td>` +
        `<td class="num">${record.values.offGrid}</td>` +
        `<td class="num">${record.palette}</td>` +
        `<td class="num">${dominant}</td></tr>`
      );
    })
    .join("");
  const failing = variant.widths
    .flatMap((record) =>
      record.contrast.failingPaths.map(
        (path) => `<li><code>${esc(path)}</code> at ${record.width}px</li>`,
      ),
    )
    .join("");
  return (
    `<article class="card">` +
    `<h3>${esc(variant.name)}</h3>` +
    `<p class="source">${esc(variant.source)} (${variant.sourceKind})</p>` +
    `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>` +
    (failing === ""
      ? `<p class="source">No contrast pair failed at any measured width.</p>`
      : `<p class="source">Failing pairs:</p><ul class="source">${failing}</ul>`) +
    `<div class="verdict"><p class="prompt">Would you build this? Why:</p>` +
    `<span class="rule"></span><span class="rule"></span><span class="rule"></span></div>` +
    `</article>`
  );
}

export function renderBoardPage(input: BoardPageInput): string {
  const { manifest, table, shots } = input;
  const widths = manifest.widths;
  const shotsByName = new Map<string, BoardShot[]>();
  for (const shot of shots) {
    const list = shotsByName.get(shot.name) ?? [];
    list.push(shot);
    shotsByName.set(shot.name, list);
  }

  const galleryHead =
    `<tr><th scope="col">variant</th>` +
    widths.map((width) => `<th scope="col">${width}px</th>`).join("") +
    `</tr>`;
  const galleryRows = manifest.variants
    .map((variant) => {
      const variantShots = shotsByName.get(variant.name) ?? [];
      const cells = widths
        .map((width) =>
          shotCell(
            variant.name,
            variant.widths.find((record) => record.width === width),
            variantShots.find((shot) => shot.width === width),
          ),
        )
        .join("");
      return `<tr><th scope="row">${esc(variant.name)}</th>${cells}</tr>`;
    })
    .join("");

  const decision =
    manifest.decision === null
      ? `<p class="decision decision--open"><strong>Undecided</strong> — this record carries no decision. ` +
        `Name a variant and a reason in <code>board.json</code> (or pass a decision) and regenerate the board.</p>`
      : `<p class="decision"><strong>Decision: ${esc(manifest.decision.variant)}</strong> — ${esc(manifest.decision.reason)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(manifest.title)} — variant board</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<p class="kicker">Variant board</p>
<h1>${esc(manifest.title)}</h1>
<p class="meta">${manifest.variants.length} variant${manifest.variants.length === 1 ? "" : "s"} × ${widths.length} width${widths.length === 1 ? "" : "s"} (${widths.map((width) => `${width}px`).join(", ")}). Every number below is the design ruler's, measured on the rendered page.</p>
${decision}
</header>

<section>
<h2>Comparison</h2>
<table>
<caption>${esc(table.note)}</caption>
<thead><tr><th scope="col">variant</th>${table.metrics.map(metricHeader).join("")}<th scope="col">verdict (human)</th></tr></thead>
<tbody>${table.rows.map((row) => comparisonRow(row.name, row.cells)).join("")}</tbody>
</table>
</section>

<section>
<h2>Rendered</h2>
<table class="gallery">
<thead>${galleryHead}</thead>
<tbody>${galleryRows}</tbody>
</table>
</section>

<section>
<h2>Numbers per width</h2>
<div class="detail">${manifest.variants.map((variant) => detailCard(variant)).join("")}</div>
</section>

<footer>
<p>Record: <code>${esc(manifest.pageDigest)}</code> · format ${manifest.format} · ${esc(manifest.tool)} ${esc(manifest.toolVersion)}. The digest covers the numbers and the decision on this page; the screenshots are a visual record only.</p>
</footer>
</main>
</body>
</html>
`;
}
