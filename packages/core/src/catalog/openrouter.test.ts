import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchFn } from "../contracts/deps.ts";
import type { OpenRouterModel } from "../contracts/types.ts";
import fixture from "./fixtures/openrouter-models.json";
import {
	loadOpenRouterModels,
	OPENROUTER_MODELS_URL,
	parseOpenRouterModels,
} from "./openrouter.ts";

describe("parseOpenRouterModels", () => {
	test("parses prices, context_length and supported_efforts", () => {
		const parsed = parseOpenRouterModels(fixture);
		expect(parsed).toHaveLength(6);
		expect(parsed.find((m) => m.id === "anthropic/claude-opus-5.5")).toEqual({
			id: "anthropic/claude-opus-5.5",
			name: "Anthropic: Claude Opus 5.5",
			price_prompt: 0.000004,
			price_completion: 0.00002,
			price_cache_read: 0.0000002,
			price_cache_write: 0.000005,
			context_length: 1000000,
			supported_efforts: ["max", "xhigh", "high", "medium", "low"],
		});
	});

	test("price strings become numbers; missing reasoning gives null efforts", () => {
		const parsed = parseOpenRouterModels({
			data: [
				{
					id: "x/a",
					name: "A",
					pricing: { prompt: "0.000001", completion: "0.00002" },
					context_length: 4096,
				},
				{
					id: "x/b",
					name: "B",
					pricing: { prompt: "0", completion: "0" },
					reasoning: { supported_efforts: null },
				},
			],
		});
		expect(parsed).toEqual([
			{
				id: "x/a",
				name: "A",
				price_prompt: 0.000001,
				price_completion: 0.00002,
				price_cache_read: null,
				price_cache_write: null,
				context_length: 4096,
				supported_efforts: null,
			},
			{
				id: "x/b",
				name: "B",
				price_prompt: 0,
				price_completion: 0,
				price_cache_read: null,
				price_cache_write: null,
				context_length: null,
				supported_efforts: null,
			},
		]);
	});

	test("skips entries without valid prices (e.g. variable routers at -1)", () => {
		const parsed = parseOpenRouterModels({
			data: [
				{ id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
				{ id: "x/nopricing" },
				{ id: "x/nullprice", pricing: { prompt: null, completion: "0" } },
				{ pricing: { prompt: "1", completion: "1" } },
			],
		});
		expect(parsed).toEqual([]);
	});

	test("rejects non-decimal and non-finite price strings in both fields", () => {
		const bad = ["0x10", "Infinity", "1e309", "abc", " ", "1,5", "+-1"];
		const data = bad.flatMap((p, i) => [
			{ id: `x/p${i}`, pricing: { prompt: p, completion: "0.1" } },
			{ id: `x/c${i}`, pricing: { prompt: "0.1", completion: p } },
		]);
		expect(parseOpenRouterModels({ data })).toEqual([]);
		// Plain decimals, including exponent form, stay valid.
		expect(
			parseOpenRouterModels({
				data: [{ id: "x/ok", pricing: { prompt: "1e-7", completion: "0.5" } }],
			}).map((m) => [m.price_prompt, m.price_completion]),
		).toEqual([[1e-7, 0.5]]);
	});

	test("cache prices preserve zero and represent missing or invalid prices as null", () => {
		const data = ["0", "1e-7", undefined, null, "-1", "0x10", "1e309", 0].map(
			(p, i) => ({
				id: `x/${i}`,
				pricing: {
					prompt: "1",
					completion: "2",
					input_cache_read: p,
					input_cache_write: p,
				},
			}),
		);
		expect(
			parseOpenRouterModels({ data }).map((m) => [
				m.price_cache_read,
				m.price_cache_write,
			]),
		).toEqual([
			[0, 0],
			[1e-7, 1e-7],
			...Array.from({ length: 6 }, () => [null, null]),
		]);
	});

	test("non-object input gives []", () => {
		expect(parseOpenRouterModels(null)).toEqual([]);
		expect(parseOpenRouterModels({ data: "x" })).toEqual([]);
	});
});

describe("loadOpenRouterModels", () => {
	const DAY = 86400000;
	const NOW = 1_800_000_000_000;
	const clock = { now: () => NOW };
	const cached: OpenRouterModel[] = [
		{
			id: "x/cached",
			name: "Cached",
			price_prompt: 1,
			price_completion: 2,
			price_cache_read: null,
			price_cache_write: null,
			context_length: null,
			supported_efforts: null,
		},
	];
	let dir = "";

	async function setup(cacheFetchedAt?: number) {
		dir = await mkdtemp(join(tmpdir(), "spatz-catalog-"));
		const cachePath = join(dir, "nested", "openrouter-models.json");
		if (cacheFetchedAt !== undefined) {
			await Bun.write(
				cachePath,
				JSON.stringify({ fetched_at: cacheFetchedAt, models: cached }),
			);
		}
		return cachePath;
	}

	function fakeFetch(response: () => Promise<Response>) {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fn: FetchFn = (url, init) => {
			calls.push({ url, init });
			return response();
		};
		return { fn, calls };
	}

	const ok = () => Promise.resolve(Response.json(fixture));

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("fresh cache (younger than 24 h) is returned without fetching", async () => {
		const cachePath = await setup(NOW - DAY + 1);
		const f = fakeFetch(ok);
		const result = await loadOpenRouterModels({
			fetch: f.fn,
			env: {},
			cachePath,
			clock,
			ttlMs: DAY,
		});
		expect(result).toEqual(cached);
		expect(f.calls).toHaveLength(0);
	});

	test.each([
		["price_cache_read"],
		["price_cache_write"],
		["price_cache_read", "price_cache_write"],
	])(
		"fresh legacy cache missing %j is refetched online",
		async (...missing) => {
			const cachePath = await setup();
			const legacy = Object.fromEntries(
				Object.entries(cached[0] as OpenRouterModel).filter(
					([key]) => !missing.includes(key),
				),
			);
			await Bun.write(
				cachePath,
				JSON.stringify({ fetched_at: NOW, models: [...cached, legacy] }),
			);
			const f = fakeFetch(ok);
			const result = await loadOpenRouterModels({
				fetch: f.fn,
				env: {},
				cachePath,
				clock,
				ttlMs: DAY,
			});
			expect(f.calls).toHaveLength(1);
			expect(result).toEqual(parseOpenRouterModels(fixture));
			expect(await Bun.file(cachePath).json()).toEqual({
				fetched_at: NOW,
				models: result,
			});
		},
	);

	test.each(["1", "0"])(
		"legacy cache remains readable with null prices when offline (SPATZ_NO_NETWORK=%s)",
		async (offline) => {
			const cachePath = await setup();
			const {
				price_cache_read: _read,
				price_cache_write: _write,
				...old
			} = cached[0] as OpenRouterModel;
			await Bun.write(
				cachePath,
				JSON.stringify({ fetched_at: NOW, models: [old] }),
			);
			const f = fakeFetch(() => Promise.reject(new Error("offline")));
			expect(
				await loadOpenRouterModels({
					fetch: f.fn,
					env: { SPATZ_NO_NETWORK: offline },
					cachePath,
					clock,
					ttlMs: DAY,
				}),
			).toEqual(cached);
			expect(f.calls).toHaveLength(offline === "1" ? 0 : 1);
		},
	);

	test("stale cache -> fetch with Bearer key when set, then write cache", async () => {
		const cachePath = await setup(NOW - DAY);
		const f = fakeFetch(ok);
		const result = await loadOpenRouterModels({
			fetch: f.fn,
			env: { OPENROUTER_API_KEY: "test-key" },
			cachePath,
			clock,
			ttlMs: DAY,
		});
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]?.url).toBe(OPENROUTER_MODELS_URL);
		expect(f.calls[0]?.init?.method ?? "GET").toBe("GET");
		expect(OPENROUTER_MODELS_URL).toBe("https://openrouter.ai/api/v1/models");
		expect(new Headers(f.calls[0]?.init?.headers).get("Authorization")).toBe(
			"Bearer test-key",
		);
		expect(result).toEqual(parseOpenRouterModels(fixture));
		expect(await Bun.file(cachePath).json()).toEqual({
			fetched_at: NOW,
			models: result,
		});
	});

	test("missing cache -> fetch without Authorization header when no key", async () => {
		const cachePath = await setup();
		const f = fakeFetch(ok);
		const result = await loadOpenRouterModels({
			fetch: f.fn,
			env: {},
			cachePath,
			clock,
			ttlMs: DAY,
		});
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]?.init?.method ?? "GET").toBe("GET");
		expect(new Headers(f.calls[0]?.init?.headers).has("Authorization")).toBe(
			false,
		);
		expect(result).toHaveLength(6);
		expect((await Bun.file(cachePath).json()).fetched_at).toBe(NOW);
	});

	test("fetch rejection -> old cache content", async () => {
		const cachePath = await setup(NOW - 2 * DAY);
		const f = fakeFetch(() => Promise.reject(new Error("offline")));
		const result = await loadOpenRouterModels({
			fetch: f.fn,
			env: {},
			cachePath,
			clock,
			ttlMs: DAY,
		});
		expect(result).toEqual(cached);
	});

	test("non-2xx -> old cache content, cache untouched", async () => {
		const cachePath = await setup(NOW - 2 * DAY);
		const f = fakeFetch(() =>
			Promise.resolve(new Response("busy", { status: 503 })),
		);
		const result = await loadOpenRouterModels({
			fetch: f.fn,
			env: {},
			cachePath,
			clock,
			ttlMs: DAY,
		});
		expect(result).toEqual(cached);
		expect((await Bun.file(cachePath).json()).fetched_at).toBe(NOW - 2 * DAY);
	});

	test("never-settling fetch or body -> abort after timeoutMs, old cache content", async () => {
		const cachePath = await setup(NOW - 2 * DAY);
		const hang = fakeFetch(() => new Promise<Response>(() => {}));
		const stall = fakeFetch(() =>
			Promise.resolve(new Response(new ReadableStream({ start() {} }))),
		);
		for (const f of [hang, stall]) {
			const started = performance.now();
			const result = await loadOpenRouterModels({
				fetch: f.fn,
				env: {},
				cachePath,
				clock,
				ttlMs: DAY,
				timeoutMs: 20,
			});
			expect(result).toEqual(cached);
			expect(performance.now() - started).toBeLessThan(1000);
			expect(f.calls[0]?.init?.signal?.aborted).toBe(true);
		}
		expect((await Bun.file(cachePath).json()).fetched_at).toBe(NOW - 2 * DAY);
	});

	test("timeout without any cache -> []", async () => {
		const cachePath = await setup();
		const f = fakeFetch(() => new Promise<Response>(() => {}));
		expect(
			await loadOpenRouterModels({
				fetch: f.fn,
				env: {},
				cachePath,
				clock,
				ttlMs: DAY,
				timeoutMs: 20,
			}),
		).toEqual([]);
	});

	test("fetch failure without any cache -> []", async () => {
		const cachePath = await setup();
		const f = fakeFetch(() => Promise.reject(new Error("offline")));
		expect(
			await loadOpenRouterModels({
				fetch: f.fn,
				env: {},
				cachePath,
				clock,
				ttlMs: DAY,
			}),
		).toEqual([]);
	});

	test("corrupt cache counts as missing", async () => {
		const cachePath = await setup();
		await Bun.write(cachePath, "{not json");
		const f = fakeFetch(() => Promise.reject(new Error("offline")));
		expect(
			await loadOpenRouterModels({
				fetch: f.fn,
				env: {},
				cachePath,
				clock,
				ttlMs: DAY,
			}),
		).toEqual([]);
	});

	test("fresh cache with malformed model entries counts as missing", async () => {
		const bad: unknown[] = [
			null,
			{ ...cached[0], price_completion: "2" },
			{ ...cached[0], price_cache_read: "2" },
			{ ...cached[0], price_cache_write: -1 },
			{ ...cached[0], id: 1 },
			{ ...cached[0], context_length: undefined },
			{ ...cached[0], supported_efforts: [1] },
		];
		for (const entry of bad) {
			const cachePath = await setup();
			await Bun.write(
				cachePath,
				JSON.stringify({ fetched_at: NOW, models: [entry] }),
			);
			const f = fakeFetch(ok);
			const result = await loadOpenRouterModels({
				fetch: f.fn,
				env: {},
				cachePath,
				clock,
				ttlMs: DAY,
			});
			expect(f.calls).toHaveLength(1);
			expect(result).toEqual(parseOpenRouterModels(fixture));
			await rm(dir, { recursive: true, force: true });
		}
	});
});
