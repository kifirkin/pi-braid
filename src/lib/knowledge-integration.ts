/**
 * Knowledge Integration System
 *
 * Based on: docs/analysis/SUPER_AGENT_GAP_ANALYSIS.md (Gap 7 - MEDIUM)
 * Lightweight file-based implementation for learning from docs and repos.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface KnowledgeDoc {
	id: string;
	url: string;
	topic: string;
	content: string;
	summary: string;
	keyFacts: string[];
	fetchedAt: number;
	lastAccessed: number;
	accessCount: number;
}

export interface CodePattern {
	id: string;
	repoUrl: string;
	pattern: string;
	description: string;
	examples: string[];
	filePaths: string[];
	learnedAt: number;
}

export interface KnowledgeState {
	docs: KnowledgeDoc[];
	patterns: CodePattern[];
	version: number;
}

const _DEFAULT_STATE: KnowledgeState = {
	docs: [],
	patterns: [],
	version: 1,
};

export class KnowledgeIntegration {
	private docs = new Map<string, KnowledgeDoc>();
	private patterns = new Map<string, CodePattern>();
	private storagePath: string | null = null;

	/**
	 * Initialize with optional persistence
	 */
	initialize(storageDir?: string): void {
		if (storageDir) {
			this.storagePath = join(storageDir, "knowledge.json");
			this.load();
		}
	}

	/**
	 * Store documentation knowledge
	 */
	storeDoc(url: string, topic: string, content: string, summary?: string): KnowledgeDoc {
		const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

		// Auto-generate summary if not provided (first 200 chars)
		const autoSummary = summary || `${content.slice(0, 200).replace(/\s+/g, " ")}...`;

		// Extract key facts (lines that look like important points)
		const keyFacts = content
			.split("\n")
			.filter((line) => {
				const trimmed = line.trim();
				// Look for bullet points, numbered lists, or key sentences
				return (
					(trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+\./.test(trimmed)) && trimmed.length > 20
				);
			})
			.slice(0, 10); // Limit to 10 facts

		const doc: KnowledgeDoc = {
			id,
			url,
			topic,
			content: content.slice(0, 50000), // Limit size
			summary: autoSummary,
			keyFacts,
			fetchedAt: Date.now(),
			lastAccessed: Date.now(),
			accessCount: 0,
		};

		this.docs.set(id, doc);
		this.save();
		return doc;
	}

	/**
	 * Search docs by topic or content
	 */
	searchDocs(query: string): KnowledgeDoc[] {
		const lowerQuery = query.toLowerCase();
		const results: KnowledgeDoc[] = [];

		for (const doc of this.docs.values()) {
			if (
				doc.topic.toLowerCase().includes(lowerQuery) ||
				doc.content.toLowerCase().includes(lowerQuery) ||
				doc.summary.toLowerCase().includes(lowerQuery)
			) {
				doc.accessCount++;
				doc.lastAccessed = Date.now();
				results.push(doc);
			}
		}

		this.save();
		return results.sort((a, b) => b.accessCount - a.accessCount);
	}

	/**
	 * Get docs by topic
	 */
	getByTopic(topic: string): KnowledgeDoc[] {
		return Array.from(this.docs.values())
			.filter((d) => d.topic.toLowerCase() === topic.toLowerCase())
			.sort((a, b) => b.fetchedAt - a.fetchedAt);
	}

	/**
	 * Get a specific doc
	 */
	getDoc(id: string): KnowledgeDoc | undefined {
		const doc = this.docs.get(id);
		if (doc) {
			doc.accessCount++;
			doc.lastAccessed = Date.now();
			this.save();
		}
		return doc;
	}

	/**
	 * Store a learned code pattern
	 */
	storePattern(
		repoUrl: string,
		pattern: string,
		description: string,
		examples: string[],
		filePaths: string[],
	): CodePattern {
		const id = `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

		const p: CodePattern = {
			id,
			repoUrl,
			pattern,
			description,
			examples: examples.slice(0, 5), // Limit examples
			filePaths: filePaths.slice(0, 10), // Limit paths
			learnedAt: Date.now(),
		};

		this.patterns.set(id, p);
		this.save();
		return p;
	}

	/**
	 * Search patterns
	 */
	searchPatterns(query: string): CodePattern[] {
		const lowerQuery = query.toLowerCase();
		return Array.from(this.patterns.values()).filter(
			(p) => p.pattern.toLowerCase().includes(lowerQuery) || p.description.toLowerCase().includes(lowerQuery),
		);
	}

	/**
	 * Get patterns for a repo
	 */
	getPatternsByRepo(repoUrl: string): CodePattern[] {
		return Array.from(this.patterns.values())
			.filter((p) => p.repoUrl === repoUrl)
			.sort((a, b) => b.learnedAt - a.learnedAt);
	}

	/**
	 * Get all learned docs
	 */
	getAllDocs(): KnowledgeDoc[] {
		return Array.from(this.docs.values()).sort((a, b) => b.fetchedAt - a.fetchedAt);
	}

	/**
	 * Get all patterns
	 */
	getAllPatterns(): CodePattern[] {
		return Array.from(this.patterns.values()).sort((a, b) => b.learnedAt - a.learnedAt);
	}

	/**
	 * Delete a doc
	 */
	deleteDoc(id: string): boolean {
		const deleted = this.docs.delete(id);
		if (deleted) this.save();
		return deleted;
	}

	/**
	 * Delete a pattern
	 */
	deletePattern(id: string): boolean {
		const deleted = this.patterns.delete(id);
		if (deleted) this.save();
		return deleted;
	}

	/**
	 * Get summary
	 */
	getSummary(): {
		docCount: number;
		patternCount: number;
		topics: string[];
	} {
		const topics = [...new Set(Array.from(this.docs.values()).map((d) => d.topic))];
		return {
			docCount: this.docs.size,
			patternCount: this.patterns.size,
			topics,
		};
	}

	/**
	 * Export to markdown for human review
	 */
	exportToMarkdown(): string {
		let md = "# Learned Knowledge\n\n";

		md += "## Documentation\n\n";
		for (const doc of this.getAllDocs()) {
			md += `### ${doc.topic}\n\n`;
			md += `- **Source:** ${doc.url}\n`;
			md += `- **Fetched:** ${new Date(doc.fetchedAt).toLocaleDateString()}\n`;
			md += `- **Accessed:** ${doc.accessCount} times\n\n`;
			md += `${doc.summary}\n\n`;
			if (doc.keyFacts.length > 0) {
				md += "**Key Facts:**\n";
				for (const fact of doc.keyFacts) {
					md += `- ${fact}\n`;
				}
				md += "\n";
			}
		}

		md += "## Code Patterns\n\n";
		for (const pattern of this.getAllPatterns()) {
			md += `### ${pattern.pattern}\n\n`;
			md += `- **Repo:** ${pattern.repoUrl}\n`;
			md += `- **Learned:** ${new Date(pattern.learnedAt).toLocaleDateString()}\n\n`;
			md += `${pattern.description}\n\n`;
			if (pattern.examples.length > 0) {
				md += "**Examples:**\n";
				for (const ex of pattern.examples) {
					md += `\`\`\`\n${ex}\n\`\`\`\n`;
				}
			}
		}

		return md;
	}

	private save(): void {
		if (!this.storagePath) return;

		try {
			const dir = dirname(this.storagePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}

			const state: KnowledgeState = {
				docs: Array.from(this.docs.values()),
				patterns: Array.from(this.patterns.values()),
				version: 1,
			};

			writeFileSync(this.storagePath, JSON.stringify(state, null, 2));
		} catch {
			// Silent fail
		}
	}

	private load(): void {
		if (!this.storagePath) return;
		if (!existsSync(this.storagePath)) return;

		try {
			const data = readFileSync(this.storagePath, "utf-8");
			const loaded = JSON.parse(data) as KnowledgeState;

			this.docs.clear();
			for (const doc of loaded.docs || []) {
				this.docs.set(doc.id, doc);
			}

			this.patterns.clear();
			for (const pattern of loaded.patterns || []) {
				this.patterns.set(pattern.id, pattern);
			}
		} catch {
			// Silent fail
		}
	}
}
