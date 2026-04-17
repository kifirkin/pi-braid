/**
 * Chart Renderer - ASCII bar charts for visual dashboard
 *
 * Uses box-drawing characters for visual feedback:
 * - █ (full block) for filled portions
 * - ░ (light shade) for empty portions
 */

const FULL_BLOCK = "█";
const LIGHT_SHADE = "░";
const VERTICAL = "│";
const HORIZONTAL = "─";
const TOP_LEFT = "┌";
const TOP_RIGHT = "┐";
const BOTTOM_LEFT = "└";
const BOTTOM_RIGHT = "┘";

/**
 * Render a horizontal bar chart
 */
export function renderBar(value: number, max: number, width = 20): string {
	const filled = Math.round((value / max) * width);
	const empty = width - filled;
	return FULL_BLOCK.repeat(filled) + LIGHT_SHADE.repeat(empty);
}

/**
 * Render a metric with label and bar
 */
export function renderMetricBar(label: string, value: number, max: number, width = 20, suffix = "%"): string {
	const bar = renderBar(value, max, width);
	const percent = max > 0 ? Math.round((value / max) * 100) : 0;
	return `${label.padEnd(12)} [${bar}] ${percent}${suffix}`;
}

/**
 * Render a horizontal bar with custom colors (terminal codes)
 */
export function renderColoredBar(value: number, max: number, width = 20, color?: string): string {
	const filled = Math.round((value / max) * width);
	const empty = width - filled;
	const reset = "\x1b[0m";
	const colorCode = color || "\x1b[32m"; // Default green
	return `${colorCode}${FULL_BLOCK.repeat(filled)}${reset}${LIGHT_SHADE.repeat(empty)}`;
}

/**
 * Render tool usage as a sorted bar chart
 */
export function renderToolUsageBars(toolCounts: Map<string, number>, topN = 8): string {
	const sorted = Array.from(toolCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, topN);

	if (sorted.length === 0) {
		return "  No tools used yet";
	}

	const maxCount = Math.max(...sorted.map(([, c]) => c));
	const lines: string[] = [];

	for (const [tool, count] of sorted) {
		const bar = renderBar(count, maxCount, 20);
		const percent = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
		lines.push(`  ${tool.padEnd(14)} [${bar}] ${count.toString().padStart(3)} (${percent}%)`);
	}

	return lines.join("\n");
}

/**
 * Render token budget bar
 */
export function renderTokenBudget(used: number, total: number, width = 30): string {
	const percent = total > 0 ? Math.round((used / total) * 100) : 0;
	const filled = Math.round((used / total) * width);

	// Color based on usage
	let color = "\x1b[32m"; // Green: <50%
	if (percent > 70) color = "\x1b[33m"; // Yellow: 50-70%
	if (percent > 85) color = "\x1b[31m"; // Red: >85%

	const reset = "\x1b[0m";
	const bar = `${color}${FULL_BLOCK.repeat(filled)}${reset}${LIGHT_SHADE.repeat(width - filled)}`;

	return `[${bar}] ${percent}% (${formatTokens(used)}/${formatTokens(total)})`;
}

/**
 * Format token count for display
 */
export function formatTokens(tokens: number): string {
	if (tokens >= 1000) {
		return `${(tokens / 1000).toFixed(1)}K`;
	}
	return tokens.toString();
}

/**
 * Render a simple progress indicator
 */
export function renderProgress(current: number, total: number, width = 30): string {
	if (total === 0) return `[${LIGHT_SHADE.repeat(width)}]`;

	const filled = Math.round((current / total) * width);
	const percent = Math.round((current / total) * 100);
	const bar = FULL_BLOCK.repeat(filled) + LIGHT_SHADE.repeat(width - filled);

	return `[${bar}] ${current}/${total} (${percent}%)`;
}

/**
 * Render a box with content
 */
export function renderBox(title: string, lines: string[], width = 50): string {
	const border = VERTICAL;
	const topBorder = TOP_LEFT + HORIZONTAL.repeat(width - 2) + TOP_RIGHT;
	const bottomBorder = BOTTOM_LEFT + HORIZONTAL.repeat(width - 2) + BOTTOM_RIGHT;

	const titleLine = `${VERTICAL} ${title.padEnd(width - 2)} ${VERTICAL}`;

	const contentLines = lines.map((line) => {
		const truncated = line.length > width - 4 ? line.slice(0, width - 7) + "..." : line;
		return `${border} ${truncated.padEnd(width - 4)} ${border}`;
	});

	return [topBorder, titleLine, ...contentLines, bottomBorder].join("\n");
}

/**
 * Render a mini dashboard section
 */
export function renderSection(title: string, content: string): string {
	const lines = content.split("\n");
	return renderBox(title, lines);
}
