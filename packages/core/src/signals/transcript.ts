// signals: transcript parsing for usage (Stop and SubagentStop). Pure: takes JSONL text.
// Spec: "Hooks", "Used pair". Facts: assistant entries have no promptId; dedupe by message.id.
import type { TranscriptUsage } from "../contracts/hooks.ts";

export interface ModelUsage {
	/** Raw model name from the transcript, e.g. "claude-sonnet-5-5" (caller canonicalizes). */
	model: string;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_creation_tokens: number | null;
}

export interface CodexRollout {
	model: string;
	effort: string | null;
	usage: TranscriptUsage | null;
	at: number | null;
	session_id: string | null;
	usage_at: number | null;
	usage_revision: number;
	mixed_pair: boolean;
	segments: {
		key: string;
		source_seq: number;
		at: number | null;
		model: string;
		effort: string | null;
	}[];
	calls: {
		id: string;
		command: string;
		exit_code: number;
		source_seq: number;
		at: number | null;
		model: string;
		effort: string | null;
	}[];
}

type CodexUsage = {
	input_tokens?: number | null;
	cached_input_tokens?: number | null;
	cache_write_input_tokens?: number | null;
	/** Includes reasoning_output_tokens; do not add them again. */
	output_tokens?: number | null;
	reasoning_output_tokens?: number | null;
	total_tokens?: number | null;
};

const CODEX_TOKEN_FIELDS = [
	"input_tokens",
	"cached_input_tokens",
	"cache_write_input_tokens",
	"output_tokens",
] as const;

type RolloutRecord = {
	timestamp?: string;
	type?: string;
	payload?: {
		[key: string]: unknown;
		turn_id?: string;
		model?: string;
		effort?: string;
		turn_token_usage?: CodexUsage;
		thread_token_usage?: CodexUsage;
		usage?: CodexUsage;
		info?: { total_token_usage?: CodexUsage };
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
function codexRecords(jsonl: string): RolloutRecord[] {
	const rows: RolloutRecord[] = [];
	for (const raw of jsonl.split("\n")) {
		try {
			const row = JSON.parse(raw);
			if (row && typeof row === "object") rows.push(row);
		} catch {}
	}
	return rows;
}

/** Parse all turns for an explicit run import. Turn IDs, not file paths, identify replays. */
export function parseCodexRollouts(jsonl: string): Map<string, CodexRollout> {
	const rows = codexRecords(jsonl);
	const turns = new Map<string, CodexRollout>();
	for (const row of rows) {
		const id = row.payload?.turn_id;
		if (
			row.type !== "turn_context" ||
			typeof id !== "string" ||
			!id ||
			turns.has(id)
		)
			continue;
		// ponytail: one scan per turn; index records if long resumed sessions make imports slow.
		const rollout = parseCodexTurn(rows, id);
		if (rollout) turns.set(id, rollout);
	}
	return turns;
}

export function parseCodexRollout(
	jsonl: string,
	turnId: string,
): CodexRollout | null {
	return parseCodexTurn(codexRecords(jsonl), turnId);
}

function parseCodexTurn(
	rows: RolloutRecord[],
	turnId: string,
): CodexRollout | null {
	const first = rows.find(
		(r) => r.type === "turn_context" && r.payload?.turn_id === turnId,
	);
	const turn = first?.payload;
	if (!turn || typeof turn.model !== "string") return null;
	let usage: CodexUsage | null = null;
	let turnUsage: CodexUsage | null = null;
	let threadUsage: CodexUsage | null = null;
	let beforeTurn: CodexUsage | null = null;
	const calls = new Map<
		string,
		Omit<CodexRollout["calls"][number], "exit_code">
	>();
	let model = turn.model;
	let effort = typeof turn.effort === "string" ? turn.effort : null;
	let mixed_pair = false;
	let usage_revision = 0;
	let usage_at: number | null = null;
	const metaId = rows.find((row) => row.type === "session_meta")?.payload?.id;
	let session_id: string | null = typeof metaId === "string" ? metaId : null;
	const exits = new Map<string, number>();
	const completed = new Map<string, CodexRollout["calls"][number]>();
	let currentTurn: string | undefined;
	const segments: CodexRollout["segments"] = [];
	const contextIndexes = new Map<string, number>();
	let segment: CodexRollout["segments"][number] | undefined;
	for (const [source_seq, row] of rows.entries()) {
		const { type, payload: p } = row;
		const at = sourceTime(row.timestamp);
		if (type === "turn_context") {
			if (typeof p?.model === "string") {
				const nextEffort = typeof p.effort === "string" ? p.effort : null;
				if (
					!segment ||
					segment.model !== p.model ||
					segment.effort !== nextEffort
				) {
					const id = p.turn_id ?? "";
					const index = contextIndexes.get(id) ?? 0;
					contextIndexes.set(id, index + 1);
					segment = {
						key: `${id}:${index}`,
						source_seq,
						at,
						model: p.model,
						effort: nextEffort,
					};
				}
				if (
					p.turn_id === turnId &&
					!segments.some((s) => s.key === segment?.key)
				)
					segments.push(segment);
			}
			if (p?.turn_id === turnId && currentTurn !== turnId)
				beforeTurn = threadUsage;
			currentTurn = p?.turn_id;
			if (currentTurn === turnId && typeof p?.model === "string") {
				model = p.model;
				effort = typeof p.effort === "string" ? p.effort : null;
				mixed_pair ||= model !== turn.model || effort !== (turn.effort ?? null);
			}
		}
		const total =
			type === "token_usage_record"
				? p?.thread_token_usage
				: type === "event_msg" && p?.type === "token_count"
					? p.info?.total_token_usage
					: undefined;
		if ((p?.turn_id ?? currentTurn) === turnId) {
			if (typeof p?.session_id === "string") session_id = p.session_id;
			else if (typeof p?.thread_id === "string") session_id ??= p.thread_id;
			if (
				type === "token_usage_record" ||
				(type === "event_msg" && p?.type === "token_count")
			) {
				usage_revision = source_seq;
				usage_at = at;
			}
			if (type === "token_usage_record" && p?.turn_token_usage) {
				usage = turnUsage = p.turn_token_usage;
			} else if (total && !turnUsage) {
				// After compaction, token_count can lag behind explicit turn totals.
				usage = Object.fromEntries(
					CODEX_TOKEN_FIELDS.map((key) => {
						const current = tokenCount(total[key]);
						const before =
							beforeTurn === null ? 0 : tokenCount(beforeTurn[key]);
						return [
							key,
							current === null || before === null ? null : current - before,
						];
					}),
				);
				if (Object.values(usage).some((value) => value !== null && value < 0))
					usage = null;
			} else if (type === "token_usage_record" && p?.usage) {
				// With no totals, each usage object describes one response in the turn.
				usage = Object.fromEntries(
					CODEX_TOKEN_FIELDS.map((key) => [
						key,
						sumTokens(usage === null ? 0 : usage[key], p.usage?.[key]),
					]),
				);
			}
		}
		if (total) threadUsage = total;
		if (!p || (p.turn_id ?? currentTurn) !== turnId) continue;
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
					id: `completed:${item.id}`,
					source_seq,
					at,
					model,
					effort,
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
					calls.set(p.call_id, {
						id: `legacy:${p.call_id}`,
						command: command.replaceAll("\\'", "'"),
						source_seq,
						at,
						model,
						effort,
					});
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
			else {
				// exec can print its structured result as a separate JSON text block.
				for (const block of Array.isArray(p.output) ? p.output : []) {
					try {
						const result = JSON.parse(block.text ?? "");
						if (Number.isInteger(result?.exit_code))
							exits.set(p.call_id, result.exit_code);
					} catch {}
				}
			}
		}
		if (
			p.type === "function_call_output" &&
			typeof p.call_id === "string" &&
			Number.isInteger(p.metadata?.exit_code)
		)
			exits.set(p.call_id, p.metadata?.exit_code ?? 0);
	}
	const input = tokenCount(usage?.input_tokens);
	const cacheRead = tokenCount(usage?.cached_input_tokens);
	const cacheWrite = tokenCount(usage?.cache_write_input_tokens);
	return {
		at: sourceTime(first?.timestamp),
		session_id,
		usage_at,
		usage_revision,
		mixed_pair,
		segments,
		model: turn.model,
		effort: typeof turn.effort === "string" ? turn.effort : null,
		usage: usage
			? {
					// Responses input includes both cache buckets; output includes reasoning.
					input_tokens:
						input === null || cacheRead === null || cacheWrite === null
							? null
							: tokenCount(input - cacheRead - cacheWrite),
					cache_read_input_tokens: cacheRead,
					cache_creation_input_tokens: cacheWrite,
					output_tokens: tokenCount(usage.output_tokens),
				}
			: null,
		// CommandExecution is authoritative when available; do not count its legacy mirror twice.
		calls: completed.size
			? [...completed.values()]
			: [...calls].flatMap(([id, command]) => {
					const code = exits.get(id);
					return code === undefined ? [] : [{ ...command, exit_code: code }];
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
		content?: { type?: string; id?: string; name?: string }[];
	};
}

/** One API message: model, usage and when it was written (epoch ms, NaN when missing). */
export interface AssistantMessage {
	prompt_id?: string | null;
	id: string;
	source_seq: number;
	calls: { id: string; name: string }[];
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
	const seen = new Map<string, AssistantMessage>();
	const out: AssistantMessage[] = [];
	let prompt_id: string | null = null;
	for (const [source_seq, e] of [...lines(jsonl)].entries()) {
		if (e.type === "user" && typeof e.promptId === "string")
			prompt_id = e.promptId;
		if (!inTurn(e) || e.type !== "assistant") continue;
		const { id, model, usage = {}, content = [] } = e.message ?? {};
		if (typeof id !== "string" || typeof model !== "string") continue;
		let message = seen.get(id);
		if (!message) {
			message = {
				prompt_id,
				id,
				model,
				at: sourceTime(e.timestamp) ?? NaN,
				source_seq,
				calls: [],
				usage: usage ?? {},
			};
			seen.set(id, message);
			out.push(message);
		}
		for (const block of Array.isArray(content) ? content : []) {
			if (
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				typeof block.name === "string" &&
				!message.calls.some((call) => call.id === block.id)
			)
				message.calls.push({ id: block.id, name: block.name });
		}
	}
	return out;
}

/** Missing or malformed counters are unknown; a reported zero remains zero. */
const tokenCount = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;

const sumTokens = (a: unknown, b: unknown): number | null => {
	const left = tokenCount(a);
	const right = tokenCount(b);
	return left === null || right === null ? null : tokenCount(left + right);
};

/** Sums usage per raw model name; any unknown message counter makes its total unknown. */
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
		u.input_tokens = sumTokens(u.input_tokens, usage.input_tokens);
		u.output_tokens = sumTokens(u.output_tokens, usage.output_tokens);
		u.cache_read_tokens = sumTokens(
			u.cache_read_tokens,
			usage.cache_read_input_tokens,
		);
		u.cache_creation_tokens = sumTokens(
			u.cache_creation_tokens,
			usage.cache_creation_input_tokens,
		);
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

/** Only source timestamps can open a fallback attribution window. */
export function sourceTime(value: unknown): number | null {
	const at = typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(at) ? at : null;
}
