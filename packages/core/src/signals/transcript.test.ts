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
				cache_read_tokens: null,
				cache_creation_tokens: null,
			},
			{
				model: "claude-sonnet-5-5",
				input_tokens: 1,
				output_tokens: 20,
				cache_read_tokens: null,
				cache_creation_tokens: null,
			},
		]);
		expect(parseMainTranscript(jsonl, "p2")).toEqual([
			{
				model: "claude-opus-5-5",
				input_tokens: 1,
				output_tokens: 300,
				cache_read_tokens: null,
				cache_creation_tokens: null,
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
				cache_read_tokens: null,
				cache_creation_tokens: null,
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

test.each([250, 50])(
	"Codex turn usage survives lagging token_count after compaction (%s)",
	(laggingInput) => {
		const rows = [
			{
				type: "turn_context",
				payload: { turn_id: "current", model: "gpt-6.1-sol" },
			},
			{ type: "compacted", payload: {} },
			{
				type: "token_usage_record",
				payload: {
					turn_id: "current",
					turn_token_usage: { input_tokens: 200, output_tokens: 15 },
					thread_token_usage: { input_tokens: 300, output_tokens: 20 },
				},
			},
			{
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: {
							input_tokens: laggingInput,
							output_tokens: 10,
						},
					},
				},
			},
		];
		expect(
			parseCodexRollout(
				rows.map((r) => JSON.stringify(r)).join("\n"),
				"current",
			)?.usage,
		).toMatchObject({
			input_tokens: null,
			cache_read_input_tokens: null,
			cache_creation_input_tokens: null,
			output_tokens: 15,
		});
	},
);

test.each([
	"input_tokens",
	"cached_input_tokens",
	"cache_write_input_tokens",
	"output_tokens",
])("Codex token_count rejects a negative %s delta", (field) => {
	const prior = {
		input_tokens: 100,
		cached_input_tokens: 30,
		cache_write_input_tokens: 10,
		output_tokens: 5,
	};
	const rows = [
		{
			type: "event_msg",
			payload: { type: "token_count", info: { total_token_usage: prior } },
		},
		{
			type: "turn_context",
			payload: { turn_id: "current", model: "gpt-6.1-sol" },
		},
		{
			type: "event_msg",
			payload: {
				type: "token_count",
				info: { total_token_usage: { ...prior, [field]: 0 } },
			},
		},
	];
	expect(
		parseCodexRollout(rows.map((r) => JSON.stringify(r)).join("\n"), "current")
			?.usage,
	).toBeNull();
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
		).toMatchObject({
			input_tokens: 120,
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
			).toMatchObject({
				input_tokens: 120,
				cache_read_input_tokens: 50,
				cache_creation_input_tokens: 30,
				output_tokens: 15,
			});
		}
	},
);

const codexTurn = (usage: Record<string, number | null>) =>
	[
		{
			type: "turn_context",
			payload: { turn_id: "current", model: "gpt-6.1-sol" },
		},
		{
			type: "token_usage_record",
			payload: { turn_id: "current", turn_token_usage: usage },
		},
	]
		.map((r) => JSON.stringify(r))
		.join("\n");

test.each(["token_usage_record", "event_msg"])(
	"Claude and Codex use disjoint input buckets and include reasoning only once (%s)",
	(format) => {
		const claude = parseSubagentTranscript(
			JSON.stringify({
				type: "assistant",
				message: {
					id: "m",
					model: "claude-sonnet-5-5",
					usage: {
						input_tokens: 60,
						cache_read_input_tokens: 40,
						cache_creation_input_tokens: 20,
						output_tokens: 10,
					},
				},
			}),
		)[0];
		const usage = {
			input_tokens: 120,
			cached_input_tokens: 40,
			cache_write_input_tokens: 20,
			output_tokens: 10,
			reasoning_output_tokens: 5,
		};
		const jsonl =
			format === "token_usage_record"
				? codexTurn(usage)
				: [
						{
							type: "turn_context",
							payload: { turn_id: "current", model: "gpt-6.1-sol" },
						},
						{
							type: "event_msg",
							payload: {
								type: "token_count",
								info: { total_token_usage: usage },
							},
						},
					]
						.map((r) => JSON.stringify(r))
						.join("\n");
		const codex = parseCodexRollout(jsonl, "current")?.usage;
		expect(codex).toMatchObject({
			input_tokens: claude?.input_tokens,
			cache_read_input_tokens: claude?.cache_read_tokens,
			cache_creation_input_tokens: claude?.cache_creation_tokens,
			output_tokens: claude?.output_tokens,
		});
	},
);

test("Claude aggregates propagate missing counters without turning known zero into null", () => {
	const jsonl = [
		{
			type: "assistant",
			message: {
				id: "m1",
				model: "claude-sonnet-5-5",
				usage: {
					input_tokens: 2,
					output_tokens: 3,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 5,
				},
			},
		},
		{
			type: "assistant",
			message: {
				id: "m2",
				model: "claude-sonnet-5-5",
				usage: {
					input_tokens: 4,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: null,
				},
			},
		},
	]
		.map((r) => JSON.stringify(r))
		.join("\n");
	expect(parseSubagentTranscript(jsonl)).toEqual([
		{
			model: "claude-sonnet-5-5",
			input_tokens: 6,
			output_tokens: null,
			cache_read_tokens: 0,
			cache_creation_tokens: null,
		},
	]);
});

test("Codex response-only aggregates preserve missing counters", () => {
	const jsonl = [
		{
			type: "turn_context",
			payload: { turn_id: "current", model: "gpt-6.1-sol" },
		},
		{
			type: "token_usage_record",
			payload: {
				usage: {
					input_tokens: 120,
					cached_input_tokens: 40,
					cache_write_input_tokens: 20,
					output_tokens: 10,
				},
			},
		},
		{
			type: "token_usage_record",
			payload: {
				usage: {
					input_tokens: 50,
					cached_input_tokens: 10,
					cache_write_input_tokens: 0,
				},
			},
		},
	]
		.map((r) => JSON.stringify(r))
		.join("\n");
	expect(parseCodexRollout(jsonl, "current")?.usage).toMatchObject({
		input_tokens: 100,
		cache_read_input_tokens: 50,
		cache_creation_input_tokens: 20,
		output_tokens: null,
	});
});

test("Codex cumulative deltas preserve counters absent from either snapshot", () => {
	const jsonl = [
		{
			type: "event_msg",
			payload: {
				type: "token_count",
				info: {
					total_token_usage: {
						input_tokens: 100,
						cached_input_tokens: 30,
						output_tokens: 10,
					},
				},
			},
		},
		{
			type: "turn_context",
			payload: { turn_id: "current", model: "gpt-6.1-sol" },
		},
		{
			type: "event_msg",
			payload: {
				type: "token_count",
				info: {
					total_token_usage: {
						input_tokens: 150,
						cached_input_tokens: 40,
						cache_write_input_tokens: 0,
					},
				},
			},
		},
	]
		.map((r) => JSON.stringify(r))
		.join("\n");
	expect(parseCodexRollout(jsonl, "current")?.usage).toMatchObject({
		input_tokens: null,
		cache_read_input_tokens: 10,
		cache_creation_input_tokens: null,
		output_tokens: null,
	});
});

test.each(["cached_input_tokens", "cache_write_input_tokens"])(
	"Codex keeps known counters when %s is absent",
	(field) => {
		const usage: Record<string, number | null> = {
			input_tokens: 120,
			cached_input_tokens: 40,
			cache_write_input_tokens: 20,
			output_tokens: 10,
		};
		delete usage[field];
		expect(parseCodexRollout(codexTurn(usage), "current")?.usage).toMatchObject(
			{
				input_tokens: null,
				cache_read_input_tokens: field === "cached_input_tokens" ? null : 40,
				cache_creation_input_tokens:
					field === "cache_write_input_tokens" ? null : 20,
				output_tokens: 10,
			},
		);
	},
);

test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
	"invalid counters stay unknown (%s)",
	(invalid) => {
		const claude = parseSubagentTranscript(
			JSON.stringify({
				type: "assistant",
				message: {
					id: "m",
					model: "claude-sonnet-5-5",
					usage: {
						input_tokens: invalid,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			}),
		);
		expect(claude[0]).toMatchObject({
			model: "claude-sonnet-5-5",
			input_tokens: null,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		});
		expect(
			parseCodexRollout(
				codexTurn({
					input_tokens: invalid,
					cached_input_tokens: 0,
					cache_write_input_tokens: 0,
					output_tokens: 0,
				}),
				"current",
			)?.usage,
		).toMatchObject({
			input_tokens: null,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
			output_tokens: 0,
		});
	},
);

test("Codex rejects overlapping cache counts that exceed total input", () => {
	expect(
		parseCodexRollout(
			codexTurn({
				input_tokens: 10,
				cached_input_tokens: 8,
				cache_write_input_tokens: 8,
				output_tokens: 0,
			}),
			"current",
		)?.usage,
	).toMatchObject({
		input_tokens: null,
		cache_read_input_tokens: 8,
		cache_creation_input_tokens: 8,
		output_tokens: 0,
	});
});

test.each([undefined, null])(
	"Claude messages with absent usage keep unknown counters (%s)",
	(usage) => {
		const jsonl = JSON.stringify({
			type: "assistant",
			message: { id: "m", model: "claude-sonnet-5-5", usage },
		});
		expect(parseSubagentTranscript(jsonl)).toEqual([
			{
				model: "claude-sonnet-5-5",
				input_tokens: null,
				output_tokens: null,
				cache_read_tokens: null,
				cache_creation_tokens: null,
			},
		]);
	},
);
