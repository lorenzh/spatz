import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import { REPORT_VALUES } from "../contracts/types.ts";
import { openStore } from "../store/index.ts";
import { runStats } from "./index.ts";

// Pre-installed sqlite extension. Tests never INSTALL: the onSql guard throws before any INSTALL runs.
const extensionDir =
	process.env.SPATZ_DUCKDB_EXTENSION_DIR ??
	join(homedir(), ".spatz", "duckdb-extensions");

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
	scope?: RoutingScope;
	task_type?: TaskType;
	difficulty?: Difficulty;
	control?: boolean;
	is_test?: boolean;
	/** ranking[0] as [model, effort]. */
	top?: [string, Effort];
	strategy?: StrategyName;
	explored?: boolean;
	/** Sets fallback_used; null is a row from before schema v5. */
	fallback?: FallbackReason | null;
}

function sug(id: string, o: SugOpts = {}) {
	const [model, effort] = o.top ?? ["m/a", "low"];
	store.insertSuggestion({
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
		fallback_used: o.fallback !== undefined,
		fallback_reason: o.fallback ?? null,
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
	store.insertSignal({
		suggestion_id: id,
		kind: "report",
		value: REPORT_VALUES[result],
		weight: 1,
		source: "report",
		observed_at: 1,
	});
}

/** Pair fields of a pair that never escalated: its suggestions' tokens. */
const first = (input_tokens: number, output_tokens: number) => ({
	escalations: 0,
	input_tokens,
	output_tokens,
});

const noInstall = (sql: string) => {
	if (/\bINSTALL\b/i.test(sql)) throw new Error(`INSTALL blocked: ${sql}`);
};

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
			extensionDir,
			successQuality: 0.8,
			onSql: noInstall,
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
		extensionDir,
		type,
		successQuality: 0.8,
		onSql: noInstall,
	});

function signal(id: string, value: number) {
	store.insertSignal({
		suggestion_id: id,
		kind: "test",
		value,
		weight: 1,
		source: "PostToolUse",
		observed_at: 1,
	});
}

test("empty db: no types, coverage 0, no comparison", async () => {
	expect(await stats()).toEqual({
		by_type: [],
		coverage: 0,
		learned_success: null,
		control_success: null,
		fallbacks: {},
		failures: { parse: 0, hook: 0, launcher: 0 },
	});
});

test("attempts: a stronger retry counts for its own pair; escalations and all tokens count for the first pair", async () => {
	sug("e1", { top: ["m/cheap", "low"], scope: "escalate" });
	usage("e1", "m/cheap", "low", [10, 1], "transcript");
	usage("e1", "m/strong", "high", [20, 2], "transcript");
	const hook = { suggestion_id: "e1", kind: "test" as const, weight: 1 };
	store.insertSignal({
		...hook,
		value: 0,
		source: "PostToolUseFailure",
		model: "m/cheap",
		effort: "low",
		observed_at: 1,
	});
	store.insertSignal({
		...hook,
		value: 1,
		source: "PostToolUse",
		model: "m/strong",
		effort: "high",
		observed_at: 2,
	});
	const r = await runStats({
		dbPath,
		extensionDir,
		successQuality: 0.8,
		by: "scope",
		onSql: noInstall,
	});
	expect(r.by_scope).toMatchObject([
		{ scope: "escalate", n: 1, success_rate: 1, input_tokens: 30 },
	]);
	expect(await stats()).toMatchObject({
		by_type: [
			{
				task_type: "code.bugfix",
				n: 2,
				pairs: [
					{
						model: "m/cheap",
						effort: "low",
						n: 1,
						success_rate: 0,
						escalations: 1,
						input_tokens: 30,
						output_tokens: 3,
					},
					{
						model: "m/strong",
						effort: "high",
						n: 1,
						success_rate: 1,
						escalations: 0,
						input_tokens: 0,
						output_tokens: 0,
					},
				],
				adoption_rate: 1,
				input_tokens: 30,
				output_tokens: 3,
			},
		],
		coverage: 1,
	});
});

test("attempts: cheap -> middle -> strong charges both escalations to the cheap pair", async () => {
	sug("e3", { top: ["m/cheap", "low"], scope: "escalate" });
	const pairs = [
		["m/cheap", "low", 0],
		["m/middle", "medium", 0],
		["m/strong", "high", 1],
	] as const;
	for (const [i, [model, effort, value]] of pairs.entries())
		store.insertSignal({
			suggestion_id: "e3",
			kind: "test",
			weight: 1,
			value,
			source: "PostToolUse",
			model,
			effort,
			observed_at: i + 1,
		});
	const [type] = (await stats()).by_type;
	expect(
		type?.pairs.map(({ model, n, escalations }) => ({ model, n, escalations })),
	).toEqual([
		{ model: "m/cheap", n: 1, escalations: 2 },
		{ model: "m/middle", n: 1, escalations: 0 },
		{ model: "m/strong", n: 1, escalations: 0 },
	]);
});

test("fallback reasons and silent failures are counted", async () => {
	sug("jev");
	sug("t", { fallback: "timeout" });
	sug("t2", { fallback: "timeout" });
	sug("old", { fallback: null });
	sug("dry", { fallback: "no_key", is_test: true });
	store.recordFailure("parse", "Stop", 1);
	store.recordFailure("parse", "codex:Stop", 2);
	store.recordFailure("hook", "PostToolUse", 3);
	// One per affected turn: a second event of turn t1 does not count again.
	store.recordFailure("parse", "PostToolUse", 4, "t1");
	store.recordFailure("parse", "Stop", 5, "t1");
	const r = await stats();
	expect(r.fallbacks).toEqual({ timeout: 2, unknown: 1 });
	expect(r.failures).toEqual({ parse: 3, hook: 1, launcher: 0 });
});

test("reads the SQLite file read-only and leaves it unchanged", async () => {
	sug("s1");
	report("s1", "m/a", "low", "pass");
	store.dispose();
	const before = Bun.hash(await Bun.file(dbPath).bytes());
	const sqls: string[] = [];
	const r = await runStats({
		dbPath,
		extensionDir,
		successQuality: 0.8,
		onSql: (sql) => {
			noInstall(sql);
			sqls.push(sql.trim());
		},
	});
	expect(r.coverage).toBe(1);
	expect(sqls.slice(0, 2)).toEqual([
		"LOAD sqlite",
		`ATTACH '${dbPath}' AS db (TYPE sqlite, READ_ONLY)`,
	]);
	expect(sqls.some((q) => /INSTALL/i.test(q))).toBe(false);
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
		extensionDir,
		successQuality: 0.8,
		noneOnlyModels: [model],
		onSql: noInstall,
	});
	expect(result.by_type[0]?.pairs).toEqual([
		{
			model,
			effort: "none",
			n: 1,
			success_rate: 1,
			escalations: 0,
			input_tokens: 0,
			output_tokens: 1,
		},
	]);
});

test("missing extension: INSTALL is attempted only after LOAD fails (guard stops it)", async () => {
	const empty = join(dir, "no-ext");
	const sqls: string[] = [];
	const run = runStats({
		dbPath,
		extensionDir: empty,
		successQuality: 0.8,
		onSql: (sql) => {
			sqls.push(sql.trim());
			noInstall(sql);
		},
	});
	await expect(run).rejects.toThrow("INSTALL blocked");
	expect(sqls).toEqual(["LOAD sqlite", "INSTALL sqlite"]);
});

test("DuckDB is imported only by the report module", async () => {
	const root = join(import.meta.dir, "..", "..", "..");
	const hits: string[] = [];
	for await (const f of new Bun.Glob("*/src/**/*.ts").scan(root)) {
		if (f.endsWith(".test.ts")) continue;
		if ((await Bun.file(join(root, f)).text()).includes("@duckdb/"))
			hits.push(f);
	}
	expect(hits).toEqual(["core/src/report/index.ts"]);
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
			{ model: "m/a", effort: "low", n: 1, success_rate: 1, ...first(100, 10) },
			{
				model: "m/b",
				effort: "high",
				n: 2,
				success_rate: 0.5,
				...first(500, 50),
			},
		],
		adoption_rate: 2 / 3,
		input_tokens: 605,
		output_tokens: 61,
	};
	const review: TypeStats = {
		task_type: "review",
		n: 1,
		pairs: [
			{ model: "m/a", effort: "low", n: 1, success_rate: 0, ...first(7, 3) },
		],
		adoption_rate: 1,
		input_tokens: 7,
		output_tokens: 3,
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
		control_success: null,
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
		{ model: "m/a", effort: "high", n: 3, success_rate: 1 / 3, ...first(3, 3) },
		{ model: "m/a", effort: "low", n: 1, success_rate: 1, ...first(1, 1) },
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
		{ model: "m/a", effort: "low", n: 1, success_rate: 0, ...first(1, 1) },
		{ model: "m/b", effort: "high", n: 1, success_rate: 1, ...first(1, 1) },
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
		control_success: null,
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
			adoption_rate: 0,
			input_tokens: 0,
			output_tokens: 0,
		},
	]);
});

test("scope stats count outcomes once and include cache tokens, unscoped and usage-only suggestions", async () => {
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
		extensionDir,
		successQuality: 0.8,
		by: "scope",
		onSql: noInstall,
	});
	expect(r.by_scope).toEqual([
		{
			scope: "step",
			n: 0,
			success_rate: null,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			cache_read_share: 0,
		},
		{
			scope: "turn",
			n: 2,
			success_rate: 0.5,
			input_tokens: 40,
			output_tokens: 60,
			cache_read_tokens: 60,
			cache_creation_tokens: 20,
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
			cache_read_share: 0,
		},
	]);
	const filtered = await runStats({
		dbPath,
		extensionDir,
		successQuality: 0.8,
		by: "scope",
		type: "review",
		onSql: noInstall,
	});
	expect(filtered.by_scope).toEqual(r.by_scope?.slice(0, 1));
});
