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

async function fixture(dir: string, version = 5) {
	const path = join(dir, "spatz.db");
	const db = new Database(path);
	handles.push(db);
	db.run("PRAGMA journal_mode = WAL");
	db.run(
		await Bun.file(join(import.meta.dir, `fixtures/v${version}.sql`)).text(),
	);
	return { path, db };
}

// Exercise a future migration without changing the production schema or public API.
async function futureStore(dir: string) {
	const source = (await Bun.file(join(import.meta.dir, "index.ts")).text())
		.replaceAll(
			'from "../contracts/',
			`from "${join(import.meta.dir, "../contracts")}/`,
		)
		.replace(
			"export const SCHEMA_VERSION",
			'MIGRATIONS.push(["CREATE TABLE migration_probe (value TEXT)"]);\nexport const SCHEMA_VERSION',
		);
	const path = join(dir, "future-store.ts");
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

test("v5 WAL data is backed up before a future migration and restores with the old CLI", async () => {
	const dir = directory();
	const { path, db } = await fixture(dir);
	const before = rows(db);
	const future = await futureStore(dir);
	const migrated = future.openDatabase(path);
	handles.push(migrated);
	expect(migrated.query("PRAGMA user_version").get()).toEqual({
		user_version: 6,
	});
	expect(rows(migrated)).toEqual(before);
	const backup = `${path}.bak-v5`;
	expect(existsSync(backup)).toBe(true);
	const restoredPath = join(dir, "restored.db");
	copyFileSync(backup, restoredPath);
	const restored = openDatabase(restoredPath);
	handles.push(restored);
	expect(restored.query("PRAGMA user_version").get()).toEqual({
		user_version: 5,
	});
	expect(restored.query("PRAGMA integrity_check").get()).toEqual({
		integrity_check: "ok",
	});
	expect(rows(restored)).toEqual(before);
	expect(
		restored
			.query("SELECT name FROM sqlite_master WHERE name = 'migration_probe'")
			.get(),
	).toBeNull();
	expect(() => openDatabase(path)).toThrow(/schema.*6.*upgrade.*CLI/i);
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
