// catalog/snapshot: the bench snapshot (spatz-snapshot/1) as a capped prior.
// One GitHub release asset of spatz-measurements, verified by its .sha256, cached for a day.
// Without a good download: the last good cache, else the copy bundled at release time.
import { createHash } from "node:crypto";
import bundled from "../../../../catalog/bench-snapshot.json";
import type { FetchFn } from "../contracts/deps.ts";
import {
	DEFAULT_TUNING,
	DIFFICULTIES,
	EFFORTS,
	TASK_TYPES,
} from "../contracts/types.ts";
import type { LoadModelsOptions } from "./openrouter.ts";

export const SNAPSHOT_URL =
	"https://github.com/lorenzh/spatz-measurements/releases/latest/download/snapshot.json";
const MAX_BYTES = 4 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SnapshotCell {
	model: string;
	model_version: string | null;
	effort: string;
	task_type: string;
	difficulty: string;
	n: number;
	pass: number;
	/** Run ids (12 hex digits) of the measurement runs behind the cell. */
	runs: string[];
}
export interface Snapshot {
	/** Source commit in spatz-measurements. */
	commit: string;
	generated_at: string;
	cells: SnapshotCell[];
}
export interface LoadedSnapshot extends Snapshot {
	source: "release" | "bundled";
	/** When the release was downloaded; null for the bundled copy. */
	fetched_at: number | null;
}

/** Bench evidence for one (model, effort, type, difficulty), already weighted. */
export interface PriorCell {
	task_type: string;
	difficulty: string;
	model: string;
	effort: string;
	/** Weighted counts n_eff and s_eff. */
	n_eff: number;
	s_eff: number;
	/** Raw bench runs. */
	n_bench: number;
	version_match: "exact" | "unknown";
	/** Where the evidence comes from, for the reason. */
	source: string;
}

const object = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= 0;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const RUN_ID = /^[0-9a-f]{12}$/;

function parseCell(v: unknown): SnapshotCell | null {
	if (
		!object(v) ||
		typeof v.model !== "string" ||
		!MODEL_ID.test(v.model) ||
		!(v.model_version === null || typeof v.model_version === "string") ||
		typeof v.effort !== "string" ||
		typeof v.task_type !== "string" ||
		typeof v.difficulty !== "string" ||
		!count(v.n) ||
		!count(v.pass) ||
		!count(v.partial) ||
		!count(v.fail) ||
		v.pass + v.partial + v.fail !== v.n ||
		!Array.isArray(v.runs) ||
		!v.runs.every((r) => typeof r === "string" && RUN_ID.test(r))
	)
		return null;
	return {
		model: v.model,
		model_version: v.model_version,
		effort: v.effort,
		task_type: v.task_type,
		difficulty: v.difficulty,
		n: v.n,
		pass: v.pass,
		runs: v.runs,
	};
}

/** null for anything that is not a valid spatz-snapshot/1; cells with unknown efforts, task types or difficulties are skipped, `other` never counts. */
export function parseSnapshot(value: unknown): Snapshot | null {
	if (
		!object(value) ||
		value.schema !== "spatz-snapshot/1" ||
		typeof value.generated_at !== "string" ||
		!Number.isFinite(Date.parse(value.generated_at)) ||
		!object(value.source) ||
		typeof value.source.commit !== "string" ||
		!/^[0-9a-f]{40}$/.test(value.source.commit) ||
		!Array.isArray(value.cells)
	)
		return null;
	const cells: SnapshotCell[] = [];
	for (const raw of value.cells) {
		const cell = parseCell(raw);
		if (!cell) return null;
		if (
			(EFFORTS as readonly string[]).includes(cell.effort) &&
			(TASK_TYPES as readonly string[]).includes(cell.task_type) &&
			cell.task_type !== "other" &&
			(DIFFICULTIES as readonly string[]).includes(cell.difficulty)
		)
			cells.push(cell);
	}
	return {
		commit: value.source.commit,
		generated_at: value.generated_at,
		cells,
	};
}

/** Whole days since the snapshot was generated. */
export const snapshotAgeDays = (s: Snapshot, now: number) =>
	Math.max(0, Math.floor((now - Date.parse(s.generated_at)) / DAY_MS));

/** Prior cells of a snapshot. A known live version that differs from the cell's seeds nothing; null on either side matches. Cells that count a run in skipRuns are left out (those rows come from the local bench import). */
export function priorCells(
	snapshot: LoadedSnapshot,
	liveVersions: Record<string, string>,
	skipRuns: ReadonlySet<string>,
	now: number,
): PriorCell[] {
	const source = `${snapshot.source} snapshot ${snapshot.commit.slice(0, 7)} of ${snapshot.generated_at.slice(0, 10)} (${snapshotAgeDays(snapshot, now)} d old)`;
	return snapshot.cells.flatMap((c): PriorCell[] => {
		const live = liveVersions[c.model] ?? null;
		if (c.model_version !== null && live !== null && c.model_version !== live)
			return [];
		// ponytail: a partly imported cell drops its other runs too; per-run counts in the snapshot would keep them.
		if (c.n === 0 || c.runs.some((r) => skipRuns.has(r))) return [];
		// ponytail: every snapshot row weighs 1; rubric rows need per-check counts in the snapshot to weigh 0.5.
		return [
			{
				task_type: c.task_type,
				difficulty: c.difficulty,
				model: c.model,
				effort: c.effort,
				n_eff: c.n,
				s_eff: c.pass,
				n_bench: c.n,
				version_match:
					c.model_version !== null && live !== null ? "exact" : "unknown",
				source,
			},
		];
	});
}

const checkedBundle = parseSnapshot(bundled);
if (!checkedBundle) throw new Error("Invalid bundled bench snapshot");
export const BUNDLED_SNAPSHOT: LoadedSnapshot = {
	...checkedBundle,
	source: "bundled",
	fetched_at: null,
};

/** The latest release snapshot, verified against its .sha256. Throws on any failure. */
export async function fetchSnapshot(
	fetch: FetchFn,
	signal?: AbortSignal,
): Promise<{ text: string; snapshot: Snapshot }> {
	const get = async (url: string) => {
		const response = await fetch(url, { signal });
		if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_BYTES) throw new Error(`${url}: too large`);
		return bytes;
	};
	const [bytes, sum] = await Promise.all([
		get(SNAPSHOT_URL),
		get(`${SNAPSHOT_URL}.sha256`),
	]);
	const expected = new TextDecoder().decode(sum).trim().split(/\s+/)[0];
	if (createHash("sha256").update(bytes).digest("hex") !== expected)
		throw new Error("bench snapshot: checksum mismatch");
	const text = new TextDecoder().decode(bytes);
	const snapshot = parseSnapshot(JSON.parse(text));
	if (!snapshot)
		throw new Error("bench snapshot: not a valid spatz-snapshot/1");
	return { text, snapshot };
}

interface CacheFile {
	fetched_at: number;
	snapshot: unknown;
}

/** Fresh cache -> no fetch; SPATZ_NO_NETWORK=1 -> cache only; failed download, checksum or schema -> the last good cache, else the bundled copy. */
export async function loadSnapshot(
	options: LoadModelsOptions,
): Promise<LoadedSnapshot> {
	const { fetch, env, cachePath, clock, ttlMs } = options;
	let cache: LoadedSnapshot | null = null;
	try {
		const raw = await Bun.file(cachePath).json();
		const parsed = object(raw) ? parseSnapshot(raw.snapshot) : null;
		if (parsed && Number.isFinite(raw.fetched_at))
			cache = { ...parsed, source: "release", fetched_at: raw.fetched_at };
	} catch {
		// Missing or corrupt cache.
	}
	const fallback = cache ?? BUNDLED_SNAPSHOT;
	const now = clock.now();
	const fetchedAt = cache?.fetched_at ?? 0;
	if (
		env.SPATZ_NO_NETWORK === "1" ||
		(cache && fetchedAt <= now && now - fetchedAt < ttlMs)
	)
		return fallback;

	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			abort.abort();
			reject(new Error("Snapshot timeout"));
		}, options.timeoutMs ?? DEFAULT_TUNING.openRouterTimeoutMs);
	});
	let fetched: Awaited<ReturnType<typeof fetchSnapshot>>;
	try {
		fetched = await Promise.race([fetchSnapshot(fetch, abort.signal), timeout]);
	} catch {
		return fallback;
	} finally {
		clearTimeout(timer);
	}
	try {
		await Bun.write(
			cachePath,
			JSON.stringify({
				fetched_at: now,
				snapshot: JSON.parse(fetched.text),
			} satisfies CacheFile),
		);
	} catch {
		// A failed cache write only costs a refetch.
	}
	return { ...fetched.snapshot, source: "release", fetched_at: now };
}
