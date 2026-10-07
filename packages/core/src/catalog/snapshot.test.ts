import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchFn } from "../contracts/deps.ts";
import {
	loadSnapshot,
	parseSnapshot,
	priorCells,
	SNAPSHOT_BASE_URL,
} from "./snapshot.ts";

const MODEL = "anthropic/claude-sonnet-5.5";
const raw = (over: Record<string, unknown> = {}) => ({
	schema: "spatz-bench-snapshot/1",
	model: MODEL,
	model_version: "2026-09-30",
	judges: { "j:1": { validated: true }, "j:2": { validated: false } },
	efforts: {
		high: {
			review: {
				medium: {
					n: 4,
					successes: 3,
					by_check: {
						golden: { n: 2, successes: 2 },
						rubric: { n: 2, successes: 1, judge: "j:1" },
					},
				},
			},
			"code.feature": { hard: { n: 3, successes: 3 } },
			other: { easy: { n: 9, successes: 9 } },
		},
	},
	...over,
});
const review = (snapshot: unknown, live: string | null = null) =>
	priorCells(parseSnapshot(snapshot) as never, live).find(
		(p) => p.task_type === "review",
	);

test("a mixed golden+rubric cell counts rubric fully only with a validated judge", () => {
	expect(review(raw())).toMatchObject({ n_eff: 4, s_eff: 3, n_bench: 4 });
	const unvalidated = raw();
	(
		unvalidated.efforts.high.review.medium.by_check.rubric as { judge: string }
	).judge = "j:2";
	expect(review(unvalidated)).toMatchObject({ n_eff: 3, s_eff: 2.5 });
	// Unknown judge counts as unvalidated; absent by_check counts fully.
	const unknown = raw({ judges: undefined });
	expect(review(unknown)).toMatchObject({ n_eff: 3, s_eff: 2.5 });
	const flat = raw();
	(flat.efforts.high.review.medium as Record<string, unknown>).by_check =
		undefined;
	expect(review(flat)).toMatchObject({ n_eff: 4, s_eff: 3 });
});

test("the type other is never counted", () => {
	expect(
		priorCells(parseSnapshot(raw()) as never, null).some(
			(p) => p.task_type === "other",
		),
	).toBe(false);
});

test("version rule: equal is exact, null on either side is unknown, a known difference seeds nothing", () => {
	expect(review(raw(), "2026-09-30")?.version_match).toBe("exact");
	expect(review(raw(), null)?.version_match).toBe("unknown");
	expect(
		review(raw({ model_version: null }), "2026-09-30")?.version_match,
	).toBe("unknown");
	expect(review(raw(), "2026-10-30")).toBeUndefined();
});

test("parser rejects wrong schema and impossible counts", () => {
	expect(parseSnapshot(raw({ schema: "x" }))).toBeNull();
	const bad = raw();
	bad.efforts.high["code.feature"].hard.successes = 4;
	expect(parseSnapshot(bad)).toBeNull();
});

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "spatz-snap-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const load = (fetch: FetchFn, env = {}) =>
	loadSnapshot(MODEL, {
		fetch,
		env,
		cacheDir: dir,
		clock: { now: () => NOW },
		ttlMs: DAY,
		timeoutMs: 20,
	});
const cachePath = () => join(dir, "anthropic", "claude-sonnet-5.5.json");
const cache = (fetched_at: number, snapshot: unknown = raw()) =>
	Bun.write(cachePath(), JSON.stringify({ fetched_at, snapshot }));

test("fetches the model file from main and caches it", async () => {
	let url = "";
	const snap = await load(async (u) => {
		url = u;
		return Response.json(raw());
	});
	expect(url).toBe(`${SNAPSHOT_BASE_URL}/anthropic/claude-sonnet-5.5.json`);
	expect(snap?.model).toBe(MODEL);
	expect((await Bun.file(cachePath()).json()).fetched_at).toBe(NOW);
});

test("404 means no prior and is cached, a fresh cache skips the fetch", async () => {
	let calls = 0;
	const fetch: FetchFn = async () => {
		calls++;
		return new Response("", { status: 404 });
	};
	expect(await load(fetch)).toBeNull();
	expect(await load(fetch)).toBeNull();
	expect(calls).toBe(1);
});

test("stale cache is refreshed, and used when the refresh fails", async () => {
	await cache(NOW - 2 * DAY, raw({ model_version: "old" }));
	const fresh = await load(async () => Response.json(raw()));
	expect(fresh?.model_version).toBe("2026-09-30");
	await cache(NOW - 2 * DAY, raw({ model_version: "old" }));
	for (const fetch of [
		async () => {
			throw new Error("offline");
		},
		async () => new Response("", { status: 500 }),
		async () => new Response("{bad"),
		async () => new Promise<Response>(() => {}),
	] as FetchFn[])
		expect((await load(fetch))?.model_version).toBe("old");
});

test("SPATZ_NO_NETWORK reads the cache only, even when stale", async () => {
	let calls = 0;
	const fetch: FetchFn = async () => {
		calls++;
		return Response.json(raw());
	};
	expect(await load(fetch, { SPATZ_NO_NETWORK: "1" })).toBeNull();
	await cache(NOW - 2 * DAY);
	expect((await load(fetch, { SPATZ_NO_NETWORK: "1" }))?.model).toBe(MODEL);
	expect(calls).toBe(0);
});

test("a file for another model, and unsafe ids, are refused", async () => {
	expect(
		await load(async () => Response.json(raw({ model: "openai/other" }))),
	).toBeNull();
	let calls = 0;
	const fetch: FetchFn = async () => {
		calls++;
		return Response.json(raw());
	};
	for (const id of ["../x/y", "a/b/c", "noprovider", "a/.."])
		expect(
			await loadSnapshot(id, {
				fetch,
				env: {},
				cacheDir: dir,
				clock: { now: () => NOW },
				ttlMs: DAY,
			}),
		).toBeNull();
	expect(calls).toBe(0);
});
