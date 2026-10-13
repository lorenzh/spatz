import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskType } from "../contracts/types.ts";
import { runStats } from "../report/index.ts";
import { openDatabase, openStore, SCHEMA_VERSION } from "./index.ts";

const dirs: string[] = [];
const handles: Database[] = [];
afterEach(() => {
	for (const db of handles.splice(0)) db.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function directory() {
	const dir = mkdtempSync(join(tmpdir(), "spatz-migration-"));
	dirs.push(dir);
	return dir;
}

async function fixture(dir: string, version = 7) {
	const path = join(dir, "spatz.db");
	const db = new Database(path);
	handles.push(db);
	db.run("PRAGMA journal_mode = WAL");
	db.run(
		await Bun.file(join(import.meta.dir, `fixtures/v${version}.sql`)).text(),
	);
	return { path, db };
}

// Use the previous schema to exercise a real migration and restore with the old CLI.
async function previousStore(dir: string, drop = 1) {
	const source = (await Bun.file(join(import.meta.dir, "index.ts")).text())
		.replaceAll('from "./', `from "${import.meta.dir}/`)
		.replaceAll(
			'from "../contracts/',
			`from "${join(import.meta.dir, "../contracts")}/`,
		)
		.replace(
			"export const SCHEMA_VERSION",
			`MIGRATIONS.splice(-${drop});\nexport const SCHEMA_VERSION`,
		);
	const path = join(dir, "previous-store.ts");
	await Bun.write(path, source);
	return import(path) as Promise<typeof import("./index.ts")>;
}

const tables = [
	"suggestions",
	"usages",
	"signals",
	"usage_scopes",
	"failures",
	"outcomes",
];
// Every table and view (outcomes included), so a new table is compared without a list update.
const snapshot = (db: Database) =>
	Object.fromEntries(
		db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all()
			.map(({ name }) => [
				name,
				db
					.query(`SELECT * FROM "${name}"`)
					.all()
					.map((row) => JSON.stringify(row))
					.sort()
					.map((row) => JSON.parse(row)),
			]),
	);
const rows = (db: Database) =>
	tables.map((table) => db.query(`SELECT * FROM ${table}`).all());

test("previous-schema WAL data is backed up before migration and restores with the old CLI", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir);
	const previous = await previousStore(dir);
	previous.openDatabase(path).close();
	expect(db.query("PRAGMA user_version").get()).toEqual({
		user_version: SCHEMA_VERSION - 1,
	});
	const before = rows(db);
	const migrated = openDatabase(path);
	handles.push(migrated);
	expect(migrated.query("PRAGMA user_version").get()).toEqual({
		user_version: SCHEMA_VERSION,
	});
	expect(rows(migrated)).toMatchObject(
		before.map((set, i) =>
			i === 0
				? (set as { closed_at?: number | null }[]).map(
						({ closed_at, ...r }) => ({
							...r,
							closed_at: closed_at ?? expect.any(Number),
						}),
					)
				: set,
		),
	);
	const backup = `${path}.bak-v${SCHEMA_VERSION - 1}`;
	expect(existsSync(backup)).toBe(true);
	const restoredPath = join(dir, "restored.db");
	copyFileSync(backup, restoredPath);
	const restored = previous.openDatabase(restoredPath);
	handles.push(restored);
	expect(restored.query("PRAGMA user_version").get()).toEqual({
		user_version: SCHEMA_VERSION - 1,
	});
	expect(restored.query("PRAGMA integrity_check").get()).toEqual({
		integrity_check: "ok",
	});
	expect(rows(restored)).toEqual(before);
	expect(() => previous.openDatabase(path)).toThrow(
		new RegExp(`schema.*${SCHEMA_VERSION}.*upgrade.*CLI`, "i"),
	);
});

test("fresh and current databases do not create backups", async () => {
	const dir = directory();
	const path = join(dir, "spatz.db");
	openDatabase(path).close();
	openDatabase(path).close();
	expect(readdirSync(dir).filter((name) => name.includes(".bak"))).toEqual([]);
});

test("migration keeps three backup versions and leaves unrelated files alone", async () => {
	const dir = directory();
	const { path } = await fixture(dir, 4);
	for (const suffix of ["1", "2", "3", "notes"])
		await Bun.write(`${path}.bak-v${suffix}`, suffix);
	openDatabase(path).close();
	expect(
		readdirSync(dir)
			.filter((name) => name.includes(".bak"))
			.sort(),
	).toEqual([
		"spatz.db.bak-v2",
		"spatz.db.bak-v3",
		"spatz.db.bak-v4",
		"spatz.db.bak-vnotes",
	]);
});

test("a failed backup aborts migration and releases the write lock", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir, 4);
	const { mkdirSync } = await import("node:fs");
	mkdirSync(`${path}.bak-v4`);
	expect(() => openDatabase(path)).toThrow();
	expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
	db.transaction(() =>
		db.run("UPDATE suggestions SET reason = 'still writable'"),
	).immediate();
});

test("newer schemas are refused without changing the database", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir);
	db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
	const before = rows(db);
	expect(() => openDatabase(path)).toThrow(/upgrade.*CLI/i);
	expect(rows(db)).toEqual(before);
	expect(readdirSync(dir).filter((name) => name.includes(".bak"))).toEqual([]);
});

test("backup waits for a writer and concurrent openers migrate only once", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir, 4);
	db.run("BEGIN IMMEDIATE");
	db.run("UPDATE suggestions SET reason = 'committed by writer'");
	const script = `import { openDatabase } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
console.log("ready"); openDatabase(process.argv[1]).close();`;
	const children = [0, 1].map(() =>
		Bun.spawn([process.execPath, "-e", script, path], {
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	try {
		for (const child of children) {
			const reader = child.stdout.getReader();
			await reader.read();
			reader.releaseLock();
		}
		await Bun.sleep(100);
		expect(existsSync(`${path}.bak-v4`)).toBe(false);
		db.run("COMMIT");
		for (const child of children) {
			expect(await new Response(child.stderr).text()).toBe("");
			expect(await child.exited).toBe(0);
		}
		const backup = new Database(`${path}.bak-v4`, { readonly: true });
		handles.push(backup);
		expect(
			backup.query("SELECT DISTINCT reason FROM suggestions").all(),
		).toEqual([{ reason: "committed by writer" }]);
		expect(backup.query("PRAGMA user_version").get()).toEqual({
			user_version: 4,
		});
		expect(db.query("PRAGMA user_version").get()).toEqual({
			user_version: SCHEMA_VERSION,
		});
	} finally {
		if (db.inTransaction) db.run("ROLLBACK");
		for (const child of children) {
			child.kill();
			await child.exited;
		}
	}
});

test("v7 fixture preserves all data and adds an empty attempt ledger", async () => {
	const { path, db } = await fixture(directory(), 7);
	const before = rows(db);
	const migrated = openDatabase(path);
	handles.push(migrated);
	expect(rows(migrated)).toMatchObject(
		before.map((set, i) =>
			i === 0
				? (set as { closed_at?: number | null }[]).map(
						({ closed_at, ...r }) => ({
							...r,
							closed_at: closed_at ?? expect.any(Number),
						}),
					)
				: set,
		),
	);
	expect(migrated.query("SELECT * FROM attempts").all()).toEqual([]);
	expect(
		migrated
			.query("SELECT * FROM legacy_outcomes WHERE suggestion_id='proof'")
			.get(),
	).toEqual({ suggestion_id: "proof", quality: 1, model: "A", effort: "low" });
	expect(
		migrated
			.query(
				"SELECT SUM(output_tokens) AS n FROM usage_totals WHERE suggestion_id='proof'",
			)
			.get(),
	).toEqual({ n: 60 });
	expect(migrated.query("PRAGMA foreign_keys").get()).toEqual({
		foreign_keys: 1,
	});
	expect(migrated.query("PRAGMA user_version").get()).toEqual({
		user_version: SCHEMA_VERSION,
	});
});

test("attempt migration failure rolls back every statement and the version", async () => {
	const { path, db } = await fixture(directory(), 7);
	db.run("CREATE TABLE attempts (conflict TEXT)");
	const before = rows(db);
	expect(() => openDatabase(path)).toThrow();
	expect(rows(db)).toEqual(before);
	expect(db.query("PRAGMA user_version").get()).toEqual({
		user_version: 7,
	});
	expect(
		db
			.query("PRAGMA table_info(suggestions)")
			.all()
			.some((r) => (r as { name: string }).name === "is_legacy"),
	).toBe(false);
});

test("v7 migration creates report metadata and indexed latest revisions", async () => {
	const dir = directory();
	const { path } = await fixture(dir, 7);
	const migrated = openDatabase(path);
	handles.push(migrated);
	migrated.run(`INSERT INTO attempt_events(harness,session_key,agent_key,event_id,revision,binding,kind,source,received_at,output_tokens)
 VALUES('claude-code','session','','event',0,'pending','usage','transcript',1000,20),
 ('claude-code','session','','event',1,'pending','usage','transcript',1001,30)`);
	expect(
		migrated
			.query(
				"SELECT event_id,output_tokens,rounds,note FROM latest_attempt_events",
			)
			.all(),
	).toEqual([
		{ event_id: "event", output_tokens: 30, rounds: null, note: null },
	]);
	expect(migrated.query("PRAGMA user_version").get()).toEqual({
		user_version: SCHEMA_VERSION,
	});
	expect(
		migrated
			.query(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='events_attempt'",
			)
			.get(),
	).toEqual({ name: "events_attempt" });
});

test("v8 index failure rolls back the whole ledger and keeps v7 rows", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir, 7);
	db.run("CREATE INDEX events_attempt ON suggestions(id)");
	const before = rows(db);
	expect(() => openDatabase(path)).toThrow();
	expect(rows(db)).toEqual(before);
	expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
	expect(
		db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='attempt_events'",
			)
			.get(),
	).toBeNull();
});

test("usage completeness migration marks stored Claude subagents and filters existing costs", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir);
	// Back to v8: drop v9 (usage completeness) and every later migration.
	const previous = await previousStore(dir, SCHEMA_VERSION - 8);
	previous.openDatabase(path).close();
	db.run("UPDATE suggestions SET agent='claude-code' WHERE id IN ('h','r')");
	db.run(
		"UPDATE usages SET tokens_complete=1 WHERE suggestion_id='r' AND source='transcript'",
	);
	db.run("UPDATE suggestions SET agent='codex' WHERE id='n'");
	db.run(
		"UPDATE usages SET tokens_complete=1, cost_usd=99, cost_source='reported' WHERE source='subagent'",
	);
	db.run(
		"UPDATE usages SET tokens_complete=1,is_sidechain=1 WHERE suggestion_id='n'",
	);
	db.run(
		"UPDATE usages SET cost_usd=99,cost_source='reported' WHERE suggestion_id='null-effort'",
	);
	for (const [harness, agent, source] of [
		["claude-code", "child", "subagent"],
		["claude-code", "nested", "transcript"],
		["claude-code", "", "transcript"],
		["codex", "child", "transcript"],
		["claude-code", "mod", "claude-code-mod"],
	] as const) {
		db.run(
			`INSERT INTO attempt_events(harness,session_key,agent_key,event_id,revision,suggestion_id,binding,received_at,kind,source,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,tokens_complete,cost_usd,cost_source)
            VALUES(?, 'session', ?, ?, 0, 'proof', 'bound', 1, 'usage', ?, 1, 3, 0, 0, 1, 99, 'reported')`,
			[harness, agent, `${harness}:${agent}`, source],
		);
	}
	const migrated = openDatabase(path);
	handles.push(migrated);
	expect(
		migrated
			.query("SELECT tokens_complete FROM usages WHERE source='subagent'")
			.get(),
	).toEqual({ tokens_complete: 0 });
	expect(
		migrated
			.query("SELECT tokens_complete FROM usages WHERE suggestion_id='n'")
			.get(),
	).toEqual({ tokens_complete: 1 });
	expect(
		migrated
			.query(
				"SELECT cost_usd FROM usage_totals WHERE suggestion_id='null-effort'",
			)
			.get(),
	).toEqual({ cost_usd: null });
	expect(
		migrated
			.query(
				"SELECT harness,agent_key,tokens_complete FROM attempt_events ORDER BY harness,agent_key",
			)
			.all(),
	).toEqual([
		{ harness: "claude-code", agent_key: "", tokens_complete: 1 },
		{ harness: "claude-code", agent_key: "child", tokens_complete: 0 },
		{ harness: "claude-code", agent_key: "mod", tokens_complete: 1 },
		{ harness: "claude-code", agent_key: "nested", tokens_complete: 0 },
		{ harness: "codex", agent_key: "child", tokens_complete: 1 },
	]);
	expect(
		migrated
			.query(
				"SELECT cost_usd FROM usage_totals WHERE suggestion_id='r' AND model='m/b'",
			)
			.get(),
	).toEqual({ cost_usd: 0.093 });
	expect(
		migrated
			.query(
				"SELECT tokens_complete FROM usages WHERE suggestion_id='r' AND source='transcript'",
			)
			.get(),
	).toEqual({ tokens_complete: 1 });
	expect(
		migrated
			.query("SELECT cost_usd FROM attempt_usage WHERE suggestion_id='proof'")
			.get(),
	).toEqual({ cost_usd: null });
});

// Proves the backup bytes and the current store only. No older CLI runs here:
// that needs an install of a released tag, which is not offline in bun test.
test("a v5 backup keeps its rows and the current store refuses a newer schema", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir, 5);
	const before = snapshot(db);
	for (const [name, rows] of Object.entries(before))
		expect({ name, populated: rows.length > 0 }).toEqual({
			name,
			populated: true,
		});
	db.close();
	const originalPath = join(dir, "original.db");
	copyFileSync(path, originalPath);
	openDatabase(path).close();
	const restoredPath = join(dir, "restored.db");
	copyFileSync(`${path}.bak-v5`, restoredPath);
	const restored = new Database(restoredPath);
	handles.push(restored);
	expect(restored.query("PRAGMA user_version").get()).toEqual({
		user_version: 5,
	});
	expect(snapshot(restored)).toEqual(before);
	restored.close();
	// Learning stats and token totals of the restored backup match the original data.
	const stats = async (file: string) => {
		const store = openStore(file);
		const cells = ["review", "code.bugfix", "other"].flatMap((t) =>
			store.cellStats(t as TaskType),
		);
		expect(cells.length).toBeGreaterThan(0);
		return {
			cells,
			report: await runStats({ dbPath: file, successQuality: 0.8 }),
		};
	};
	expect(await stats(restoredPath)).toEqual(await stats(originalPath));
	const newer = openDatabase(path);
	newer.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
	newer.close();
	expect(() => openDatabase(path)).toThrow(/newer than supported.*upgrade/i);
});

const DATED = "openai/gpt-5-2025-08-07";
const STABLE = "openai/gpt-5";
// Store holding rows the way spatz 0.4 wrote them (dated GPT keys), with one open suggestion s1.
async function datedStore(
	write: (old: ReturnType<typeof openStore>, path: string) => void,
	over: Record<string, unknown> = {},
) {
	const dir = directory();
	const path = join(dir, "spatz.db");
	const old = openStore(path);
	old.insertSuggestion({
		id: "s1",
		created_at: 1000,
		scope: null,
		agent: null,
		turn_id: null,
		agent_id: null,
		session_id: "s",
		prompt_id: null,
		task_type: "code.bugfix",
		difficulty: "medium",
		criticality: "none",
		probabilities: null,
		model_ref: null,
		strategy: "rules",
		ranking: [],
		reason: "r",
		explored: false,
		control: false,
		fallback_used: true,
		fallback_reason: null,
		is_test: false,
		last_event_at: 1000,
		closed_at: null,
		...over,
	});
	write(old, path);
	old.dispose();
	return path;
}
const ctx = { harness: "codex", session_key: "s", agent_key: "" };

test("dated gpt keys from older stores match their stable key", async () => {
	const dated = {
		...ctx,
		suggestion_id: "s1",
		key: "t:0",
		model: DATED,
		effort: "high" as const,
		at: 1100,
	};
	let id = "";
	const store = openStore(
		await datedStore((old) => {
			id = old.startAttempt(dated).id;
		}),
	);
	const stable = { model: STABLE, model_version: "2025-08-07" };
	expect(store.startAttempt({ ...dated, ...stable }).id).toBe(id);
	expect(
		store.reportAttempt({
			suggestion_id: "s1",
			attempt_id: id,
			...stable,
			effort: "high",
			result: "pass",
			at: 2000,
		}).attempt_id,
	).toBe(id);
	expect(
		store.reportAttempt({
			suggestion_id: "s1",
			...stable,
			effort: "high",
			result: "pass",
			at: 2001,
		}).attempt_id,
	).toBe(id);
	expect(store.cellStats("code.bugfix")).toMatchObject([
		{ model: STABLE, n: 1 },
	]);
	store.dispose();
});

test("replaying a dated usage with the stable key does not double its tokens", async () => {
	const usage = (model: string) => ({
		suggestion_id: "s1",
		model,
		effort: "high" as const,
		source: "transcript" as const,
		scope_key: "turn",
		turn_id: "turn",
		agent_id: null,
		input_tokens: 10,
		output_tokens: 20,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		is_sidechain: false,
		rounds: null,
		note: null,
		reported_at: 1100,
	});
	const path = await datedStore((old) => old.upsertUsage(usage(DATED)));
	const store = openStore(path);
	store.upsertUsage(usage(STABLE));
	const db = new Database(path);
	handles.push(db);
	expect(
		db
			.query(
				"SELECT model, SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM usage_totals WHERE attempt_id IS NOT NULL GROUP BY model",
			)
			.all(),
	).toEqual([{ model: STABLE, i: 10, o: 20 }]);
	store.dispose();
});

test("legacy outcomes read a colliding dated usage under the stable key", async () => {
	const path = await datedStore((_old, p) => {
		const db = new Database(p);
		db.run("UPDATE suggestions SET is_legacy = 1");
		for (const [model, out] of [
			[STABLE, 1],
			[DATED, 50],
		] as const)
			db.run(
				"INSERT INTO usages (suggestion_id,model,effort,source,scope_key,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,is_sidechain,reported_at) VALUES ('s1',?,'high','transcript','turn',1,?,0,0,0,1100)",
				[model, out],
			);
		db.run(
			"INSERT INTO signals (suggestion_id,kind,value,weight,source,observed_at) VALUES ('s1','report',1,1,'report',1200)",
		);
		db.close();
	});
	const store = openStore(path);
	expect(store.cellStats("code.bugfix").map((c) => c.model)).toEqual([STABLE]);
	store.dispose();
});

const usageAt = (model: string) => ({
	suggestion_id: "s1",
	model,
	effort: "high" as const,
	source: "transcript" as const,
	scope_key: "turn",
	turn_id: "turn",
	agent_id: null,
	input_tokens: 10,
	output_tokens: 20,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
	is_sidechain: false,
	rounds: null,
	note: null,
	reported_at: 1100,
});
const totals = (path: string) => {
	const db = new Database(path);
	handles.push(db);
	return db
		.query(
			"SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM attempt_events e WHERE kind = 'usage' AND revision = (SELECT MAX(revision) FROM attempt_events x WHERE x.event_id = e.event_id)",
		)
		.get();
};

test("caller keys that contain a dated model stay unchanged", async () => {
	const key = `k:${DATED}`;
	const step = (model: string, attempt_id: string) => ({
		...ctx,
		event_id: `step:${DATED}`,
		revision: 0,
		suggestion_id: "s1",
		attempt_id,
		kind: "usage" as const,
		source: "transcript",
		model,
		effort: "high" as const,
		input_tokens: 10,
		output_tokens: 20,
		source_seq: 0,
		received_at: 1100,
	});
	let id = "";
	const path = await datedStore((old) => {
		id = old.startAttempt({
			...ctx,
			suggestion_id: "s1",
			key,
			model: DATED,
			effort: "high",
			at: 1100,
		}).id;
		old.recordAttemptEvents([step(DATED, id)]);
	});
	const store = openStore(path);
	expect(
		store.startAttempt({
			...ctx,
			suggestion_id: "s1",
			key,
			model: STABLE,
			effort: "high",
			at: 1100,
		}).id,
	).toBe(id);
	store.recordAttemptEvents([step(STABLE, id)]);
	expect(totals(path)).toEqual({ i: 10, o: 20 });
	store.dispose();
});

test("dated usage revisions next to a stable event keep their totals", async () => {
	const path = await datedStore((old) => {
		old.upsertUsage({ ...usageAt(DATED), output_tokens: 20 });
		old.upsertUsage({ ...usageAt(DATED), output_tokens: 30 });
		old.recordAttemptEvents([
			{
				...ctx,
				harness: "claude-code",
				session_key: "s",
				event_id: `usage:transcript:turn:${STABLE}`,
				revision: 0,
				suggestion_id: "s1",
				kind: "usage",
				source: "transcript",
				model: STABLE,
				effort: "high",
				input_tokens: 10,
				output_tokens: 40,
				source_seq: 0,
				received_at: 1100,
			},
		]);
	});
	const before = totals(path);
	expect(before).toMatchObject({ o: 70 });
	const store = openStore(path);
	expect(totals(path)).toEqual(before as object);
	store.dispose();
});

test("a stable usage replay of a dated event reads back", async () => {
	const path = await datedStore((old) => old.upsertUsage(usageAt(DATED)));
	const store = openStore(path);
	store.upsertUsage(usageAt(STABLE));
	expect(store.getUsage("s1", "transcript", "turn", STABLE)).toMatchObject({
		output_tokens: 20,
	});
	store.dispose();
});

test("alternating dated and stable usage keys stay on one attempt", async () => {
	const path = await datedStore((old) => old.upsertUsage(usageAt(DATED)));
	const store = openStore(path);
	store.upsertUsage(usageAt(STABLE));
	store.upsertUsage(usageAt(DATED));
	const db = new Database(path);
	handles.push(db);
	expect(db.query("SELECT COUNT(*) AS n FROM attempts").get()).toEqual({
		n: 1,
	});
	store.dispose();
});

test("stats group dated and stable outcomes as one pair", async () => {
	const priced = (model: string) => ({
		...usageAt(model),
		cost_usd: 0.1,
		cost_source: "reported" as const,
	});
	const path = await datedStore((old) => {
		old.upsertUsage(priced(DATED));
		old.reportAttempt({
			suggestion_id: "s1",
			model: DATED,
			effort: "high",
			result: "pass",
			at: 1200,
		});
	});
	const store = openStore(path);
	store.upsertUsage(priced(STABLE));
	store.dispose();
	const stats = await runStats({ dbPath: path, successQuality: 0.8 });
	expect(
		stats.by_type
			.flatMap((t) => t.pairs)
			.map((p) => [p.model, p.cost_usd_per_attempt]),
	).toEqual([[STABLE, 0.1]]);
});

const pairsOf = async (path: string) =>
	(await runStats({ dbPath: path, successQuality: 0.8 })).by_type.flatMap(
		(t) => t.pairs,
	);

test("cost per attempt sums dated and stable events of one attempt", async () => {
	const priced = (model: string, scope_key: string, cost_usd: number) => ({
		...usageAt(model),
		scope_key,
		turn_id: scope_key,
		cost_usd,
		cost_source: "reported" as const,
	});
	const path = await datedStore((old) =>
		old.upsertUsage(priced(DATED, "t1", 0.1)),
	);
	const store = openStore(path);
	store.upsertUsage(priced(STABLE, "t2", 0.2));
	store.reportAttempt({
		suggestion_id: "s1",
		model: STABLE,
		effort: "high",
		result: "pass",
		at: 1200,
	});
	store.dispose();
	expect((await pairsOf(path))[0]?.cost_usd_per_attempt).toBeCloseTo(0.3);
});

test("a stable usage is priced from a dated price snapshot", async () => {
	const price = {
		price_prompt: 0.001,
		price_completion: 0.002,
		price_cache_read: 0,
		price_cache_write: 0,
	};
	const path = await datedStore(() => {}, {
		price_snapshot: { [DATED]: price },
	});
	const store = openStore(path);
	store.upsertUsage(usageAt(STABLE));
	expect(
		store.getUsage("s1", "transcript", "turn", STABLE)?.cost_usd,
	).toBeCloseTo(0.05);
	store.dispose();
});

test("a dated recommendation counts as adopted by its stable execution", async () => {
	const path = await datedStore(() => {}, {
		ranking: [{ model: DATED, effort: "high", estimate: 0.5, n: 0 }],
	});
	const store = openStore(path);
	store.upsertUsage(usageAt(STABLE));
	store.reportAttempt({
		suggestion_id: "s1",
		model: STABLE,
		effort: "high",
		result: "pass",
		at: 1200,
	});
	store.dispose();
	const stats = await runStats({ dbPath: path, successQuality: 0.8 });
	expect(stats.by_type[0]?.adoption_rate).toBe(1);
});

test("cost per attempt stays unknown when one event has no cost", async () => {
	const at = (model: string, scope_key: string) => ({
		...usageAt(model),
		scope_key,
		turn_id: scope_key,
	});
	const path = await datedStore((old) => {
		old.upsertUsage({
			...at(DATED, "t1"),
			cost_usd: 0.1,
			cost_source: "reported" as const,
		});
		old.upsertUsage(at(DATED, "t2"));
	});
	const store = openStore(path);
	store.upsertUsage(at(STABLE, "t2"));
	store.reportAttempt({
		suggestion_id: "s1",
		model: STABLE,
		effort: "high",
		result: "pass",
		at: 1200,
	});
	store.dispose();
	expect((await pairsOf(path))[0]?.cost_usd_per_attempt).toBeNull();
});

test("v15 keeps populated v14 attempts and dispatches, backfills their calls, and the backup restores every table", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir);
	const previous = await previousStore(dir);
	const old = previous.openStore(path);
	for (const [id, agent] of [
		["w1", "a1"],
		["w2", "a2"],
	] as const)
		old.insertSuggestion({
			id,
			created_at: 1000,
			session_id: "s",
			prompt_id: null,
			agent_id: agent,
			agent: "claude-code",
			turn_id: null,
			scope: null,
			task_type: "code.bugfix",
			difficulty: "medium",
			criticality: "none",
			probabilities: null,
			model_ref: null,
			strategy: "rules",
			ranking: [{ model: "m/w", effort: "low", estimate: 0.5, n: 0 }],
			reason: "r",
			explored: false,
			control: false,
			fallback_used: true,
			fallback_reason: null,
			is_test: false,
			last_event_at: 1000,
			closed_at: null,
		});
	old.dispose();
	// The current upsertDispatch writes v15 tables, so v14 dispatch rows go in as v14 wrote them.
	for (const [agent, call] of [
		["a1", "t1"],
		["a2", "t2"],
		["a3", null],
	] as const)
		db.query(
			"INSERT INTO dispatches (session_id,agent_id,tool_use_id,answered_model,attempt_id) VALUES ('s',?1,?2,'m/w',(SELECT id FROM attempts WHERE agent_key=?1))",
		).run(agent, call);
	expect(db.query("PRAGMA user_version").get()).toEqual({
		user_version: SCHEMA_VERSION - 1,
	});
	const before = snapshot(db);
	expect(before.attempts).toHaveLength(2);
	// The fixture's own dispatch plus three.
	expect(before.dispatches).toHaveLength(4);
	const migrated = openDatabase(path);
	handles.push(migrated);
	const { dispatch_calls, ...after } = snapshot(migrated);
	expect(after).toEqual(before);
	const attemptOf = (agent: string) =>
		(before.attempts as { id: string; agent_key: string }[]).find(
			(a) => a.agent_key === agent,
		)?.id;
	expect(dispatch_calls).toEqual([
		{
			session_id: "s",
			agent_id: "a1",
			tool_use_id: "t1",
			requested_effort: null,
			recorded_at: null,
			attempt_id: attemptOf("a1"),
		},
		{
			session_id: "s",
			agent_id: "a2",
			tool_use_id: "t2",
			requested_effort: null,
			recorded_at: null,
			attempt_id: attemptOf("a2"),
		},
		{
			session_id: "session",
			agent_id: "child",
			tool_use_id: "call",
			requested_effort: null,
			recorded_at: null,
			attempt_id: null,
		},
	]);
	const restoredPath = join(dir, "restored.db");
	copyFileSync(`${path}.bak-v${SCHEMA_VERSION - 1}`, restoredPath);
	const restored = previous.openDatabase(restoredPath);
	handles.push(restored);
	expect(snapshot(restored)).toEqual(before);
});
