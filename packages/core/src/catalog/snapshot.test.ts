import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchFn } from "../contracts/deps.ts";
import {
	BUNDLED_SNAPSHOT,
	fetchSnapshot,
	type LoadedSnapshot,
	loadSnapshot,
	parseSnapshot,
	priorCells,
	SNAPSHOT_URL,
} from "./snapshot.ts";

const MODEL = "anthropic/claude-sonnet-5.5";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-12T00:00:00.000Z");
const cell = (over: Record<string, unknown> = {}) => ({
	bench_versions: ["1"],
	difficulty: "medium",
	effort: "high",
	fail: 1,
	mean_duration_s: 10,
	mean_estimated_cost_usd: 0.1,
	model: MODEL,
	model_version: null,
	n: 4,
	partial: 0,
	pass: 3,
	runs: ["aaaaaaaaaaaa"],
	task_type: "review",
	...over,
});
const raw = (over: Record<string, unknown> = {}) => ({
	schema: "spatz-snapshot/1",
	generated_at: "2026-10-10T06:10:11.000Z",
	source: {
		commit: "3ce2237f116cff82f3ea13ff0a9f3e5e0fa46ce9",
		repository: "lorenzh/spatz-measurements",
	},
	content_sha256: "0".repeat(64),
	excluded_bench_versions: ["prototype"],
	runs: [],
	models: {},
	cells: [
		cell(),
		cell({
			task_type: "code.feature",
			difficulty: "hard",
			n: 3,
			pass: 3,
			fail: 0,
			runs: ["bbbbbbbbbbbb"],
		}),
		cell({ task_type: "other", n: 9, pass: 9, fail: 0 }),
		cell({ effort: "turbo" }),
	],
	...over,
});
const loaded = (value: unknown): LoadedSnapshot => ({
	...(parseSnapshot(value) as NonNullable<ReturnType<typeof parseSnapshot>>),
	source: "release",
	fetched_at: NOW,
});
const cells = (
	value: unknown,
	live: Record<string, string> = {},
	skip: string[] = [],
) => priorCells(loaded(value), live, new Set(skip), NOW);

test("cells become prior cells with pass as successes; unknown efforts and the type other are skipped", () => {
	expect(cells(raw())).toEqual([
		{
			task_type: "review",
			difficulty: "medium",
			model: MODEL,
			effort: "high",
			n_eff: 4,
			s_eff: 3,
			n_bench: 4,
			version_match: "unknown",
			source: "release snapshot 3ce2237 of 2026-10-10 (1 d old)",
		},
		expect.objectContaining({ task_type: "code.feature", n_eff: 3, s_eff: 3 }),
	]);
});

test("schema, counts, run ids and commit are validated", () => {
	expect(parseSnapshot(raw())).not.toBeNull();
	for (const bad of [
		raw({ schema: "spatz-bench-snapshot/1" }),
		raw({ generated_at: "yesterday" }),
		raw({ source: { commit: "main" } }),
		raw({ cells: {} }),
		raw({ cells: [cell({ pass: 5 })] }),
		raw({ cells: [cell({ n: 2.5 })] }),
		raw({ cells: [cell({ runs: ["../etc"] })] }),
		raw({ cells: [cell({ model_version: 1 })] }),
		raw({ cells: [cell({ model: "Opus" })] }),
		null,
		[],
	])
		expect(parseSnapshot(bad)).toBeNull();
});

test("null and known model_version follow the live-version rule (SPZ-106)", () => {
	const known = raw({ cells: [cell({ model_version: "2026-09-30" })] });
	expect(cells(known)[0]?.version_match).toBe("unknown");
	expect(cells(known, { [MODEL]: "2026-09-30" })[0]?.version_match).toBe(
		"exact",
	);
	expect(cells(known, { [MODEL]: "2026-11-01" })).toEqual([]);
	expect(cells(raw(), { [MODEL]: "2026-11-01" })[0]?.version_match).toBe(
		"unknown",
	);
});

test("cells whose runs are imported locally are skipped", () => {
	expect(cells(raw(), {}, ["aaaaaaaaaaaa"]).map((c) => c.task_type)).toEqual([
		"code.feature",
	]);
});

test("the bundled copy is a valid snapshot", () => {
	expect(BUNDLED_SNAPSHOT.source).toBe("bundled");
	expect(BUNDLED_SNAPSHOT.cells.length).toBeGreaterThan(0);
	expect(BUNDLED_SNAPSHOT.fetched_at).toBeNull();
});

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "spatz-snapshot-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** Serves the snapshot and its checksum line; `sum` overrides the checksum. */
function server(value: unknown, sum?: string) {
	const urls: string[] = [];
	const text = JSON.stringify(value);
	const fetch: FetchFn = async (url) => {
		urls.push(url);
		if (url === SNAPSHOT_URL) return new Response(text);
		if (url === `${SNAPSHOT_URL}.sha256`)
			return new Response(`${sum ?? sha(text)}  snapshot.json\n`);
		return new Response("", { status: 404 });
	};
	return { fetch, urls };
}
const load = (fetch: FetchFn, now = NOW, env: Record<string, string> = {}) =>
	loadSnapshot({
		fetch,
		env,
		cachePath: join(dir, "bench-snapshot.json"),
		clock: { now: () => now },
		ttlMs: DAY,
	});

test("a verified release is cached and not refetched within a day", async () => {
	const s = server(raw());
	const first = await load(s.fetch);
	expect(first).toMatchObject({ source: "release", fetched_at: NOW });
	expect(first.cells).toHaveLength(2);
	expect(s.urls).toEqual([SNAPSHOT_URL, `${SNAPSHOT_URL}.sha256`]);
	expect(await load(s.fetch, NOW + DAY - 1)).toEqual(first);
	expect(s.urls).toHaveLength(2);
	await load(s.fetch, NOW + DAY);
	expect(s.urls).toHaveLength(4);
});

test("a checksum mismatch or a bad schema keeps the last good cache, else the bundled copy", async () => {
	expect(await load(server(raw(), "f".repeat(64)).fetch)).toBe(
		BUNDLED_SNAPSHOT,
	);
	expect(await load(server(raw({ schema: "x" })).fetch)).toBe(BUNDLED_SNAPSHOT);
	const good = await load(server(raw()).fetch);
	const later = NOW + 2 * DAY;
	expect(await load(server(raw(), "f".repeat(64)).fetch, later)).toEqual(good);
	const offline: FetchFn = async () => {
		throw new Error("offline");
	};
	expect(await load(offline, later)).toEqual(good);
	expect(
		await load(async () => new Response("", { status: 503 }), later),
	).toEqual(good);
});

test("SPATZ_NO_NETWORK reads the cache or the bundled copy and never fetches", async () => {
	const s = server(raw());
	expect(await load(s.fetch, NOW, { SPATZ_NO_NETWORK: "1" })).toBe(
		BUNDLED_SNAPSHOT,
	);
	expect(s.urls).toEqual([]);
	const good = await load(s.fetch);
	expect(await load(s.fetch, NOW + 9 * DAY, { SPATZ_NO_NETWORK: "1" })).toEqual(
		good,
	);
	expect(s.urls).toHaveLength(2);
});

test("fetchSnapshot throws on a mismatch so the refresh script never writes a bad copy", async () => {
	await expect(
		fetchSnapshot(server(raw(), "f".repeat(64)).fetch),
	).rejects.toThrow(/checksum/);
	await expect(fetchSnapshot(server(raw({ cells: 1 })).fetch)).rejects.toThrow(
		/spatz-snapshot\/1/,
	);
	const ok = await fetchSnapshot(server(raw()).fetch);
	expect(ok.text).toBe(JSON.stringify(raw()));
	expect(ok.snapshot.commit).toBe("3ce2237f116cff82f3ea13ff0a9f3e5e0fa46ce9");
});
