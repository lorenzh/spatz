// signals: transcript parsing for usage (Stop and SubagentStop). Pure: takes JSONL text.
// Spec: "Hooks", "Used pair". Facts: assistant entries have no promptId; dedupe by message.id.
import type { TranscriptUsage } from "../contracts/hooks.ts";

export interface ModelUsage {
	/** Raw model name from the transcript, e.g. "claude-sonnet-5-5" (caller canonicalizes). */
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
}

export interface CodexRollout {
	model: string;
	effort: string | null;
	usage: TranscriptUsage;
	calls: { command: string; exit_code: number }[];
	/** Epoch ms of the turn's last record; NaN when the rollout has no timestamps. */
	at: number;
}

type RolloutRecord = {
	timestamp?: unknown;
	type?: string;
	payload?: {
		[key: string]: unknown;
		turn_id?: string;
		model?: string;
		effort?: string;
		turn_token_usage?: {
			input_tokens?: number;
			cached_input_tokens?: number;
			cache_write_input_tokens?: number;
			output_tokens?: number;
		};
		usage?: {
			input_tokens?: number;
			cached_input_tokens?: number;
			cache_write_input_tokens?: number;
			output_tokens?: number;
		};
		call_id?: string;
		input?: string;
		output?: { text?: string }[];
		metadata?: { exit_code?: number };
		item?: {
			type?: string;
			id?: string;
			command?: string[];
			exit_code?: number;
		};
	};
};

/** Codex rollout records are append-only; tolerate partial lines and future record types. */
export function parseCodexRollout(
	jsonl: string,
	turnId: string,
): CodexRollout | null {
	const rows: RolloutRecord[] = [];
	for (const raw of jsonl.split("\n")) {
		try {
			const row = JSON.parse(raw);
			if (row && typeof row === "object") rows.push(row);
		} catch {}
	}
	const turn = rows.find(
		(r) => r.type === "turn_context" && r.payload?.turn_id === turnId,
	)?.payload;
	if (!turn || typeof turn.model !== "string") return null;
	const usageRow = rows
		.filter(
			(r) => r.type === "token_usage_record" && r.payload?.turn_id === turnId,
		)
		.at(-1)?.payload;
	const usage = usageRow?.turn_token_usage ?? {};
	const calls = new Map<string, string>();
	const exits = new Map<string, number>();
	const completed = new Map<string, CodexRollout["calls"][number]>();
	let currentTurn: string | undefined;
	let at = -Infinity;
	for (const { type, payload: p, timestamp } of rows) {
		if (type === "turn_context") currentTurn = p?.turn_id;
		if (!p || (p.turn_id ?? currentTurn) !== turnId) continue;
		const t = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
		if (Number.isFinite(t)) at = Math.max(at, t);
		if (type === "event_msg" && p.type === "item_completed") {
			const item = p.item;
			const argv = item?.command;
			if (
				item?.type === "CommandExecution" &&
				typeof item.id === "string" &&
				Number.isInteger(item.exit_code) &&
				Array.isArray(argv) &&
				argv.length === 3 &&
				typeof argv[0] === "string" &&
				/(?:^|\/)(?:bash|sh|zsh|dash|ksh)$/.test(argv[0]) &&
				(argv[1] === "-lc" || argv[1] === "-c") &&
				typeof argv[2] === "string"
			)
				completed.set(item.id, {
					command: argv[2],
					exit_code: item.exit_code as number,
				});
		}
		if (type !== "response_item" || !p) continue;
		if (p.type === "custom_tool_call" && typeof p.call_id === "string") {
			try {
				const encoded =
					typeof p.input === "string"
						? /cmd:\s*("[^"\n]*(?:\\.[^"\n]*)*")/.exec(p.input)?.[1]
						: undefined;
				const command = encoded ? JSON.parse(encoded) : null;
				if (typeof command === "string")
					calls.set(p.call_id, command.replaceAll("\\'", "'"));
			} catch {}
		}
		if (p.type === "custom_tool_call_output" && typeof p.call_id === "string") {
			const text = (Array.isArray(p.output) ? p.output : [])
				.map((x) =>
					x && typeof x === "object" && typeof x.text === "string"
						? x.text
						: "",
				)
				.join("\n");
			const code = /exit_code=(\d+)/.exec(text)?.[1];
			if (code !== undefined) exits.set(p.call_id, Number(code));
		}
		if (
			p.type === "function_call_output" &&
			typeof p.call_id === "string" &&
			Number.isInteger(p.metadata?.exit_code)
		)
			exits.set(p.call_id, p.metadata?.exit_code ?? 0);
	}
	return {
		model: turn.model,
		effort: typeof turn.effort === "string" ? turn.effort : null,
		at: Number.isFinite(at) ? at : NaN,
		usage: {
			input_tokens: usage.input_tokens ?? 0,
			cache_read_input_tokens: usage.cached_input_tokens ?? 0,
			cache_creation_input_tokens: usage.cache_write_input_tokens ?? 0,
			output_tokens: usage.output_tokens ?? 0,
		},
		// CommandExecution is authoritative when available; do not count its legacy mirror twice.
		calls: completed.size
			? [...completed.values()]
			: [...calls].flatMap(([id, command]) => {
					const code = exits.get(id);
					return code === undefined ? [] : [{ command, exit_code: code }];
				}),
	};
}

interface Line {
	type?: unknown;
	promptId?: unknown;
	timestamp?: unknown;
	message?: {
		id?: unknown;
		model?: unknown;
		usage?: TranscriptUsage;
		content?: unknown;
	};
}

/** One API message: model, usage and when it was written (epoch ms, NaN when missing). */
export interface AssistantMessage {
	model: string;
	at: number;
	usage: TranscriptUsage;
}

function* lines(jsonl: string): Generator<Line> {
	for (const raw of jsonl.split("\n")) {
		try {
			const v = JSON.parse(raw);
			if (v && typeof v === "object") yield v;
		} catch {
			// malformed line: skip
		}
	}
}

/** Assistant messages; each message.id counts once (one API message spans several entries). */
function assistantMessages(
	jsonl: string,
	inTurn: (entry: Line) => boolean,
): AssistantMessage[] {
	const seen = new Set<string>();
	const out: AssistantMessage[] = [];
	for (const e of lines(jsonl)) {
		if (!inTurn(e) || e.type !== "assistant") continue;
		const { id, model, usage = {} } = e.message ?? {};
		if (typeof id !== "string" || typeof model !== "string" || seen.has(id))
			continue;
		seen.add(id);
		const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
		out.push({ model, at, usage });
	}
	return out;
}

/** Sums usage per raw model name. */
export function sumByModel(messages: AssistantMessage[]): ModelUsage[] {
	const byModel = new Map<string, ModelUsage>();
	for (const { model, usage } of messages) {
		const u = byModel.get(model) ?? {
			model,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		};
		u.input_tokens += usage.input_tokens ?? 0;
		u.output_tokens += usage.output_tokens ?? 0;
		u.cache_read_tokens += usage.cache_read_input_tokens ?? 0;
		u.cache_creation_tokens += usage.cache_creation_input_tokens ?? 0;
		byModel.set(model, u);
	}
	return [...byModel.values()];
}

/** Assistant messages of the turn with this promptId (assistant entries after a user entry with that promptId, until a user entry with another promptId). Bad lines are skipped. */
export function mainTurnMessages(
	jsonl: string,
	promptId: string,
): AssistantMessage[] {
	let current: unknown;
	return assistantMessages(jsonl, (e) => {
		if (e.type === "user" && typeof e.promptId === "string")
			current = e.promptId;
		return current === promptId;
	});
}

/**
 * The assistant message that issued this tool call, found in any prompt; else the last message of the prompt
 * (undefined: of the whole transcript); null when there is none. A hook names its tool call and prompt, so
 * this gives the time and model of the event even when the hook runs late.
 */
export function toolCallMessage(
	jsonl: string,
	promptId: string | undefined,
	toolUseId: string,
): AssistantMessage | null {
	let current: unknown;
	let last: AssistantMessage | null = null;
	for (const e of lines(jsonl)) {
		if (e.type === "user" && typeof e.promptId === "string")
			current = e.promptId;
		if (e.type !== "assistant") continue;
		const { model, usage = {}, content } = e.message ?? {};
		const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
		if (typeof model !== "string" || !Number.isFinite(at)) continue;
		const message = { model, at, usage };
		if (
			Array.isArray(content) &&
			content.some((c) => c?.type === "tool_use" && c.id === toolUseId)
		)
			return message;
		// ponytail: the prompt's last message is a guess when the call is missing; a late hook may see a later message.
		if (promptId === undefined || current === promptId) last = message;
	}
	return last;
}

/** All assistant messages of a subagent transcript. */
export function subagentMessages(jsonl: string): AssistantMessage[] {
	return assistantMessages(jsonl, () => true);
}

/** The turn's usage summed per model. */
export const parseMainTranscript = (jsonl: string, promptId: string) =>
	sumByModel(mainTurnMessages(jsonl, promptId));

/** A subagent transcript's usage summed per model. */
export const parseSubagentTranscript = (jsonl: string) =>
	sumByModel(subagentMessages(jsonl));
