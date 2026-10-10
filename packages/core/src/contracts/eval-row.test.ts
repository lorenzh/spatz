import { expect, test } from "bun:test";
import evalRowJsonSchema from "../../../../contracts/eval-row.v1.schema.json";
import {
	CRITICALITIES,
	DIFFICULTIES,
	EFFORTS,
	EVAL_ROW_CHECKS,
	EVAL_ROW_FIELDS,
	EVAL_ROW_RESULTS,
	EVAL_ROW_SCHEMA,
	EVAL_ROW_TASK_TYPES,
	evalRowError,
	parseEvalRow,
	TASK_TYPES,
} from "../index.ts";

test("spatz-eval-row/1 pins the 16 labelled v2 task types, never other", () => {
	expect(EVAL_ROW_SCHEMA).toBe("spatz-eval-row/1");
	expect([...EVAL_ROW_TASK_TYPES]).toEqual([
		"code.bugfix",
		"code.feature",
		"code.refactor",
		"code.test",
		"code.explain",
		"investigation",
		"review",
		"spec",
		"planning",
		"ops",
		"design.ui",
		"design.visual",
		"design.3d",
		"writing",
		"research",
		"data",
	]);
	expect(
		TASK_TYPES.filter((t) => !EVAL_ROW_TASK_TYPES.includes(t as never)),
	).toEqual(["other"]);
});

test("spatz-eval-row/1 pins its field names", () => {
	expect([...EVAL_ROW_FIELDS]).toEqual([
		"schema",
		"run_id",
		"bench_version",
		"task_id",
		"task_version",
		"task_type",
		"difficulty",
		"criticality",
		"harness",
		"agent_version",
		"model",
		"effort",
		"answered_model",
		"model_version",
		"attempt",
		"result",
		"check",
		"judge",
		"duration_s",
		"tokens",
		"cost_usd",
		"estimated_cost_usd",
		"started_at",
		"contributor",
		"verified",
	]);
});

/** A code row as the #68 table describes it. */
const row = {
	schema: "spatz-eval-row/1",
	run_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
	bench_version: "1",
	task_id: "sample/e1",
	task_version: 1,
	task_type: "code.bugfix",
	difficulty: "easy",
	criticality: "none",
	harness: "claude-code",
	agent_version: "2.1.289",
	model: "anthropic/claude-opus-5.5",
	effort: "high",
	answered_model: "claude-opus-5-5",
	model_version: null,
	attempt: 1,
	result: "pass",
	check: "tests",
	judge: null,
	duration_s: 41.2,
	tokens: {
		input: 6,
		output: 1095,
		cache_read: 43895,
		cache_write: 4490,
		reasoning: 169,
	},
	cost_usd: 0.31,
	estimated_cost_usd: 0.066623,
	started_at: "2026-10-06T09:00:00.000Z",
	contributor: "anon-01234567",
	verified: true,
};
const rubric = {
	...row,
	task_type: "design.ui",
	check: "rubric",
	judge: "anthropic/claude-opus-5.5:2026-10",
	result: "partial",
};
const codexNullCost = {
	...row,
	harness: "codex",
	model: "openai/gpt-6.1-sol",
	answered_model: "gpt-6.1-sol",
	tokens: { ...row.tokens, cache_write: null, reasoning: null },
	cost_usd: null,
	estimated_cost_usd: 0.0153515,
};
const noUsage = {
	...row,
	tokens: {
		input: null,
		output: null,
		cache_read: null,
		cache_write: null,
		reasoning: null,
	},
	cost_usd: null,
	estimated_cost_usd: null,
};

test.each([
	["code", row],
	["design.ui rubric", rubric],
	["codex with null cost", codexNullCost],
	["no usage reported", noUsage],
])("a %s row round-trips through JSON Lines", (_, value) => {
	const line = JSON.stringify(parseEvalRow(value));
	expect(parseEvalRow(JSON.parse(line))).toEqual(value as never);
	expect(JSON.parse(line)).toEqual(value);
});

test("parseEvalRow drops unknown fields, keeps field order and defaults criticality", () => {
	const parsed = parseEvalRow({ extra: 1, ...row });
	expect(Object.keys(parsed ?? {})).toEqual([...EVAL_ROW_FIELDS]);
	const { criticality: _, ...noCriticality } = row;
	expect(parseEvalRow(noCriticality)?.criticality).toBe("none");
});

test("estimated_cost_usd is optional and defaults to null", () => {
	const { estimated_cost_usd: _, ...noEstimate } = row;
	expect(parseEvalRow(noEstimate)?.estimated_cost_usd).toBeNull();
	expect(
		parseEvalRow({ ...row, estimated_cost_usd: 0 })?.estimated_cost_usd,
	).toBe(0);
});

test.each([
	["not an object", []],
	["another schema", { ...row, schema: "spatz-eval-row/2" }],
	["a bad run_id", { ...row, run_id: "run-1" }],
	["task type other", { ...row, task_type: "other" }],
	["an unknown effort", { ...row, effort: "turbo" }],
	["a model id that is not canonical", { ...row, model: "claude-opus-5-5" }],
	["a judge on a tests row", { ...row, judge: "x" }],
	["an unknown check", { ...row, check: "vibes" }],
	["task_version 0", { ...row, task_version: 0 }],
	["a local timestamp", { ...row, started_at: "2026-10-06T09:00:00+02:00" }],
	["Feb 30", { ...row, started_at: "2026-02-30T09:00:00Z" }],
	["a missing counter", { ...row, tokens: { input: 1, output: 1 } }],
	["a negative counter", { ...row, tokens: { ...row.tokens, input: -1 } }],
	[
		"null input with a known output",
		{ ...row, tokens: { ...noUsage.tokens, output: 5 }, cost_usd: null },
	],
	["no usage but a cost", { ...noUsage, cost_usd: 0.1 }],
	["no usage but an estimate", { ...noUsage, estimated_cost_usd: 0.1 }],
	["a negative estimate", { ...row, estimated_cost_usd: -0.01 }],
	[
		"a non-finite estimate",
		{ ...row, estimated_cost_usd: Number.POSITIVE_INFINITY },
	],
	["a string estimate", { ...row, estimated_cost_usd: "0.05" }],
	["a missing field", { ...row, verified: undefined }],
])("parseEvalRow rejects %s", (_, value) => {
	expect(parseEvalRow(value)).toBeNull();
	expect(evalRowError(value)).not.toBeNull();
});

test.each([
	["not an object", [], "not an object"],
	["another schema", { ...row, schema: "spatz-eval-row/2" }, "schema"],
	["an unknown effort", { ...row, effort: "turbo" }, "effort"],
	["a judge on a tests row", { ...row, judge: "x" }, "judge"],
	["no usage but a cost", { ...noUsage, cost_usd: 0.1 }, "tokens"],
])("evalRowError names the broken field for %s", (_, value, field) => {
	expect(evalRowError(value)).toBe(
		field === "not an object" ? field : `invalid ${field}`,
	);
});

test("evalRowError is null for a valid row", () => {
	expect(evalRowError(row)).toBeNull();
});

test("the published JSON Schema lists the same fields and values as the parser", () => {
	const p = evalRowJsonSchema.properties;
	expect(Object.keys(p)).toEqual([...EVAL_ROW_FIELDS]);
	expect(evalRowJsonSchema.required).toEqual(
		EVAL_ROW_FIELDS.filter(
			(f) => f !== "criticality" && f !== "estimated_cost_usd",
		),
	);
	expect(p.schema.const).toBe(EVAL_ROW_SCHEMA);
	expect(p.task_type.enum).toEqual([...EVAL_ROW_TASK_TYPES]);
	expect(p.difficulty.enum).toEqual([...DIFFICULTIES]);
	expect(p.criticality.enum).toEqual([...CRITICALITIES]);
	expect(p.effort.enum).toEqual([...EFFORTS]);
	expect(p.result.enum).toEqual([...EVAL_ROW_RESULTS]);
	expect(p.check.enum).toEqual([...EVAL_ROW_CHECKS]);
	expect(Object.keys(p.tokens.properties)).toEqual(Object.keys(row.tokens));
});
