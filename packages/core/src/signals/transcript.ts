// signals: transcript parsing for usage (Stop and SubagentStop). Pure: takes JSONL text.
// Spec: "Hooks", "Genutztes Paar". Facts: assistant entries have no promptId; dedupe by message.id.
import type { TranscriptUsage } from "../contracts/hooks.ts";

export interface ModelUsage {
	/** Raw model name from the transcript, e.g. "claude-sonnet-5-5" (caller canonicalizes). */
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
}

interface Line {
	type?: unknown;
	promptId?: unknown;
	timestamp?: unknown;
	message?: { id?: unknown; model?: unknown; usage?: TranscriptUsage };
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
