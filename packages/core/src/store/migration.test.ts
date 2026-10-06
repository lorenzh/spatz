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
import { openDatabase, SCHEMA_VERSION } from "./index.ts";

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
async function previousStore(dir: string) {
	const source = (await Bun.file(join(import.meta.dir, "index.ts")).text())
		.replaceAll('from "./attempt', `from "${import.meta.dir}/attempt`)
		.replaceAll(
			'from "../contracts/',
			`from "${join(import.meta.dir, "../contracts")}/`,
		)
		.replace(
			"export const SCHEMA_VERSION",
			"MIGRATIONS.pop();\nexport const SCHEMA_VERSION",
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

test("v8 event migration preserves evidence and adds nullable report metadata", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir, 7);
	const previous = await previousStore(dir);
	previous.openDatabase(path).close();
	db.run(`INSERT INTO attempt_events(harness,session_key,agent_key,event_id,revision,binding,kind,source,received_at,output_tokens)
 VALUES('claude-code','session','','event',0,'pending','usage','transcript',1000,20)`);
	const migrated = openDatabase(path);
	handles.push(migrated);
	expect(
		migrated
			.query(
				"SELECT event_id,output_tokens,rounds,note FROM latest_attempt_events",
			)
			.all(),
	).toEqual([
		{ event_id: "event", output_tokens: 20, rounds: null, note: null },
	]);
	expect(migrated.query("PRAGMA user_version").get()).toEqual({
		user_version: SCHEMA_VERSION,
	});
});

test("v9 failure rolls back report columns and keeps v8 evidence", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir, 7);
	const previous = await previousStore(dir);
	previous.openDatabase(path).close();
	db.run("CREATE INDEX events_attempt ON attempt_events(event_id)");
	const before = rows(db);
	expect(() => openDatabase(path)).toThrow();
	expect(rows(db)).toEqual(before);
	expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 8 });
	expect(
		db
			.query("PRAGMA table_info(attempt_events)")
			.all()
			.some((r) => (r as { name: string }).name === "rounds"),
	).toBe(false);
});
