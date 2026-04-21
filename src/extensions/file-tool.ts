import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../lib/logger.js";

const log = createLogger("file-tool.ts");

interface FileInfo {
	exists: boolean;
	isFile: boolean;
	isDirectory: boolean;
	isReadable: boolean;
	isWritable: boolean;
}

function getInfo(p: string): FileInfo {
	try {
		const s = fs.statSync(p, { throwIfNoEntry: false });
		if (!s) return { exists: false, isFile: false, isDirectory: false, isReadable: false, isWritable: false };
		let r = false,
			w = false;
		try {
			fs.accessSync(p, fs.constants.R_OK);
			r = true;
		} catch {}
		try {
			fs.accessSync(p, fs.constants.W_OK);
			w = true;
		} catch {}
		return { exists: true, isFile: s.isFile(), isDirectory: s.isDirectory(), isReadable: r, isWritable: w };
	} catch {
		return { exists: false, isFile: false, isDirectory: false, isReadable: false, isWritable: false };
	}
}

export default function fileToolExtension(pi: ExtensionAPI) {
	pi.registerCommand("file-info", {
		description: "Show file info",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const p = args.trim() || ".";
			const i = getInfo(p);
			if (!i.exists) {
				ctx.ui.notify(`Not found: ${p}`, "error");
				return;
			}
			ctx.ui.notify(`${p}: ${i.isFile ? "file" : "dir"}, R:${i.isReadable} W:${i.isWritable}`, "info");
		},
	});
}
