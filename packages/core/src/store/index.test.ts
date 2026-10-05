import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "../contracts/deps.ts";
import type {
	Effort,
	SignalKind,
	SuggestionRecord,
	UsageRecord,
} from "../contracts/types.ts";
import { openDatabase, openStore, SCHEMA_VERSION } from "./index.ts";

const dirs: string[] = [];
const stores: Store[] = [];

function tempDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "spatz-store-"));
	dirs.push(dir);
	return join(dir, "nested", "spatz.db");
}

function open(path = ":memory:"): Store {
	const store = openStore(path);
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const s of stores.splice(0)) s.dispose();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function suggestion(over: Partial<SuggestionRecord> = {}): SuggestionRecord {
	return {
		id: "s1",
		created_at: 1000,
		scope: null,
		agent: null,
		turn_id: null,
		agent_id: null,
		session_id: null,
		prompt_id: null,
		task_type: "code.bugfix",
		difficulty: "medium",
		criticality: "none",
		probabilities: null,
		model_ref: null,
		strategy: "rules",
		ranking: [
			{
				model: "anthropic/claude-opus-5.5",
				effort: "high",
				estimate: 0.5,
				n: 0,
			},
		],
		reason: "r",
		explored: false,
		control: false,
		fallback_used: true,
		is_test: false,
		last_event_at: 1000,
		closed_at: null,
		...over,
	};
}

describe("schema", () => {
	test("a failing v4 statement rolls back the whole migration", async () => {
		const dir = mkdtempSync(join(tmpdir(), "spatz-v3-"));
		dirs.push(dir);
		const path = join(dir, "v3.db");
		const db = new Database(path);
		db.run(await Bun.file(join(import.meta.dir, "fixtures/v3.sql")).text());
		db.run(
			`INSERT INTO suggestions VALUES ('1', 1, NULL, NULL, 'review', 'mittel', 'none', '{"difficulty":{"leicht":1}', NULL, 'learned', '[]', 'r', 0, 0, 0, 0, 1, NULL, NULL, NULL, NULL, NULL)`,
		);
		db.close();
		expect(() => openDatabase(path)).toThrow();
		const after = new Database(path, { readonly: true });
		expect(after.query("PRAGMA user_version").get()).toEqual({
			user_version: 3,
		});
		expect(after.query("SELECT difficulty FROM suggestions").get()).toEqual({
			difficulty: "mittel",
		});
		after.close();
	});

	test("v3 difficulty migration preserves rows, outcomes and unrelated JSON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "spatz-v3-"));
		dirs.push(dir);
		const path = join(dir, "v3.db");
		const db = new Database(path);
		db.run(await Bun.file(join(import.meta.dir, "fixtures/v3.sql")).text());
		for (const [i, difficulty] of [
			"leicht",
			"mittel",
			"schwer",
			"easy",
		].entries()) {
			db.run(
				`INSERT INTO suggestions VALUES (?, 1, NULL, NULL, 'review', ?, 'none', ?, NULL, 'learned', ?, ?, 0, 0, 0, 0, 1, NULL, 'turn', 'claude-code-mod', 't1', NULL)`,
				[
					String(i),
					difficulty,
					i === 3
						? null
						: JSON.stringify({
								difficulty: {
									leicht: 0.1,
									mittel: 0.2,
									schwer: 0.7,
									...(i === 1 && { medium: 0.8 }),
								},
								best_candidate: { "m/leicht:low": 1 },
							}),
					JSON.stringify([
						{ model: "m/leicht", effort: "low", n: 5, estimate: 0.9 },
					]),
					"Selected on the leicht+mittel+schwer level.",
				],
			);
			db.run(
				"INSERT INTO usages VALUES (?, 'm/a', 'low', 'report', '', 3, 4, 5, 6, 0, 1, 'note', 2, NULL, NULL)",
				[String(i)],
			);
			db.run(
				"INSERT INTO signals VALUES (?, 'report', ?, 1, 'report', 2, NULL, NULL)",
				[String(i), i / 3],
			);
		}
		db.run(
			"INSERT INTO usage_scopes VALUES ('session', 'transcript', 'prompt', 1, 2)",
		);
		const tables = ["usages", "signals", "usage_scopes", "outcomes"];
		const before = tables.map((t) => db.query(`SELECT * FROM ${t}`).all());
		db.close();
		const store = open(path);
		const migrated = new Database(path);
		try {
			expect(migrated.query("PRAGMA user_version").get()).toEqual({
				user_version: 4,
			});
			expect(
				migrated.query("SELECT difficulty FROM suggestions ORDER BY id").all(),
			).toEqual(
				["easy", "medium", "hard", "easy"].map((difficulty) => ({
					difficulty,
				})),
			);
			for (const [i, table] of tables.entries())
				expect(migrated.query(`SELECT * FROM ${table}`).all()).toEqual(
					before[i] ?? [],
				);
			const row = migrated
				.query<{ probabilities: string; reason: string }, []>(
					"SELECT probabilities, reason FROM suggestions WHERE id = '0'",
				)
				.get();
			expect(JSON.parse(row?.probabilities ?? "null")).toEqual({
				difficulty: { easy: 0.1, medium: 0.2, hard: 0.7 },
				best_candidate: { "m/leicht:low": 1 },
			});
			expect(row?.reason).toBe("Selected on the easy+medium+hard level.");
			expect(store.getSuggestion("0")?.ranking[0]?.model).toBe("m/leicht");
			expect(store.getSuggestion("1")?.probabilities?.difficulty).toEqual({
				easy: 0.1,
				medium: 0.8,
				hard: 0.7,
			});
			expect(store.getSuggestion("3")?.probabilities).toBeNull();
		} finally {
			migrated.close();
		}
	});

	test("legacy clients write English values and late legacy rows read and group as English", () => {
		const path = tempDb();
		const store = open(path);
		const legacy = JSON.parse(JSON.stringify(suggestion({ id: "old" })));
		legacy.difficulty = "mittel";
		legacy.probabilities = {
			difficulty: { leicht: 0, mittel: 1, schwer: 0 },
			task_type: {},
			criticality: {},
			best_candidate: {},
		};
		store.insertSuggestion(legacy);
		const db = new Database(path);
		try {
			expect(db.query("SELECT difficulty FROM suggestions").get()).toEqual({
				difficulty: "medium",
			});
			expect(store.getSuggestion("old")?.probabilities?.difficulty).toEqual({
				easy: 0,
				medium: 1,
				hard: 0,
			});
			store.insertSuggestion(suggestion({ id: "new" }));
			db.run(
				"UPDATE suggestions SET difficulty = 'mittel', probabilities = ? WHERE id = 'old'",
				[JSON.stringify(legacy.probabilities)],
			);
			for (const id of ["old", "new"]) {
				db.run(
					"INSERT INTO usages VALUES (?, 'm/a', 'low', 'report', '', 0, 0, 0, 0, 0, NULL, NULL, 1, NULL, NULL)",
					[id],
				);
				db.run(
					"INSERT INTO signals VALUES (?, 'report', 1, 1, 'report', 1, NULL, NULL)",
					[id],
				);
			}
			expect(store.getSuggestion("old")?.difficulty).toBe("medium");
			expect(store.getSuggestion("old")?.probabilities?.difficulty).toEqual({
				easy: 0,
				medium: 1,
				hard: 0,
			});
			expect(store.cellStats("code.bugfix")).toEqual([
				{
					task_type: "code.bugfix",
					difficulty: "medium",
					model: "m/a",
					effort: "low",
					n: 2,
					sum_quality: 2,
				},
			]);
		} finally {
			db.close();
		}
	});

	test("populated v2 migrates to v4 without losing rows or outcomes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "spatz-v2-"));
		dirs.push(dir);
		const path = join(dir, "v2.db");
		const db = new Database(path);
		db.run(await Bun.file(join(import.meta.dir, "fixtures/v2.sql")).text());
		db.run(`INSERT INTO suggestions VALUES ('old', 1, 'session', 'prompt', 'review', 'easy', 'none', NULL, NULL, 'rules', '[]', 'legacy', 0, 0, 1, 0, 2, NULL);
			INSERT INTO usages VALUES ('old', 'm/a', 'low', 'report', '', 3, 4, 5, 6, 0, 1, 'note', 2);
			INSERT INTO signals VALUES ('old', 'report', 1, 1, 'report', 2);
			INSERT INTO usage_scopes VALUES ('session', 'transcript', 'prompt', 1, 2);`);
		const tables = [
			"suggestions",
			"usages",
			"signals",
			"usage_scopes",
			"outcomes",
		];
		const before = tables.map((t) => db.query(`SELECT * FROM ${t}`).all());
		db.close();
		const migrated = openDatabase(path);
		try {
			expect(migrated.query("PRAGMA user_version").get()).toEqual({
				user_version: 4,
			});
			for (const [i, table] of tables.entries()) {
				expect(migrated.query(`SELECT * FROM ${table}`).all()).toMatchObject(
					before[i] as object[],
				);
			}
			expect(
				migrated
					.query("SELECT scope, agent, turn_id, agent_id FROM suggestions")
					.get(),
			).toEqual({ scope: null, agent: null, turn_id: null, agent_id: null });
			expect(
				migrated.query("SELECT turn_id, agent_id FROM usages").get(),
			).toEqual({ turn_id: null, agent_id: null });
			expect(
				migrated.query("SELECT turn_id, agent_id FROM signals").get(),
			).toEqual({ turn_id: null, agent_id: null });
		} finally {
			migrated.close();
		}
	});
	test("creates tables, the outcomes view and user_version 4", () => {
		const path = tempDb();
		open(path).dispose();
		stores.length = 0;
		const db = new Database(path);
		const objects = db
			.query<{ name: string; type: string }, []>(
				"SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
			)
			.all();
		const version = db
			.query<{ user_version: number }, []>("PRAGMA user_version")
			.get();
		db.close();
		expect(objects).toEqual(
			expect.arrayContaining([
				{ name: "suggestions", type: "table" },
				{ name: "usages", type: "table" },
				{ name: "signals", type: "table" },
				{ name: "outcomes", type: "view" },
				{ name: "usage_scopes", type: "table" },
			]),
		);
		expect(SCHEMA_VERSION).toBe(4);
		expect(version?.user_version).toBe(4);
	});

	test("a version 1 db migrates to version 4 and keeps its data", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "spatz-v1-")), "v1.db");
		dirs.push(join(path, ".."));
		const db = new Database(path, { create: true });
		db.run(await Bun.file(join(import.meta.dir, "fixtures/v2.sql")).text());
		db.run(
			"INSERT INTO suggestions VALUES ('s1', 1, NULL, NULL, 'review', 'easy', 'none', NULL, NULL, 'rules', '[]', 'r', 0, 0, 0, 0, 1, NULL)",
		);
		db.run("DROP TABLE usage_scopes");
		db.run("PRAGMA user_version = 1");
		db.close();
		expect(open(path).getSuggestion("s1")?.id).toBe("s1");
		const check = new Database(path);
		const table = check
			.query("SELECT name FROM sqlite_master WHERE name = 'usage_scopes'")
			.get();
		const version = check
			.query<{ user_version: number }, []>("PRAGMA user_version")
			.get();
		check.close();
		expect(table).toEqual({ name: "usage_scopes" });
		expect(version?.user_version).toBe(4);
	});

	test("reopening keeps data and does not re-migrate", () => {
		const path = tempDb();
		const first = openStore(path);
		first.insertSuggestion(suggestion());
		first.dispose();
		// Drop the view: a re-migration would recreate it.
		const db = new Database(path);
		db.run("DROP VIEW outcomes");
		db.close();
		const second = open(path);
		expect(second.getSuggestion("s1")?.id).toBe("s1");
		const check = new Database(path);
		const view = check
			.query("SELECT name FROM sqlite_master WHERE name = 'outcomes'")
			.get();
		check.close();
		expect(view).toBeNull();
	});

	test("file db uses WAL and busy_timeout 5000 and creates the parent dir", () => {
		const path = tempDb();
		const store = open(path);
		store.insertSuggestion(suggestion());
		const db = new Database(path);
		const mode = db
			.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
			.get();
		db.close();
		expect(mode?.journal_mode).toBe("wal");
		// busy_timeout is per connection: read it from a handle opened the same way.
		const own = openDatabase(path);
		const busy = own
			.query<{ timeout: number }, []>("PRAGMA busy_timeout")
			.get();
		own.close();
		expect(busy?.timeout).toBe(5000);
	});

	test("':memory:' works", () => {
		const store = open(":memory:");
		store.insertSuggestion(suggestion());
		expect(store.getSuggestion("s1")?.id).toBe("s1");
	});
});

describe("suggestions", () => {
	test("round-trips every field including JSON and booleans", () => {
		const store = open();
		const record = suggestion({
			id: "abc",
			created_at: 42,
			session_id: "sess",
			prompt_id: "p1",
			task_type: "review",
			difficulty: "hard",
			criticality: "security",
			probabilities: {
				task_type: { review: 0.9, other: 0.1 },
				difficulty: { easy: 0.1, medium: 0.2, hard: 0.7 },
				criticality: { security: 1 },
				best_candidate: { "openai/gpt-6-sol:medium": 1 },
			},
			model_ref: "jev-1.13.0",
			strategy: "jev-choice",
			ranking: [
				{ model: "openai/gpt-6-sol", effort: "medium", estimate: 0.75, n: 3 },
				{
					model: "anthropic/claude-opus-5.5",
					effort: "max",
					estimate: 0.5,
					n: 0,
				},
			],
			reason: "because",
			explored: true,
			control: true,
			fallback_used: false,
			is_test: true,
			last_event_at: 99,
			closed_at: 100,
		});
		store.insertSuggestion(record);
		expect(store.getSuggestion("abc")).toEqual(record);
		expect(store.getSuggestion("missing")).toBeNull();
	});

	test("no column holds task text", () => {
		const path = tempDb();
		open(path);
		const db = new Database(path);
		const cols = db
			.query<{ name: string }, []>("PRAGMA table_info(suggestions)")
			.all()
			.map((c) => c.name);
		db.close();
		expect(cols.some((c) => /task$|text|prompt$/.test(c))).toBe(false);
	});
});

function signal(
	store: Store,
	kind: SignalKind,
	value: number,
	observed_at: number,
	suggestion_id = "s1",
) {
	const weight = { report: 1.0, test: 1.0, build: 0.8 }[kind];
	const source = kind === "report" ? "report" : "PostToolUse";
	store.insertSignal({
		suggestion_id,
		kind,
		value,
		weight,
		source,
		observed_at,
	});
}

function usage(over: Partial<UsageRecord> = {}): UsageRecord {
	return {
		suggestion_id: "s1",
		model: "anthropic/claude-opus-5.5",
		effort: "high",
		source: "transcript",
		scope_key: "p1",
		input_tokens: 10,
		output_tokens: 100,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		is_sidechain: false,
		rounds: null,
		note: null,
		reported_at: 1000,
		...over,
	};
}

describe("outcomes", () => {
	test("a report wins over hook signals; latest report counts", () => {
		const store = open();
		store.insertSuggestion(suggestion());
		signal(store, "test", 1, 10);
		signal(store, "build", 1, 11);
		signal(store, "report", 0, 5);
		expect(store.outcome("s1")?.quality).toBe(0);
		signal(store, "report", 0.5, 20);
		expect(store.outcome("s1")?.quality).toBe(0.5);
		signal(store, "report", 1, 30);
		expect(store.outcome("s1")?.quality).toBe(1);
	});

	test("the report with the latest observed_at wins, not the highest or last inserted", () => {
		const store = open();
		store.insertSuggestion(suggestion());
		signal(store, "report", 1, 30);
		signal(store, "report", 0, 40);
		expect(store.outcome("s1")?.quality).toBe(0);
		// Inserted last but observed earlier: must not win.
		signal(store, "report", 0.5, 20);
		expect(store.outcome("s1")?.quality).toBe(0);
	});

	test("without report: weighted mean over kinds", () => {
		const store = open();
		store.insertSuggestion(suggestion());
		signal(store, "test", 1, 10);
		signal(store, "build", 0, 11);
		expect(store.outcome("s1")?.quality).toBeCloseTo(1 / 1.8, 4);
	});

	test("without report: only the last value per kind counts", () => {
		const store = open();
		store.insertSuggestion(suggestion());
		signal(store, "test", 1, 20);
		signal(store, "test", 0, 10);
		expect(store.outcome("s1")?.quality).toBe(1);
		signal(store, "test", 0, 30);
		expect(store.outcome("s1")?.quality).toBe(0);
	});

	test("no signal -> no outcome row", () => {
		const store = open();
		store.insertSuggestion(suggestion());
		store.upsertUsage(usage());
		expect(store.outcome("s1")).toBeNull();
		expect(store.outcome("missing")).toBeNull();
	});
});

describe("used pair", () => {
	test("a report usage wins", () => {
		const store = open();
		store.insertSuggestion(suggestion());
		signal(store, "test", 1, 10);
		store.upsertUsage(usage({ output_tokens: 9999 }));
		store.upsertUsage(
			usage({
				source: "report",
				scope_key: "",
				model: "openai/gpt-6-sol",
				effort: "medium",
				output_tokens: 0,
				rounds: 2,
				note: "ok",
			}),
		);
		expect(store.outcome("s1")).toEqual({
			suggestion_id: "s1",
			quality: 1,
			model: "openai/gpt-6-sol",
			effort: "medium",
		});
	});

	test("otherwise the model with most summed output tokens and its latest non-null effort", () => {
		const store = open();
		store.insertSuggestion(suggestion());
		signal(store, "test", 1, 10);
		store.upsertUsage(
			usage({ model: "openai/gpt-6-sol", scope_key: "p1", output_tokens: 150 }),
		);
		store.upsertUsage(
			usage({
				model: "anthropic/claude-sonnet-5.5",
				effort: "low",
				scope_key: "p1",
				output_tokens: 100,
				reported_at: 1,
			}),
		);
		store.upsertUsage(
			usage({
				model: "anthropic/claude-sonnet-5.5",
				effort: "medium",
				scope_key: "p2",
				output_tokens: 60,
				reported_at: 2,
			}),
		);
		store.upsertUsage(
			usage({
				model: "anthropic/claude-sonnet-5.5",
				effort: null,
				source: "subagent",
				scope_key: "a1",
				output_tokens: 1,
				reported_at: 3,
			}),
		);
		expect(store.outcome("s1")).toEqual({
			suggestion_id: "s1",
			quality: 1,
			model: "anthropic/claude-sonnet-5.5",
			effort: "medium",
		});
	});

	test("no usage -> null pair", () => {
		const store = open();
		store.insertSuggestion(suggestion());
		signal(store, "test", 1, 10);
		expect(store.outcome("s1")).toEqual({
			suggestion_id: "s1",
			quality: 1,
			model: null,
			effort: null,
		});
	});

	test("upsertUsage replaces on (suggestion_id, source, scope_key, model)", () => {
		const store = open();
		store.insertSuggestion(suggestion());
		signal(store, "test", 1, 10);
		store.upsertUsage(usage({ model: "openai/gpt-6-sol", output_tokens: 150 }));
		// Second Stop for the same prompt: same key, updated totals.
		store.upsertUsage(usage({ output_tokens: 100 }));
		store.upsertUsage(usage({ output_tokens: 120 }));
		expect(store.outcome("s1")?.model).toBe("openai/gpt-6-sol");
		store.upsertUsage(usage({ output_tokens: 200 }));
		expect(store.outcome("s1")?.model).toBe("anthropic/claude-opus-5.5");
	});
});

describe("cellStats", () => {
	test("groups non-test outcomes with a used pair by task_type, difficulty, model, effort", () => {
		const store = open();
		const add = (
			id: string,
			over: Partial<SuggestionRecord>,
			quality: number | null,
			pair: Partial<UsageRecord> | null,
		) => {
			store.insertSuggestion(suggestion({ id, ...over }));
			if (quality !== null) signal(store, "report", quality, 10, id);
			if (pair) store.upsertUsage(usage({ suggestion_id: id, ...pair }));
		};
		add("a", {}, 1, {});
		add("b", {}, 0.5, {});
		add("c", { difficulty: "hard" }, 1, {});
		add("d", {}, 1, { model: "openai/gpt-6-sol", effort: "low" });
		add("e", { is_test: true }, 1, {});
		add("f", { task_type: "review" }, 1, {});
		add("g", {}, null, {});
		add("h", {}, 1, null);
		add("i", {}, 1, { effort: null });
		const stats = store.cellStats("code.bugfix");
		expect(stats).toHaveLength(3);
		expect(stats).toEqual(
			expect.arrayContaining([
				{
					task_type: "code.bugfix",
					difficulty: "medium",
					model: "anthropic/claude-opus-5.5",
					effort: "high",
					n: 2,
					sum_quality: 1.5,
				},
				{
					task_type: "code.bugfix",
					difficulty: "hard",
					model: "anthropic/claude-opus-5.5",
					effort: "high",
					n: 1,
					sum_quality: 1,
				},
				{
					task_type: "code.bugfix",
					difficulty: "medium",
					model: "openai/gpt-6-sol",
					effort: "low",
					n: 1,
					sum_quality: 1,
				},
			]),
		);
		expect(store.cellStats("spec")).toEqual([]);
	});

	test("same task_type, difficulty and model with different efforts are separate groups", () => {
		const store = open();
		const add = (id: string, effort: Effort, quality: number) => {
			store.insertSuggestion(suggestion({ id }));
			signal(store, "report", quality, 10, id);
			store.upsertUsage(usage({ suggestion_id: id, effort }));
		};
		add("a", "low", 1);
		add("b", "low", 0);
		add("c", "high", 1);
		add("d", "high", 1);
		add("e", "high", 0.5);
		const cell = {
			task_type: "code.bugfix",
			difficulty: "medium",
			model: "anthropic/claude-opus-5.5",
		};
		const stats = store.cellStats("code.bugfix");
		expect(stats).toHaveLength(2);
		expect(stats).toEqual(
			expect.arrayContaining([
				{ ...cell, effort: "low", n: 2, sum_quality: 1 },
				{ ...cell, effort: "high", n: 3, sum_quality: 2.5 },
			]),
		);
	});
});

describe("session link and open window", () => {
	const H2 = 2 * 60 * 60 * 1000;

	test("linkSession sets session, prompt, last_event_at and closes other open suggestions", () => {
		const store = open();
		const add = (id: string, created_at: number) =>
			store.insertSuggestion(
				suggestion({ id, created_at, last_event_at: created_at }),
			);
		add("old", 1);
		add("closed", 2);
		add("other", 3);
		add("new", 4);
		store.linkSession("closed", "sess", "p1", 10);
		store.closeSuggestion("closed", 12);
		store.linkSession("old", "sess", "p1", 12);
		store.linkSession("other", "sess-2", "p9", 13);
		store.linkSession("new", "sess", "p2", 20);
		expect(store.getSuggestion("new")).toMatchObject({
			session_id: "sess",
			prompt_id: "p2",
			last_event_at: 20,
			closed_at: null,
		});
		// closed where the next call of the session ("closed", created 2) starts
		expect(store.getSuggestion("old")?.closed_at).toBe(2);
		// reported at 12, but the next call of the session started at 4
		expect(store.getSuggestion("closed")?.closed_at).toBe(4);
		expect(store.getSuggestion("other")?.closed_at).toBeNull();
	});

	test("out-of-order and duplicate links keep the newest suggestion open", () => {
		const store = open();
		store.insertSuggestion(suggestion({ id: "older", created_at: 100 }));
		store.insertSuggestion(suggestion({ id: "newer", created_at: 200 }));
		// The async hook of the newer call arrives first.
		store.linkSession("newer", "sess", "p1", 300);
		store.linkSession("older", "sess", "p1", 310);
		expect(store.findOpenSuggestion("sess", 400, H2)).toBe("newer");
		expect(store.getSuggestion("newer")?.closed_at).toBeNull();
		// The older one ends where the newer one starts.
		expect(store.getSuggestion("older")?.closed_at).toBe(200);

		// Duplicate links change nothing and never reopen.
		store.linkSession("newer", "sess", "p1", 320);
		store.linkSession("older", "sess", "p1", 330);
		expect(store.findOpenSuggestion("sess", 400, H2)).toBe("newer");
		expect(store.getSuggestion("older")?.closed_at).toBe(200);
		store.closeSuggestion("newer", 340);
		store.linkSession("newer", "sess", "p1", 350);
		expect(store.getSuggestion("newer")?.closed_at).toBe(340);
		// A delayed link never moves last_event_at backwards.
		store.touch("newer", 500);
		store.linkSession("newer", "sess", "p1", 360);
		expect(store.getSuggestion("newer")?.last_event_at).toBe(500);
	});

	test("findOpenSuggestion returns the latest open suggestion within the window", () => {
		const store = open();
		store.insertSuggestion(suggestion({ id: "a", created_at: 1 }));
		store.insertSuggestion(suggestion({ id: "b", created_at: 2 }));
		store.linkSession("a", "sess", null, 1000);
		store.linkSession("b", "sess", null, 1000);
		expect(store.findOpenSuggestion("sess", 1000 + H2, H2)).toBe("b");
		expect(store.findOpenSuggestion("sess", 1000 + H2 + 1, H2)).toBeNull();
		expect(store.findOpenSuggestion("nope", 1000, H2)).toBeNull();
	});

	test("findOpenSuggestion prefers the newest created_at, then the later rowid", () => {
		const store = open();
		const add = (id: string, created_at: number) =>
			store.insertSuggestion(
				suggestion({ id, created_at, session_id: "sess", last_event_at: 1000 }),
			);
		// Several open suggestions in one session, inserted out of created_at order.
		add("mid", 2);
		add("newest", 3);
		add("oldest", 1);
		expect(store.findOpenSuggestion("sess", 1000, H2)).toBe("newest");
		// Same created_at as "newest": the later insert (higher rowid) wins.
		add("tie", 3);
		expect(store.findOpenSuggestion("sess", 1000, H2)).toBe("tie");
	});

	test("sessionWindows ends at idle expiry even when the next recommendation closes it later", () => {
		const store = open();
		store.insertSuggestion(
			suggestion({ id: "a", created_at: 0, last_event_at: 0 }),
		);
		store.insertSuggestion(
			suggestion({ id: "b", created_at: 2 * H2, last_event_at: 2 * H2 }),
		);
		store.linkSession("a", "sess", null, 0);
		store.linkSession("b", "sess", null, 2 * H2);
		expect(store.getSuggestion("a")?.closed_at).toBe(2 * H2);
		// No activity after 0 h: usage at 3 h belongs to nobody.
		expect(store.sessionWindows("sess", 1.5 * H2, 1.5 * H2, H2)).toEqual([]);
		expect(store.sessionWindows("sess", H2, H2, H2)).toEqual([
			{ id: "a", start: 0, end: H2 + 1 },
		]);
		// An explicit closure before idle expiry still ends the window.
		store.closeSuggestion("b", 2 * H2 + 10);
		expect(store.sessionWindows("sess", 2 * H2, 2 * H2, H2)).toEqual([
			{ id: "b", start: 2 * H2, end: 2 * H2 + 10 },
		]);
	});

	test("linkSession returns the shrunk windows; usageScopes and rewriteScope work per session scope", () => {
		const store = open();
		store.insertSuggestion(suggestion({ id: "a", created_at: 1 }));
		store.insertSuggestion(suggestion({ id: "b", created_at: 2 }));
		store.insertSuggestion(suggestion({ id: "x", created_at: 3 }));
		expect(store.linkSession("a", "sess", "p1", 10)).toEqual([]);
		store.linkSession("x", "other", "p1", 10);
		store.upsertUsage(usage({ suggestion_id: "a" }));
		store.upsertUsage(usage({ suggestion_id: "x" }));
		store.upsertUsage(
			usage({ suggestion_id: "a", source: "subagent", scope_key: "a1" }),
		);
		store.upsertUsage(
			usage({ suggestion_id: "a", source: "agent_tool", scope_key: "a1" }),
		);
		expect(store.linkSession("b", "sess", "p1", 10)).toEqual(["a"]);
		expect(store.linkSession("b", "sess", "p1", 11)).toEqual([]);
		expect(store.usageScopes(["a"])).toEqual([
			{ source: "subagent", scope_key: "a1", effort: "high" },
			{ source: "transcript", scope_key: "p1", effort: "high" },
		]);
		const scope = {
			session_id: "sess",
			source: "transcript",
			scope_key: "p1",
			message_count: 2,
			from: 1,
			last_at: 5,
			openWindowMs: H2,
		} as const;
		let seen: unknown;
		expect(
			store.rewriteScope(scope, (windows) => {
				seen = windows;
				return [];
			}),
		).toBe(true);
		expect(seen).toEqual([
			{ id: "a", start: 1, end: 2 },
			{ id: "b", start: 2, end: 1000 + H2 + 1 },
		]);
		// An older snapshot (fewer messages or an earlier last message) is skipped.
		const never = () => {
			throw new Error("not called");
		};
		expect(store.rewriteScope({ ...scope, message_count: 1 }, never)).toBe(
			false,
		);
		expect(store.rewriteScope({ ...scope, last_at: 4 }, never)).toBe(false);
		expect(store.usageScopes(["a", "x"])).toEqual([
			{ source: "subagent", scope_key: "a1", effort: "high" },
			{ source: "transcript", scope_key: "p1", effort: "high" },
		]);
		expect(store.usageScopes(["a"])).toHaveLength(1);
		expect(store.usageScopes([])).toEqual([]);
	});

	test("rewriteScope watermark: the last message timestamp decides, then the message count", () => {
		const store = open();
		const scope = {
			session_id: "sess",
			source: "transcript",
			scope_key: "p1",
			message_count: 3,
			from: 1,
			last_at: 5,
			openWindowMs: H2,
		} as const;
		const none = () => [];
		const never = () => {
			throw new Error("not called");
		};
		expect(store.rewriteScope(scope, none)).toBe(true);
		// An equal snapshot rewrites (link reconciliation depends on it).
		expect(store.rewriteScope(scope, none)).toBe(true);
		expect(store.rewriteScope({ ...scope, last_at: 4 }, never)).toBe(false);
		expect(store.rewriteScope({ ...scope, message_count: 2 }, never)).toBe(
			false,
		);
		// A compacted transcript: fewer messages, but a newer last message.
		expect(
			store.rewriteScope({ ...scope, message_count: 1, last_at: 6 }, none),
		).toBe(true);
		// Its watermark now wins over the longer, older snapshot.
		expect(store.rewriteScope(scope, never)).toBe(false);
	});

	test("touch extends the window; closeSuggestion ends it", () => {
		const store = open();
		store.insertSuggestion(suggestion());
		store.linkSession("s1", "sess", "p1", 1000);
		store.touch("s1", 5000);
		expect(store.getSuggestion("s1")?.last_event_at).toBe(5000);
		expect(store.findOpenSuggestion("sess", 1000 + H2 + 1, H2)).toBe("s1");
		store.closeSuggestion("s1", 6000);
		expect(store.getSuggestion("s1")?.closed_at).toBe(6000);
		expect(store.findOpenSuggestion("sess", 6000, H2)).toBeNull();
	});
});

test("agent windows are independent and late links only close their own scope", () => {
	const store = open();
	for (const [id, at, agent_id] of [
		["main", 10, null],
		["a1", 20, "a"],
		["b1", 25, "b"],
		["a2", 30, "a"],
		["main2", 40, null],
	] as const) {
		store.insertSuggestion(
			suggestion({
				id,
				created_at: at,
				last_event_at: at,
				agent_id,
				agent: "claude-code-mod",
				scope: agent_id ? "subagent" : "turn",
			}),
		);
	}
	for (const id of ["main2", "a2", "b1", "main", "a1"])
		store.linkSession(id, "sess", null, 50);
	expect(store.getSuggestion("main")?.closed_at).toBe(40);
	expect(store.getSuggestion("a1")?.closed_at).toBe(30);
	expect(store.getSuggestion("b1")?.closed_at).toBeNull();
	expect(store.findOpenSuggestion("sess", 50, 100)).toBe("main2");
	expect(store.findOpenSuggestion("sess", 50, 100, "a")).toBe("a2");
	expect(store.sessionWindows("sess", 0, 50, 100, "a")).toEqual([
		{ id: "a1", start: 20, end: 30 },
		{ id: "a2", start: 30, end: 151 },
	]);
	expect(store.sessionWindows("sess", 0, 50, 100)).toEqual([
		{ id: "main", start: 10, end: 40 },
		{ id: "main2", start: 40, end: 151 },
	]);
});

test("none-only models normalize missing usage effort and pool legacy null rows", () => {
	const path = tempDb();
	const model = "anthropic/claude-haiku-4.5";
	const legacy = openStore(path);
	for (const [id, m] of [
		["old", model],
		["unknown", "m/unknown"],
		["reasoning", "anthropic/claude-opus-5.5"],
	]) {
		legacy.insertSuggestion(suggestion({ id }));
		legacy.upsertUsage(usage({ suggestion_id: id, model: m, effort: null }));
		signal(legacy, "test", 1, 1000, id);
	}
	legacy.dispose();
	const store = openStore(path, [model]);
	stores.push(store);
	for (const [id, effort] of [
		["new", null],
		["explicit", "high"],
	] as const) {
		store.insertSuggestion(suggestion({ id }));
		store.upsertUsage(usage({ suggestion_id: id, model, effort }));
		signal(store, "test", 1, 1000, id);
	}
	expect(store.outcome("new")?.effort).toBe("none");
	expect(store.outcome("explicit")?.effort).toBe("high");
	expect(store.cellStats("code.bugfix")).toEqual([
		{
			task_type: "code.bugfix",
			difficulty: "medium",
			model,
			effort: "high",
			n: 1,
			sum_quality: 1,
		},
		{
			task_type: "code.bugfix",
			difficulty: "medium",
			model,
			effort: "none",
			n: 2,
			sum_quality: 2,
		},
	]);
});
test("usage scopes select the highest ranked effort, not lexical maximum", () => {
	const store = open();
	for (const [i, effort] of (
		["none", "medium", "high", "max", "xhigh", "ultra"] as const
	).entries()) {
		store.upsertUsage(usage({ model: `m/${i}`, effort }));
		expect(store.usageScopes(["s1"])[0]?.effort).toBe(i === 4 ? "max" : effort);
	}
	expect(store.usageScopes([])).toEqual([]);
});
