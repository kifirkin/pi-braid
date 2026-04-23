/**
 * Timer Extension — Non-blocking Pomodoro-style reminders
 *
 * Agent sets a timer, continues working, gets a reminder when it fires.
 * This replaces bash `sleep` which blocks the tool call.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../../lib/logger.js";
import { Type } from "typebox";

const log = createLogger("timer");

// ── Timer Manager ─────────────────────────────────────────────────────────────

interface ScheduledTimer {
	id: string;
	firesAt: number; // Unix timestamp (ms)
	reason: string;
	tag?: string;
	createdAt: number;
}

class TimerManager {
	private timers: Map<string, ScheduledTimer> = new Map();

	setTimer(delayMs: number, reason: string, tag?: string): string {
		const id = `timer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		const firesAt = Date.now() + delayMs;

		this.timers.set(id, { id, firesAt, reason, tag, createdAt: Date.now() });
		log.info(`[timer] set: ${id} fires in ${Math.round(delayMs / 1000)}s — ${reason}`);
		return id;
	}

	cancelTimer(id: string): boolean {
		const deleted = this.timers.delete(id);
		if (deleted) log.info(`[timer] cancelled: ${id}`);
		return deleted;
	}

	listTimers(): ScheduledTimer[] {
		return Array.from(this.timers.values()).sort((a, b) => a.firesAt - b.firesAt);
	}

	// Called on each turn_end
	checkExpired(nowMs: number): ScheduledTimer[] {
		const expired: ScheduledTimer[] = [];
		for (const [id, timer] of this.timers) {
			if (timer.firesAt <= nowMs) {
				expired.push(timer);
				this.timers.delete(id);
				log.info(`[timer] fired: ${id} — ${timer.reason}`);
			}
		}
		return expired;
	}

	getActiveCount(): number {
		return this.timers.size;
	}
}

const timerManager = new TimerManager();

// ── Fire Handlers ─────────────────────────────────────────────────────────────

type TimerFireHandler = (timer: ScheduledTimer) => void;
const fireHandlers: Set<TimerFireHandler> = new Set();

export function onTimerFire(handler: TimerFireHandler): () => void {
	fireHandlers.add(handler);
	return () => fireHandlers.delete(handler);
}

function emitTimerFire(timer: ScheduledTimer): void {
	for (const handler of fireHandlers) {
		try {
			handler(timer);
		} catch (err) {
			log.error(`[timer] handler error:`, err);
		}
	}
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function timerExtension(pi: ExtensionAPI): void {
	// timer_set
	pi.registerTool({
		name: "timer_set",
		label: "Timer Set",
		description:
			"Set a non-blocking timer (in seconds). Returns immediately — does NOT hang. " +
			"When the timer fires, a reminder will be injected. " +
			"Use for: builds, background processes, pomodoro cycles, escalation chains.",
		parameters: Type.Object({
			delay_seconds: Type.Number({ minimum: 1, maximum: 86400 }),
			reason: Type.String({ minLength: 1 }),
			tag: Type.Optional(Type.String()),
		}),
		execute: async (_id: string, params: any): Promise<any> => {
			const { delay_seconds, reason, tag } = params ?? {};

			if (tag && !/^[a-zA-Z0-9_-]+$/.test(tag)) {
				throw new Error(`Invalid tag "${tag}" — use alphanumeric + dash/underscore`);
			}

			const delayMs = (delay_seconds ?? 60) * 1000;
			const id = timerManager.setTimer(delayMs, reason ?? "Timer", tag);
			const firesAt = Date.now() + delayMs;

			return {
				content: `Timer set for ${delay_seconds}s. Will fire at ${new Date(firesAt).toLocaleTimeString()}. Continue working — reminder will arrive automatically.`,
				details: {
					timer_id: id,
					fires_at: new Date(firesAt).toISOString(),
					fires_in_seconds: delay_seconds,
					active_timers: timerManager.getActiveCount(),
				},
			};
		},
	} as any);

	// timer_list
	pi.registerTool({
		name: "timer_list",
		label: "Timer List",
		description: "List all active (non-expired) timers.",
		parameters: Type.Object({}),
		execute: async (): Promise<any> => {
			const timers = timerManager.listTimers();
			const now = Date.now();

			if (timers.length === 0) {
				return {
					content: "No active timers.",
					details: { active_timers: 0, timers: [] },
				};
			}

			const formatted = timers.map((t) => ({
				timer_id: t.id,
				tag: t.tag ?? "(untagged)",
				reason: t.reason,
				fires_in_seconds: Math.max(0, Math.ceil((t.firesAt - now) / 1000)),
				fires_at: new Date(t.firesAt).toLocaleTimeString(),
			}));

			return {
				content: `${timers.length} active timer(s). ${formatted.map((t) => `[${t.tag}] fires in ${t.fires_in_seconds}s: ${t.reason}`).join("; ")}`,
				details: { active_timers: timers.length, timers: formatted },
			};
		},
	} as any);

	// timer_cancel
	pi.registerTool({
		name: "timer_cancel",
		label: "Timer Cancel",
		description: "Cancel an active timer before it fires.",
		parameters: Type.Object({ timer_id: Type.String() }),
		execute: async (_id: string, params: any): Promise<any> => {
			const { timer_id } = params ?? {};
			const cancelled = timerManager.cancelTimer(timer_id);
			if (!cancelled) {
				throw new Error(`Timer "${timer_id}" not found or already fired.`);
			}
			return {
				content: `Timer "${timer_id}" cancelled.`,
				details: { cancelled: true, timer_id, active_timers: timerManager.getActiveCount() },
			};
		},
	} as any);

	// Check expired timers on each turn_end
	pi.on("turn_end", () => {
		const expired = timerManager.checkExpired(Date.now());
		for (const timer of expired) {
			emitTimerFire(timer);
		}
	});

	log.info("[timer] loaded: timer_set, timer_list, timer_cancel");
}
