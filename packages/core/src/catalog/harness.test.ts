import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchFn } from "../contracts/deps.ts";
import {
	BUNDLED_HARNESS_CATALOG,
	HARNESS_CATALOG_URL,
	type HarnessCatalog,
	loadHarnessCatalog,
	parseHarnessCatalog,
} from "./harness.ts";

const catalog: HarnessCatalog = {
	schema: 1,
	updated: "2026-10-05",
	harnesses: {
		"claude-code": {
			version: "2.1.0",
			models: [{ id: "claude-test", efforts: ["none", "low", "max"] }],
		},
		codex: {
			version: "0.100.0",
			models: [{ id: "gpt-test", efforts: ["high", "ultra"] }],
		},
	},
};
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
let dir: string;
let cachePath: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "spatz-harness-"));
	cachePath = join(dir, ".spatz", "harness-models.json");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});
const cache = (fetched_at: number, data: unknown = catalog) =>
	Bun.write(cachePath, JSON.stringify({ fetched_at, catalog: data }));
const load = (fetch: FetchFn, env = {}, timeoutMs = 20) =>
	loadHarnessCatalog({
		fetch,
		env,
		cachePath,
		clock: { now: () => NOW },
		ttlMs: DAY,
		timeoutMs,
	});

test("schema rejects breaking versions, missing harnesses and malformed known values", () => {
	expect(parseHarnessCatalog(catalog)).toEqual(catalog);
	expect(BUNDLED_HARNESS_CATALOG).not.toBeNull();
	const bad: unknown[] = [
		null,
		[],
		{},
		{ ...catalog, schema: 2 },
		{ ...catalog, updated: "2026-02-30" },
		{ ...catalog, updated: "yesterday" },
		{ ...catalog, harnesses: { codex: catalog.harnesses.codex } },
	];
	for (const entry of [
		{ version: "latest", models: catalog.harnesses.codex.models },
		{ version: "1.0.0", models: [] },
		{
			version: "1.0.0",
			models: Array.from({ length: 51 }, (_, i) => ({
				id: `gpt-${i}`,
				efforts: ["high"],
			})),
		},
		{
			...catalog.harnesses.codex,
			models: [
				catalog.harnesses.codex.models[0],
				catalog.harnesses.codex.models[0],
			],
		},
		...[
			{ id: "gpt-test:high", efforts: ["high"] },
			{ id: "gpt-test", efforts: [] },
			{ id: "gpt-test", efforts: ["high", "high"] },
			{ id: "gpt-test", efforts: ["turbo"] },
			{ id: "gpt-test", efforts: [1] },
			{ id: "g".repeat(65), efforts: ["high"] },
		].map((model) => ({ version: "1.0.0", models: [model] })),
	])
		bad.push({ ...catalog, harnesses: { ...catalog.harnesses, codex: entry } });
	for (const input of bad) expect(parseHarnessCatalog(input)).toBeNull();
});

test("fresh cache skips fetch; expired cache fetches and saves validated data", async () => {
	await cache(NOW - DAY + 1);
	let calls = 0;
	const fetched = { ...catalog, updated: "2026-10-06" };
	const fetch: FetchFn = async (url, init) => {
		calls++;
		expect(url).toBe(HARNESS_CATALOG_URL);
		expect(new Headers(init?.headers).has("Authorization")).toBe(false);
		return Response.json(fetched);
	};
	expect(await load(fetch)).toEqual(catalog);
	expect(calls).toBe(0);
	await cache(NOW - DAY);
	expect(await load(fetch)).toEqual(fetched);
	expect(calls).toBe(1);
	expect(await Bun.file(cachePath).json()).toEqual({
		fetched_at: NOW,
		catalog: fetched,
	});
});

test("network and schema failures use stale cache, then bundled data without overwriting", async () => {
	const failures: FetchFn[] = [
		async () => {
			throw new Error("offline");
		},
		async () => new Response("unavailable", { status: 503 }),
		async () => new Response("{bad json"),
		async () => Response.json({ ...catalog, schema: 2 }),
		async () => Response.json({ ...catalog, harnesses: {} }),
	];
	for (const fetch of failures) {
		await cache(NOW - 2 * DAY);
		expect(await load(fetch)).toEqual(catalog);
		expect((await Bun.file(cachePath).json()).fetched_at).toBe(NOW - 2 * DAY);
		await rm(cachePath);
		expect(await load(fetch)).toEqual(BUNDLED_HARNESS_CATALOG);
		expect(await Bun.file(cachePath).exists()).toBe(false);
	}
});

test("unknown schema and corrupt caches are ignored even when fresh", async () => {
	const fetch: FetchFn = async () => {
		throw new Error("offline");
	};
	await cache(NOW, { ...catalog, schema: 2 });
	expect(await load(fetch)).toEqual(BUNDLED_HARNESS_CATALOG);
	await Bun.write(cachePath, "broken");
	expect(await load(fetch)).toEqual(BUNDLED_HARNESS_CATALOG);
});

test("offline skips fetch with stale or missing cache", async () => {
	let calls = 0;
	const fetch: FetchFn = async () => {
		calls++;
		return Response.json(catalog);
	};
	expect(await load(fetch, { SPATZ_NO_NETWORK: "1" })).toEqual(
		BUNDLED_HARNESS_CATALOG,
	);
	await cache(NOW - 2 * DAY);
	expect(await load(fetch, { SPATZ_NO_NETWORK: "1" })).toEqual(catalog);
	expect(calls).toBe(0);
});

test("timeout bounds both fetch and response body, even when fetch ignores abort", async () => {
	for (const body of [false, true]) {
		let signal: AbortSignal | null | undefined;
		const fetch: FetchFn = async (_, init) => {
			signal = init?.signal;
			return body
				? new Response(new ReadableStream({ start() {} }))
				: new Promise<Response>(() => {});
		};
		const start = performance.now();
		expect(await load(fetch)).toEqual(BUNDLED_HARNESS_CATALOG);
		expect(performance.now() - start).toBeLessThan(1000);
		expect(signal?.aborted).toBe(true);
	}
});

test("cache write failure does not discard a valid download", async () => {
	cachePath = dir;
	expect(await load(async () => Response.json(catalog))).toEqual(catalog);
});

test("schema 1 accepts additive fields and ignores unknown harnesses", () => {
	const future = {
		...catalog,
		extra: true,
		harnesses: {
			...catalog.harnesses,
			future: { unrecognized: true },
			codex: {
				...catalog.harnesses.codex,
				extra: true,
				models: Array.from({ length: 50 }, (_, i) => ({
					id: `g${i}`.padEnd(64, "a"),
					efforts: ["max"],
					extra: true,
				})),
			},
		},
	};
	expect(parseHarnessCatalog(future)).not.toBeNull();
});

test("future cache timestamps are stale", async () => {
	await cache(NOW + DAY);
	let called = false;
	expect(
		await load(async () => {
			called = true;
			return Response.json(BUNDLED_HARNESS_CATALOG);
		}),
	).toEqual(BUNDLED_HARNESS_CATALOG);
	expect(called).toBe(true);
});

test("body cap stops oversized streams and preserves stale cache", async () => {
	await cache(NOW - DAY);
	let cancelled = false;
	const bytes = new TextEncoder().encode(
		`${JSON.stringify(catalog)}${" ".repeat(256 * 1024)}`,
	);
	expect(
		await load(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(bytes);
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		),
	).toEqual(catalog);
	expect(cancelled).toBe(true);
	expect((await Bun.file(cachePath).json()).fetched_at).toBe(NOW - DAY);
	const atLimit = `${JSON.stringify(catalog)}`.padEnd(256 * 1024, " ");
	expect(await load(async () => new Response(atLimit))).toEqual(catalog);
	expect((await Bun.file(cachePath).json()).fetched_at).toBe(NOW);
});

test("unknown efforts and unknown-only models are filtered without mutating input", async () => {
	const future = structuredClone(catalog);
	const models = [
		{ id: "gpt-test", efforts: ["high", "turbo"] },
		{ id: "gpt-future", efforts: ["turbo"] },
	];
	const input = {
		...future,
		harnesses: {
			...future.harnesses,
			codex: { ...future.harnesses.codex, models },
		},
	};
	const expected: HarnessCatalog = {
		...future,
		harnesses: {
			...future.harnesses,
			codex: {
				...future.harnesses.codex,
				models: [{ id: "gpt-test", efforts: ["high"] }],
			},
		},
	};
	expect(parseHarnessCatalog(input)).toEqual(expected);
	expect(models[0]?.efforts).toEqual(["high", "turbo"]);
	expect(models).toHaveLength(2);
	expect(await load(async () => Response.json(input))).toEqual(expected);
	expect((await Bun.file(cachePath).json()).catalog).toEqual(expected);
	models.push({ id: "bad:id", efforts: ["turbo"] });
	expect(parseHarnessCatalog(input)).toBeNull();
});
