import { expect, test } from "bun:test";
import { parseEvalRow } from "../packages/core/src/index.ts";
import { toEvalRow } from "./prototype-to-eval-row.ts";

// Shape of a prototype result line (claude harness); the task id is neutral.
const claudeLine = {
	task: "example-task",
	difficulty: "medium",
	type: "code.bugfix",
	model: "claude-sonnet-5-5",
	model_answered: "claude-sonnet-5-5",
	effort: "low",
	result: "PASS",
	wall_s: 8.4,
	tokens: {
		input: 6,
		output: 733,
		cache_read: 43336,
		cache_create: 5217,
		thinking: 0,
	},
	cost_usd: 0.0368772,
	started: "2026-10-06T02:48:10+02:00",
};
// Shape of a prototype result line (codex harness).
const codexLine = {
	task: "example-task",
	difficulty: "hard",
	type: "code.feature",
	model: "gpt-5.5",
	effort: "high",
	result: "FAIL",
	wall_seconds: 30,
	usage: {
		input_tokens: 100,
		cached_input_tokens: 40,
		output_tokens: 9,
		reasoning_output_tokens: 3,
	},
	started_at: "2026-10-06T00:00:00Z",
};

test("a prototype claude line converts to a valid spatz-eval-row/1", () => {
	const row = parseEvalRow(toEvalRow(claudeLine, "claude-code"));
	expect(row).not.toBeNull();
	expect(row?.model).toBe("anthropic/claude-sonnet-5.5");
	expect(row?.tokens).toEqual({
		input: 6,
		output: 733,
		cache_read: 43336,
		cache_write: 5217,
		reasoning: 0,
	});
	expect(row?.started_at).toBe("2026-10-06T00:48:10.000Z");
});

test("a prototype codex line converts, and missing usage becomes all-null", () => {
	const row = parseEvalRow(toEvalRow(codexLine, "codex"));
	expect(row?.result).toBe("fail");
	expect(row?.tokens).toEqual({
		input: 60,
		output: 9,
		cache_read: 40,
		cache_write: null,
		reasoning: 3,
	});
	const bare = parseEvalRow(
		toEvalRow({ ...codexLine, usage: undefined }, "codex"),
	);
	expect(bare?.tokens.input).toBeNull();
	expect(bare?.cost_usd).toBeNull();
});
