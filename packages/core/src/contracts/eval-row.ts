// Row contract spatz-eval-row/1 (GitHub issue #68): what the testbench writes and spatz imports.
// A breaking change bumps the version; additive fields are ignored by readers.
// contracts/eval-row.v1.schema.json publishes the same rules for non-TS validators;
// the parser takes its patterns from there and eval-row.test.ts keeps the enums in step.
import jsonSchema from "../../../../contracts/eval-row.v1.schema.json";
import {
	CRITICALITIES,
	type Criticality,
	DIFFICULTIES,
	type Difficulty,
	EFFORTS,
	type Effort,
	TASK_TYPES,
	type TaskType,
} from "./types.ts";

export const EVAL_ROW_SCHEMA = "spatz-eval-row/1";

/** Taxonomy v2 values a bench row may carry: every TASK_TYPES value except `other`. */
export const EVAL_ROW_TASK_TYPES = TASK_TYPES.filter(
	(t) => t !== "other",
) as readonly Exclude<TaskType, "other">[];

export const EVAL_ROW_RESULTS = ["pass", "partial", "fail"] as const;
/** Verifier kind; `rubric` rows weigh 0.5 in the prior until their judge is validated. */
export const EVAL_ROW_CHECKS = ["tests", "golden", "rubric", "human"] as const;

export const EVAL_ROW_FIELDS = [
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
	"started_at",
	"contributor",
	"verified",
] as const;

/** Null counters mean "not reported", never 0. */
export type EvalRowTokens =
	| {
			input: number;
			output: number;
			cache_read: number | null;
			cache_write: number | null;
			reasoning: number | null;
	  }
	/** The harness reported no usage; cost_usd is null too. */
	| {
			input: null;
			output: null;
			cache_read: null;
			cache_write: null;
			reasoning: null;
	  };

export interface EvalRow {
	schema: typeof EVAL_ROW_SCHEMA;
	run_id: string;
	bench_version: string;
	task_id: string;
	task_version: number;
	task_type: Exclude<TaskType, "other">;
	difficulty: Difficulty;
	criticality: Criticality;
	harness: string;
	agent_version: string;
	/** Canonical OpenRouter id, after toCanonicalId. */
	model: string;
	effort: Effort;
	answered_model: string | null;
	model_version: string | null;
	attempt: number;
	result: (typeof EVAL_ROW_RESULTS)[number];
	check: (typeof EVAL_ROW_CHECKS)[number];
	judge: string | null;
	duration_s: number;
	tokens: EvalRowTokens;
	cost_usd: number | null;
	started_at: string;
	contributor: string;
	verified: boolean;
}

const pattern = (field: "run_id" | "model" | "started_at") =>
	new RegExp(jsonSchema.properties[field].pattern);
const UUID = pattern("run_id");
const CANONICAL = pattern("model");
const UTC = pattern("started_at");
const COUNTERS = [
	"input",
	"output",
	"cache_read",
	"cache_write",
	"reasoning",
] as const;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj =>
	typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string" && x !== "";
const isNum = (x: unknown) =>
	typeof x === "number" && Number.isFinite(x) && x >= 0;
const isCount = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
const isInt1 = (x: unknown) => Number.isInteger(x) && (x as number) >= 1;
const orNull = (ok: (x: unknown) => boolean) => (x: unknown) =>
	x === null || ok(x);
const oneOf = (values: readonly string[], x: unknown) =>
	values.includes(x as string);
const matches = (re: RegExp, x: unknown) => typeof x === "string" && re.test(x);

function validUsage(t: unknown, cost: unknown): boolean {
	if (!isObj(t) || !COUNTERS.every((k) => k in t)) return false;
	// No usage reported: every counter and the cost are null together.
	if (t.input === null)
		return COUNTERS.every((k) => t[k] === null) && cost === null;
	return (
		isCount(t.input) &&
		isCount(t.output) &&
		orNull(isCount)(t.cache_read) &&
		orNull(isCount)(t.cache_write) &&
		orNull(isCount)(t.reasoning) &&
		orNull(isNum)(cost)
	);
}

/** The contract row in `value` without unknown fields, in contract order; null when it breaks the contract. */
export function parseEvalRow(value: unknown): EvalRow | null {
	if (!isObj(value)) return null;
	const v: Obj = { ...value, criticality: value.criticality ?? "none" };
	if (
		v.schema !== EVAL_ROW_SCHEMA ||
		!matches(UUID, v.run_id) ||
		!isStr(v.bench_version) ||
		!isStr(v.task_id) ||
		!isInt1(v.task_version) ||
		!oneOf(EVAL_ROW_TASK_TYPES, v.task_type) ||
		!oneOf(DIFFICULTIES, v.difficulty) ||
		!oneOf(CRITICALITIES, v.criticality) ||
		!isStr(v.harness) ||
		!isStr(v.agent_version) ||
		!matches(CANONICAL, v.model) ||
		!oneOf(EFFORTS, v.effort) ||
		!orNull(isStr)(v.answered_model) ||
		!orNull(isStr)(v.model_version) ||
		!isInt1(v.attempt) ||
		!oneOf(EVAL_ROW_RESULTS, v.result) ||
		!oneOf(EVAL_ROW_CHECKS, v.check) ||
		!orNull(isStr)(v.judge) ||
		// Tests and golden answers have no judge.
		((v.check === "tests" || v.check === "golden") && v.judge !== null) ||
		!isNum(v.duration_s) ||
		!validUsage(v.tokens, v.cost_usd) ||
		!matches(UTC, v.started_at) ||
		!isStr(v.contributor) ||
		typeof v.verified !== "boolean"
	)
		return null;
	const t = v.tokens as Obj;
	return {
		...Object.fromEntries(EVAL_ROW_FIELDS.map((k) => [k, v[k]])),
		tokens: Object.fromEntries(COUNTERS.map((k) => [k, t[k]])),
	} as unknown as EvalRow;
}
