import { describe, expect, test } from "bun:test";
import {
	parseCodexRollout,
	parseMainTranscript,
	parseSubagentTranscript,
} from "./transcript.ts";

const dir = `${import.meta.dir}/fixtures`;
const main = await Bun.file(`${dir}/main-transcript.jsonl`).text();
const sub = await Bun.file(`${dir}/subagent-transcript.jsonl`).text();
const PROMPT = "6d44bc7e-ba60-48d1-b58c-43c8ef31f1de";

const user = (promptId?: string) =>
	JSON.stringify({ type: "user", uuid: "u", promptId });
const asst = (id: string, model: string, out: number) =>
	JSON.stringify({
		type: "assistant",
		uuid: "a",
		message: {
			id,
			model,
			content: [{ type: "text", text: "SECRET OUTPUT" }],
			usage: { input_tokens: 1, output_tokens: out },
		},
	});

describe("parseMainTranscript", () => {
	test("main fixture: usage of the turn, one count per message.id", () => {
		expect(parseMainTranscript(main, PROMPT)).toEqual([
			{
				model: "claude-sonnet-5-5",
				input_tokens: 8,
				output_tokens: 405,
				cache_read_tokens: 129030,
				cache_creation_tokens: 32034,
			},
		]);
	});

	test("unknown promptId -> []", () => {
		expect(parseMainTranscript(main, "nope")).toEqual([]);
	});

	test("assistant entries belong to the closest preceding user entry with a promptId", () => {
		const jsonl = [
			asst("m0", "x", 1000), // before any prompt: no turn
			user("p1"),
			asst("m1", "claude-opus-5-5", 10),
			user(), // tool result without promptId keeps the turn
			asst("m2", "claude-sonnet-5-5", 20),
			user("p2"),
			asst("m3", "claude-opus-5-5", 300),
			user("p1"),
			asst("m4", "claude-opus-5-5", 5),
		].join("\n");
		expect(parseMainTranscript(jsonl, "p1")).toEqual([
			{
				model: "claude-opus-5-5",
				input_tokens: 2,
				output_tokens: 15,
				cache_read_tokens: 0,
				cache_creation_tokens: 0,
			},
			{
				model: "claude-sonnet-5-5",
				input_tokens: 1,
				output_tokens: 20,
				cache_read_tokens: 0,
				cache_creation_tokens: 0,
			},
		]);
		expect(parseMainTranscript(jsonl, "p2")).toEqual([
			{
				model: "claude-opus-5-5",
				input_tokens: 1,
				output_tokens: 300,
				cache_read_tokens: 0,
				cache_creation_tokens: 0,
			},
		]);
	});
});

describe("parseSubagentTranscript", () => {
	test("subagent fixture: all assistant entries", () => {
		expect(parseSubagentTranscript(sub)).toEqual([
			{
				model: "claude-sonnet-5-5",
				input_tokens: 4,
				output_tokens: 40,
				cache_read_tokens: 30989,
				cache_creation_tokens: 37202,
			},
		]);
	});
});

describe("robustness and privacy", () => {
	const messy = [
		"{broken",
		"",
		"null",
		"42",
		user("p1"),
		'{"type":"assistant"}',
		'{"type":"assistant","message":{"id":"x"}}',
		asst("m1", "claude-opus-5-5", 7),
		"not json at all",
	].join("\n");

	test("malformed lines are skipped without throwing", () => {
		const expected = [
			{
				model: "claude-opus-5-5",
				input_tokens: 1,
				output_tokens: 7,
				cache_read_tokens: 0,
				cache_creation_tokens: 0,
			},
		];
		expect(parseMainTranscript(messy, "p1")).toEqual(expected);
		expect(parseSubagentTranscript(messy)).toEqual(expected);
	});

	test("records contain only derived fields", () => {
		const keys = [
			"cache_creation_tokens",
			"cache_read_tokens",
			"input_tokens",
			"model",
			"output_tokens",
		];
		for (const r of [
			...parseMainTranscript(main, PROMPT),
			...parseSubagentTranscript(sub),
			...parseSubagentTranscript(messy),
		]) {
			expect(Object.keys(r).sort()).toEqual(keys);
			expect(JSON.stringify(r)).not.toContain("SECRET");
		}
	});
});

// Synthetic nonzero cache writes supplement the real fixture, whose cache writes are zero.
test.each([false, true])(
	"Codex cache counters stay per-turn (thread-only: %s)",
	(threadOnly) => {
		const prior = {
			input_tokens: 100,
			cached_input_tokens: 30,
			cache_write_input_tokens: 10,
			output_tokens: 5,
			reasoning_output_tokens: 2,
		};
		const turn = {
			input_tokens: 200,
			cached_input_tokens: 50,
			cache_write_input_tokens: 30,
			output_tokens: 15,
			reasoning_output_tokens: 6,
		};
		const total = {
			input_tokens: 300,
			cached_input_tokens: 80,
			cache_write_input_tokens: 40,
			output_tokens: 20,
			reasoning_output_tokens: 8,
		};
		const rows = [
			{
				type: "token_usage_record",
				payload: { turn_id: "previous", thread_token_usage: prior },
			},
			{
				type: "turn_context",
				payload: { turn_id: "current", model: "gpt-6.1-sol" },
			},
			{
				type: "token_usage_record",
				payload: {
					turn_id: "current",
					thread_token_usage: total,
					...(!threadOnly && { turn_token_usage: turn }),
				},
			},
			{
				type: "event_msg",
				payload: { type: "token_count", info: { total_token_usage: total } },
			},
			{ type: "event_msg", payload: { type: "token_count", info: null } },
		];
		expect(
			parseCodexRollout(
				rows.map((r) => JSON.stringify(r)).join("\n"),
				"current",
			)?.usage,
		).toEqual({
			input_tokens: 200,
			cache_read_input_tokens: 50,
			cache_creation_input_tokens: 30,
			output_tokens: 15,
		});
		if (!threadOnly) {
			// A resumed excerpt may lack the prior thread total: keep the explicit turn total over its mirror.
			expect(
				parseCodexRollout(
					rows
						.slice(1)
						.map((r) => JSON.stringify(r))
						.join("\n"),
					"current",
				)?.usage,
			).toEqual({
				input_tokens: 200,
				cache_read_input_tokens: 50,
				cache_creation_input_tokens: 30,
				output_tokens: 15,
			});
		}
	},
);
