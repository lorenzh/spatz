import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "../contracts/deps.ts";
import type {
	Difficulty,
	Effort,
	FallbackReason,
	ReportResult,
	RoutingScope,
	StrategyName,
	TaskType,
	TypeStats,
} from "../contracts/types.ts";
import { openStore } from "../store/index.ts";
import { runStats } from "./index.ts";

let dir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "spatz-report-"));
	dbPath = join(dir, "spatz.db");
	store = openStore(dbPath);
});
afterEach(() => {
	store.dispose();
	rmSync(dir, { recursive: true, force: true });
});

interface SugOpts {
	retry_of?: string;
	fallback_used?: boolean;
	fallback_reason?: FallbackReason | null;
	scope?: RoutingScope;
	task_type?: TaskType;
	difficulty?: Difficulty;
	control?: boolean;
	is_test?: boolean;
	/** ranking[0] as [model, effort]. */
	top?: [string, Effort];
	strategy?: StrategyName;
	explored?: boolean;
}

function sug(id: string, o: SugOpts = {}) {
	const [model, effort] = o.top ?? ["m/a", "low"];
	store.insertSuggestion({
		...(o.retry_of && { retry_of: o.retry_of }),
		id,
		created_at: 1,
		scope: o.scope ?? null,
		agent: null,
		turn_id: null,
		agent_id: null,
		session_id: null,
		prompt_id: null,
		task_type: o.task_type ?? "code.bugfix",
		difficulty: o.difficulty ?? "easy",
		criticality: "none",
		probabilities: null,
		model_ref: null,
		strategy: o.strategy ?? (o.control ? "strongest" : "learned"),
		ranking: [{ model, effort, estimate: 0.5, n: 0 }],
		reason: "r",
		explored: o.explored ?? false,
		control: o.control ?? false,
		fallback_used: o.fallback_used ?? false,
		fallback_reason: o.fallback_reason ?? null,
		is_test: o.is_test ?? false,
		last_event_at: 1,
		closed_at: null,
	});
}

function usage(
	id: string,
	model: string,
	effort: Effort | null,
	tokens: [number, number],
	source: "report" | "transcript" = "report",
) {
	store.upsertUsage({
		suggestion_id: id,
		model,
		effort,
		source,
		scope_key: source === "report" ? "" : "p1",
		input_tokens: tokens[0],
		output_tokens: tokens[1],
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		is_sidechain: false,
		rounds: null,
		note: null,
		reported_at: 1,
	});
}

function report(
	id: string,
	model: string,
	effort: Effort,
	result: ReportResult,
	tokens: [number, number] = [0, 0],
) {
	usage(id, model, effort, tokens);
	store.reportAttempt({ suggestion_id: id, model, effort, result, at: 1 });
}

test("stats and stats by scope combine legacy and English difficulty cells", async () => {
	sug("legacy", { difficulty: "medium", scope: "turn" });
	sug("english", { difficulty: "medium", scope: "turn", control: true });
	report("legacy", "m/a", "low", "pass");
	report("english", "m/a", "low", "fail");
	const db = new Database(dbPath);
	db.run("UPDATE suggestions SET difficulty = 'mittel' WHERE id = 'legacy'");
	db.close();
	for (const by of [undefined, "scope"] as const) {
		const result = await runStats({
			dbPath,
			successQuality: 0.8,
			...(by && { by }),
		});
		expect(result.learned_success).toBe(1);
		expect(result.control_success).toBe(0);
		if (by)
			expect(result.by_scope?.[0]).toMatchObject({
				scope: "turn",
				n: 2,
				success_rate: 0.5,
			});
	}
});
const stats = (type?: TaskType) =>
	runStats({
		dbPath,
		type,
		successQuality: 0.8,
	});

test("attempt statistics count coverage once, compare the first pair, and sum usage before outcomes", async () => {
	sug("retry", { scope: "turn", top: ["m/a", "low"] });
	store.reportAttempt({
		suggestion_id: "retry",
		model: "m/a",
		effort: "low",
		result: "fail",
		at: 10,
	});
	const a = store.startAttempt({
		harness: "direct",
		session_key: "suggestion:retry",
		agent_key: "",
		suggestion_id: "retry",
		key: "second",
		model: "m/b",
		effort: "high",
		at: 11,
	});
	store.recordAttemptEvents([
		{
			harness: "direct",
			session_key: "suggestion:retry",
			agent_key: "",
			event_id: "usage",
			revision: 1,
			suggestion_id: "retry",
			attempt_id: a.id,
			occurred_at: 12,
			received_at: 12,
			kind: "usage",
			model: "m/b",
			effort: "high",
			input_tokens: 100,
			output_tokens: 200,
			cache_read_tokens: 300,
			cache_creation_tokens: 400,
		},
	]);
	store.reportAttempt({
		suggestion_id: "retry",
		model: "m/b",
		effort: "high",
		result: "pass",
		at: 20,
	});
	sug("unscored");
	sug("control", { control: true });
	store.reportAttempt({
		suggestion_id: "control",
		model: "m/a",
		effort: "low",
		result: "pass",
		at: 30,
	});
	const result = await runStats({
		dbPath,
		successQuality: 0.8,
		by: "scope",
	});
	expect(result.coverage).toBe(2 / 3);
	expect(result.by_type[0]).toMatchObject({
		n: 3,
		adoption_rate: 1,
		input_tokens: 100,
		output_tokens: 200,
	});
	expect(result.learned_success).toBe(0);
	expect(result.control_success).toBe(1);
	expect(result.by_scope?.find((s) => s.scope === "turn")).toMatchObject({
		n: 1,
		success_rate: 1,
		input_tokens: 100,
		output_tokens: 200,
		cache_read_tokens: 300,
		cache_creation_tokens: 400,
	});
});

test("linked retries use the root scope and first verdict for comparison", async () => {
	sug("root", { scope: "turn" });
	store.reportAttempt({
		suggestion_id: "root",
		model: "m/a",
		effort: "low",
		result: "fail",
		at: 10,
	});
	sug("child", { scope: "subagent", retry_of: "root" });
	store.reportAttempt({
		suggestion_id: "child",
		model: "m/b",
		effort: "high",
		result: "pass",
		at: 20,
	});
	const result = await runStats({
		dbPath,
		successQuality: 0.8,
		by: "scope",
	});
	expect(result.coverage).toBe(1);
	expect(result.by_scope?.find((s) => s.scope === "turn")).toMatchObject({
		n: 1,
		success_rate: 1,
	});
	expect(
		result.by_scope
			?.filter((s) => s.scope === "subagent")
			.reduce((n, s) => n + s.n, 0),
	).toBe(0);
});

function signal(id: string, value: number) {
	const suggestion = store.getSuggestion(id);
	const attempt = store.outcome(id)?.attempt_id;
	if (!suggestion || !attempt) throw new Error("missing signal attempt");
	store.recordAttemptEvents([
		{
			harness: suggestion.agent === "codex" ? "codex" : "claude-code",
			session_key: suggestion.session_id ?? `suggestion:${id}`,
			agent_key: suggestion.agent_id ?? "",
			event_id: `test:${id}`,
			revision: 0,
			attempt_id: attempt,
			kind: "test",
			value,
			weight: 1,
			source: "PostToolUse",
			occurred_at: 1,
			received_at: 1,
		},
	]);
}

test("empty db: no types, coverage 0, no comparison", async () => {
	expect(await stats()).toEqual({
		by_type: [],
		coverage: 0,
		learned_success: null,
		fallback_success: null,
		control_success: null,
		coverage_by_source: [],
		dispatches: 0,
		routed_by_mod: 0,
		swapped: 0,
		fallbacks: {},
		failures: { parse: 0, hook: 0, launcher: 0 },
	});
});

test("reads the SQLite file read-only and leaves it unchanged", async () => {
	sug("s1");
	report("s1", "m/a", "low", "pass");
	store.dispose();
	const before = Bun.hash(await Bun.file(dbPath).bytes());
	const r = await runStats({ dbPath, successQuality: 0.8 });
	expect(r.coverage).toBe(1);
	expect(Bun.hash(await Bun.file(dbPath).bytes())).toBe(before);
	store = openStore(dbPath); // afterEach disposes again
});

test("stats normalizes legacy null efforts for none-only catalog models", async () => {
	const model = "anthropic/claude-haiku-4.5";
	sug("haiku", { top: [model, "none"] });
	usage("haiku", model, null, [0, 1], "transcript");
	signal("haiku", 1);
	const result = await runStats({
		dbPath,
		successQuality: 0.8,
		noneOnlyModels: [model],
	});
	expect(result.by_type[0]?.pairs).toEqual([
		{ model, effort: "none", n: 1, success_rate: 1 },
	]);
});

test("stats filters by model_version and keeps old versions visible under their own", async () => {
	for (const [id, version, result] of [
		["v1", "20250101", "pass"],
		["v2", "20260101", "fail"],
	] as const) {
		sug(id);
		store.reportAttempt({
			suggestion_id: id,
			model: "m/a",
			effort: "low",
			result,
			at: 2,
			model_version: version,
		});
	}
	const by = async (modelVersion: string) =>
		(
			await runStats({
				dbPath,
				successQuality: 0.8,
				modelVersion,
			})
		).by_type[0]?.pairs;
	expect(await by("20250101")).toEqual([
		{ model: "m/a", effort: "low", n: 1, success_rate: 1 },
	]);
	expect(await by("20260101")).toEqual([
		{ model: "m/a", effort: "low", n: 1, success_rate: 0 },
	]);
	expect(await by("x'y")).toEqual([]);
});

test("no source file or package depends on DuckDB", async () => {
	const root = join(import.meta.dir, "..", "..", "..", "..");
	const hits: string[] = [];
	for (const glob of [
		"packages/*/src/**/*.ts",
		"scripts/*.ts",
		"packages/*/package.json",
		"package.json",
	])
		for await (const f of new Bun.Glob(glob).scan(root)) {
			if (f.endsWith(".test.ts")) continue;
			if (/duckdb/i.test(await Bun.file(join(root, f)).text())) hits.push(f);
		}
	expect(hits).toEqual([]);
});

describe("one dataset", () => {
	beforeEach(() => {
		// code.bugfix / easy
		sug("s1", { top: ["m/a", "low"] });
		report("s1", "m/a", "low", "pass", [100, 10]);
		sug("s2", { top: ["m/a", "low"] });
		report("s2", "m/b", "high", "partial", [200, 20]);
		sug("s3", { control: true, top: ["m/b", "high"] });
		report("s3", "m/b", "high", "pass", [300, 30]);
		sug("s4"); // no outcome, but usage
		usage("s4", "m/a", null, [5, 1], "transcript");
		sug("s5", { is_test: true }); // dry-run: excluded everywhere
		report("s5", "m/a", "low", "fail", [1000, 1000]);
		// review / medium: learned only
		sug("r1", { task_type: "review", difficulty: "medium" });
		report("r1", "m/a", "low", "fail", [7, 3]);
	});

	const bugfix: TypeStats = {
		task_type: "code.bugfix",
		n: 3,
		pairs: [
			{ model: "m/a", effort: "low", n: 1, success_rate: 1 },
			{ model: "m/b", effort: "high", n: 2, success_rate: 0.5 },
		],
		cost_usd: null,
		incomplete: 0,
		adoption_rate: 2 / 3,
		input_tokens: 605,
		output_tokens: 61,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
	};
	const review: TypeStats = {
		task_type: "review",
		n: 1,
		pairs: [{ model: "m/a", effort: "low", n: 1, success_rate: 0 }],
		cost_usd: null,
		incomplete: 0,
		adoption_rate: 1,
		input_tokens: 7,
		output_tokens: 3,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
	};

	test("by_type: n, pair success (partial is no success), adoption, tokens", async () => {
		expect((await stats()).by_type).toEqual([bugfix, review]);
	});

	test("coverage counts non-test suggestions with an outcome", async () => {
		expect((await stats()).coverage).toBe(4 / 5);
	});

	test("learned vs control only over cells with both groups", async () => {
		const r = await stats();
		expect(r.learned_success).toBe(0.5);
		expect(r.control_success).toBe(1);
	});

	test("type option limits by_type", async () => {
		const r = await stats("review");
		expect(r.by_type).toEqual([review]);
		expect(r.coverage).toBe(4 / 5);
	});
});

test("only dry-run suggestions: counts nothing", async () => {
	sug("t1", { is_test: true });
	report("t1", "m/a", "low", "pass", [1, 1]);
	expect(await stats()).toEqual({
		by_type: [],
		coverage: 0,
		learned_success: null,
		fallback_success: null,
		control_success: null,
		coverage_by_source: [],
		dispatches: 0,
		routed_by_mod: 0,
		swapped: 0,
		fallbacks: {},
		failures: { parse: 0, hook: 0, launcher: 0 },
	});
});

test("learned vs control is weighted by outcome count per cell", async () => {
	const t = "code.feature";
	// cell easy (2 outcomes): learned 1/1, control 0/1
	sug("a1", { task_type: t, difficulty: "easy" });
	report("a1", "m/a", "low", "pass");
	sug("a2", { task_type: t, difficulty: "easy", control: true });
	report("a2", "m/b", "high", "fail");
	// cell hard (3 outcomes): learned 0/2, control 1/1
	sug("b1", { task_type: t, difficulty: "hard" });
	report("b1", "m/a", "low", "fail");
	sug("b2", { task_type: t, difficulty: "hard" });
	report("b2", "m/a", "low", "partial");
	sug("b3", { task_type: t, difficulty: "hard", control: true });
	report("b3", "m/b", "high", "pass");
	// cell medium: control only, ignored
	sug("c1", { task_type: t, difficulty: "medium", control: true });
	report("c1", "m/b", "high", "fail");
	const r = await stats();
	expect(r.learned_success).toBeCloseTo((2 * 1 + 3 * 0) / 5);
	expect(r.control_success).toBeCloseTo((2 * 0 + 3 * 1) / 5);
});

test("learned success counts only learned picks: no exploration, jev-choice or rules", async () => {
	sug("l1");
	report("l1", "m/a", "low", "pass");
	for (let i = 0; i < 9; i++) {
		sug(`x${i}`, { explored: true });
		report(`x${i}`, "m/a", "low", "fail");
	}
	sug("j1", { strategy: "jev-choice" });
	report("j1", "m/a", "low", "fail");
	sug("r1", { strategy: "rules" });
	report("r1", "m/b", "high", "fail");
	sug("k1", { control: true });
	report("k1", "m/b", "high", "pass");
	const r = await stats();
	expect(r.learned_success).toBe(1);
	expect(r.control_success).toBe(1);
});

test("learned-fallback picks get their own row, compared against control in the same cell", async () => {
	sug("l1");
	report("l1", "m/a", "low", "pass");
	sug("f1", { strategy: "learned-fallback" });
	report("f1", "m/a", "low", "fail");
	sug("f2", { strategy: "learned-fallback" });
	report("f2", "m/a", "low", "pass");
	sug("k1", { control: true });
	report("k1", "m/b", "high", "pass");
	// fallback only in another cell without control: ignored
	sug("f3", { strategy: "learned-fallback", difficulty: "hard" });
	report("f3", "m/a", "low", "pass");
	const r = await stats();
	expect(r.learned_success).toBe(1);
	expect(r.fallback_success).toBe(0.5);
	expect(r.control_success).toBe(1);
});

test("success is quality >= 0.8; pairs and adoption distinguish effort", async () => {
	const t = "code.feature";
	sug("e1", { task_type: t, top: ["m/a", "low"] }); // adopted, quality 0.8
	usage("e1", "m/a", "low", [1, 1]);
	signal("e1", 0.8);
	sug("e2", { task_type: t, top: ["m/a", "low"] }); // same model, other effort: not adopted
	usage("e2", "m/a", "high", [1, 1]);
	signal("e2", 0.8);
	sug("e3", { task_type: t, top: ["m/a", "high"] }); // adopted, quality 0.79
	usage("e3", "m/a", "high", [1, 1]);
	signal("e3", 0.79);
	sug("e4", { task_type: t, top: ["m/a", "high"] });
	usage("e4", "m/a", "high", [1, 1]);
	signal("e4", 0.79);
	const [s] = (await stats()).by_type;
	expect(s?.pairs).toEqual([
		{ model: "m/a", effort: "high", n: 3, success_rate: 1 / 3 },
		{ model: "m/a", effort: "low", n: 1, success_rate: 1 },
	]);
	expect(s?.adoption_rate).toBe(3 / 4);
});

test("success boundary keeps double precision: 0.79999999 fails, 0.8 passes", async () => {
	sug("b1"); // learned, easy
	usage("b1", "m/a", "low", [1, 1]);
	signal("b1", 0.79999999);
	sug("b2", { control: true });
	usage("b2", "m/b", "high", [1, 1]);
	signal("b2", 0.8);
	const r = await stats();
	expect(r.by_type[0]?.pairs).toEqual([
		{ model: "m/a", effort: "low", n: 1, success_rate: 0 },
		{ model: "m/b", effort: "high", n: 1, success_rate: 1 },
	]);
	expect(r.learned_success).toBe(0);
	expect(r.control_success).toBe(1);
});

test("learned vs control cells are (task_type, difficulty), not difficulty alone", async () => {
	// easy: learned only in code.feature, control only in review -> no shared cell
	sug("x1", { task_type: "code.feature", difficulty: "easy" });
	report("x1", "m/a", "low", "pass");
	sug("x2", { task_type: "review", difficulty: "easy", control: true });
	report("x2", "m/b", "high", "fail");
	expect(await stats()).toMatchObject({
		learned_success: null,
		fallback_success: null,
		control_success: null,
		dispatches: 0,
		routed_by_mod: 0,
		swapped: 0,
		fallbacks: {},
		failures: { parse: 0, hook: 0, launcher: 0 },
	});
	// shared cell code.feature/hard: learned fails, control passes
	sug("y1", { task_type: "code.feature", difficulty: "hard" });
	report("y1", "m/a", "low", "fail");
	sug("y2", { task_type: "code.feature", difficulty: "hard", control: true });
	report("y2", "m/b", "high", "pass");
	const r = await stats();
	expect(r.learned_success).toBe(0);
	expect(r.control_success).toBe(1);
});

test("outcome without usage counts in n but not in pairs or adoption", async () => {
	sug("h1");
	signal("h1", 1);
	expect((await stats()).by_type).toEqual([
		{
			task_type: "code.bugfix",
			n: 1,
			pairs: [],
			cost_usd: null,
			incomplete: 0,
			adoption_rate: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		},
	]);
});

test("scope stats count completed chains once, including expired usage-only chains", async () => {
	sug("t1", { scope: "turn" });
	report("t1", "m/a", "low", "pass", [10, 20]);
	usage("t1", "m/b", "high", [10, 30], "transcript");
	sug("t2", { scope: "turn" });
	report("t2", "m/a", "low", "fail");
	sug("t3", { scope: "turn" });
	store.upsertUsage({
		suggestion_id: "t3",
		model: "m/a",
		effort: null,
		source: "claude-code-mod",
		scope_key: "run",
		turn_id: "run",
		input_tokens: 20,
		output_tokens: 10,
		cache_read_tokens: 60,
		cache_creation_tokens: 20,
		is_sidechain: false,
		rounds: null,
		note: null,
		reported_at: 1,
	});
	sug("legacy");
	report("legacy", "m/a", "low", "partial", [5, 6]);
	sug("dry", { scope: "turn", is_test: true });
	report("dry", "m/a", "low", "pass", [999, 999]);
	sug("zero", { scope: "step", task_type: "review" });
	const r = await runStats({
		dbPath,
		successQuality: 0.8,
		by: "scope",
	});
	expect(r.by_scope).toEqual([
		{
			scope: "step",
			n: 1,
			success_rate: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			cost_usd: null,
			incomplete: 0,
			cache_read_share: 0,
		},
		{
			scope: "turn",
			n: 3,
			success_rate: 1 / 3,
			input_tokens: 40,
			output_tokens: 60,
			cache_read_tokens: 60,
			cache_creation_tokens: 20,
			cost_usd: null,
			incomplete: 0,
			cache_read_share: 0.5,
		},
		{
			scope: null,
			n: 1,
			success_rate: 0,
			input_tokens: 5,
			output_tokens: 6,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			cost_usd: null,
			incomplete: 0,
			cache_read_share: 0,
		},
	]);
	const filtered = await runStats({
		dbPath,
		successQuality: 0.8,
		by: "scope",
		type: "review",
	});
	expect(filtered.by_scope).toEqual(r.by_scope?.slice(0, 1));
});

test("stats groups non-test fallback reasons and global failure counts", async () => {
	sug("timeout", { fallback_used: true, fallback_reason: "timeout" });
	sug("legacy", { fallback_used: true, fallback_reason: null });
	sug("dry", { fallback_used: true, fallback_reason: "secret", is_test: true });
	sug("ok", { fallback_used: false, fallback_reason: null });
	store.recordFailure("parse", "Stop", 1, "session", "turn");
	store.recordFailure("parse", "Stop", 2, "session", "turn");
	store.recordFailure("hook", "Stop", 3, null, null);
	const r = await stats();
	expect(r.fallbacks).toEqual({ timeout: 1, unknown: 1 });
	expect(r.failures).toEqual({ parse: 1, hook: 1, launcher: 0 });
	const filtered = await stats("other");
	expect(filtered.fallbacks).toEqual(r.fallbacks);
	expect(filtered.failures).toEqual(r.failures);
});

test("USD totals exclude schema 1 even with a reported cost and remain null without eligible costs", async () => {
	sug("new", { scope: "turn" });
	sug("legacy", { scope: "turn" });
	sug("unknown", { scope: "session", task_type: "review" });
	for (const id of ["new", "legacy", "unknown"])
		usage(id, "m/a", "low", [10, 20], "transcript");
	const db = new Database(dbPath);
	db.run(
		"UPDATE attempt_events SET cost_usd = 0.25, cost_source = 'reported' WHERE suggestion_id = 'new'",
	);
	db.run(
		"UPDATE attempt_events SET tokens_schema = 1, cost_usd = 99, cost_source = 'reported' WHERE suggestion_id = 'legacy'",
	);
	db.close();
	const result = await runStats({
		dbPath,
		successQuality: 0.8,
		by: "scope",
	});
	expect(
		result.by_type.find((t) => t.task_type === "code.bugfix")?.cost_usd,
	).toBeCloseTo(0.25, 12);
	expect(
		result.by_type.find((t) => t.task_type === "review")?.cost_usd,
	).toBeNull();
	expect(
		result.by_scope?.find((t) => t.scope === "turn")?.cost_usd,
	).toBeCloseTo(0.25, 12);
	expect(
		result.by_scope?.find((t) => t.scope === "session")?.cost_usd,
	).toBeNull();
});

test("dispatch counts include unlinked spawns, exclude dry runs, and do not count unknown answers as swaps", async () => {
	sug("test", { is_test: true });
	const row = {
		session_id: "session",
		agent_id: "swapped",
		requested_model: "anthropic/claude-opus-5.5",
		answered_model: "anthropic/claude-sonnet-5.5",
		requested_agent_type: "gp-opus-5-5-high",
		tool_use_id: null,
		suggestion_id: null,
	};
	store.upsertDispatch(row);
	store.upsertDispatch({
		...row,
		agent_id: "respected",
		answered_model: row.requested_model,
	});
	store.upsertDispatch({ ...row, agent_id: "unknown", answered_model: null });
	sug("routed");
	store.upsertDispatch({
		...row,
		agent_id: "mod",
		requested_model: null,
		suggestion_id: "routed",
	});
	store.upsertDispatch({ ...row, agent_id: "dry", suggestion_id: "test" });
	const result = await runStats({
		dbPath,
		successQuality: 0.8,
		type: "other",
	});
	expect(result).toMatchObject({ dispatches: 4, routed_by_mod: 1, swapped: 1 });
});

test("only known subagent estimates count as incomplete; unknown usage retains null cost", async () => {
	for (const id of ["complete", "partial", "old", "missing"]) {
		sug(id, {
			scope: "subagent",
			task_type: id === "missing" ? "review" : "code.bugfix",
		});
		usage(id, "m/a", "low", [10, 20], "transcript");
	}
	const db = new Database(dbPath);
	try {
		db.run(
			"UPDATE attempt_events SET cost_usd=1, cost_source='reported' WHERE kind='usage'",
		);
		db.run(
			"UPDATE attempt_events SET tokens_complete=0,source='subagent',harness='claude-code' WHERE suggestion_id IN ('partial','missing')",
		);
		db.run(
			"UPDATE attempt_events SET tokens_schema=1,tokens_complete=0 WHERE suggestion_id='old'",
		);
		expect(
			db
				.query(
					"SELECT cost_usd,incomplete FROM chain_outcomes WHERE suggestion_id='old'",
				)
				.get(),
		).toEqual({ cost_usd: null, incomplete: 0 });
		expect(
			db
				.query(
					"SELECT cost_usd FROM usage_totals WHERE suggestion_id='partial'",
				)
				.get(),
		).toEqual({ cost_usd: null });
		expect(
			db
				.query(
					"SELECT cost_usd,incomplete FROM chain_outcomes WHERE suggestion_id='partial'",
				)
				.get(),
		).toEqual({ cost_usd: null, incomplete: 1 });
		const result = await runStats({
			dbPath,
			successQuality: 0.8,
			by: "scope",
		});
		expect(
			result.by_type.find((t) => t.task_type === "code.bugfix"),
		).toMatchObject({
			cost_usd: 1,
			incomplete: 1,
			input_tokens: 30,
			output_tokens: 60,
		});
		expect(result.by_type.find((t) => t.task_type === "review")).toMatchObject({
			cost_usd: null,
			incomplete: 1,
		});
		expect(result.by_scope?.[0]).toMatchObject({
			cost_usd: 1,
			incomplete: 2,
			input_tokens: 40,
			output_tokens: 80,
		});
	} finally {
		db.close();
	}
});
