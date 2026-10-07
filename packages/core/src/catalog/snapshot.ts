// catalog/snapshot: bench snapshot files (spatz-bench-snapshot/1) as a weak prior. Fetch, cache, parse, effective counts.
// Spec: issue "Use the bench snapshot as a prior" (Snapshot format, Fetch and delivery).
import { join } from "node:path";
import { DEFAULT_TUNING, TASK_TYPES } from "../contracts/types.ts";
import type { LoadModelsOptions } from "./openrouter.ts";

export const SNAPSHOT_BASE_URL =
	"https://raw.githubusercontent.com/lorenzh/spatz/main/catalog";
const MAX_BYTES = 256 * 1024;

interface CheckCounts {
	n: number;
	successes: number;
	judge?: string;
}
interface Cell {
	n: number;
	successes: number;
	by_check?: Record<string, CheckCounts>;
}
export interface Snapshot {
	model: string;
	model_version: string | null;
	judges: Record<string, { validated: boolean }>;
	/** effort -> task type -> difficulty -> cell. */
	efforts: Record<string, Record<string, Record<string, Cell>>>;
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
}

const object = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= 0;
const safeId = (s: string) => /^[a-z0-9][a-z0-9._-]*$/.test(s);

function parseCell(v: unknown): Cell | null {
	if (!object(v) || !count(v.n) || !count(v.successes) || v.successes > v.n)
		return null;
	const cell: Cell = { n: v.n, successes: v.successes };
	if (v.by_check !== undefined) {
		if (!object(v.by_check)) return null;
		cell.by_check = {};
		for (const [kind, c] of Object.entries(v.by_check)) {
			if (!object(c) || !count(c.n) || !count(c.successes) || c.successes > c.n)
				return null;
			cell.by_check[kind] = {
				n: c.n,
				successes: c.successes,
				...(typeof c.judge === "string" && { judge: c.judge }),
			};
		}
	}
	return cell;
}

/** null for anything that is not a valid spatz-bench-snapshot/1; unknown task types and efforts are skipped, `other` never counts. */
export function parseSnapshot(value: unknown): Snapshot | null {
	if (
		!object(value) ||
		value.schema !== "spatz-bench-snapshot/1" ||
		typeof value.model !== "string" ||
		!(
			value.model_version === null || typeof value.model_version === "string"
		) ||
		!object(value.efforts)
	)
		return null;
	const judges: Snapshot["judges"] = {};
	if (value.judges !== undefined) {
		if (!object(value.judges)) return null;
		for (const [id, j] of Object.entries(value.judges))
			if (object(j)) judges[id] = { validated: j.validated === true };
	}
	const efforts: Snapshot["efforts"] = {};
	for (const [effort, types] of Object.entries(value.efforts)) {
		if (!object(types)) return null;
		for (const [type, difficulties] of Object.entries(types)) {
			if (!object(difficulties)) return null;
			if (!(TASK_TYPES as readonly string[]).includes(type) || type === "other")
				continue;
			for (const [difficulty, raw] of Object.entries(difficulties)) {
				const cell = parseCell(raw);
				if (!cell) return null;
				efforts[effort] ??= {};
				const byType = efforts[effort];
				byType[type] ??= {};
				byType[type][difficulty] = cell;
			}
		}
	}
	return {
		model: value.model,
		model_version: value.model_version,
		judges,
		efforts,
	};
}

/** Weighted counts of one cell: f = 1 for tests, golden, human; rubric 1 only with a validated judge, else 0.5. */
function effective(cell: Cell, judges: Snapshot["judges"]) {
	let n = 0;
	let s = 0;
	for (const [kind, c] of Object.entries(
		cell.by_check ?? { tests: { n: cell.n, successes: cell.successes } },
	)) {
		const f = kind === "rubric" && !judges[c.judge ?? ""]?.validated ? 0.5 : 1;
		n += f * c.n;
		s += f * c.successes;
	}
	return { n, s };
}

/** Prior cells of a snapshot. A known live version that differs from the snapshot's seeds nothing; null on either side matches. */
export function priorCells(
	snapshot: Snapshot,
	liveVersion: string | null,
): PriorCell[] {
	if (
		snapshot.model_version !== null &&
		liveVersion !== null &&
		snapshot.model_version !== liveVersion
	)
		return [];
	const version_match =
		snapshot.model_version !== null && liveVersion !== null
			? "exact"
			: "unknown";
	const out: PriorCell[] = [];
	for (const [effort, types] of Object.entries(snapshot.efforts))
		for (const [task_type, difficulties] of Object.entries(types))
			for (const [difficulty, cell] of Object.entries(difficulties)) {
				const { n, s } = effective(cell, snapshot.judges);
				if (n > 0)
					out.push({
						task_type,
						difficulty,
						model: snapshot.model,
						effort,
						n_eff: n,
						s_eff: s,
						n_bench: cell.n,
						version_match,
					});
			}
	return out;
}

interface CacheFile {
	fetched_at: number;
	/** null caches a 404. */
	snapshot: unknown;
}

/** Snapshot for a canonical model id ("provider/model"), or null. Fresh cache -> no fetch; 404 -> null; failed refresh -> stale cache; SPATZ_NO_NETWORK=1 -> cache only. */
export async function loadSnapshot(
	model: string,
	options: Omit<LoadModelsOptions, "cachePath"> & { cacheDir: string },
): Promise<Snapshot | null> {
	const [provider, name, ...rest] = model.split("/");
	if (!provider || !name || rest.length || !safeId(provider) || !safeId(name))
		return null;
	const { fetch, env, clock, ttlMs } = options;
	const cachePath = join(options.cacheDir, provider, `${name}.json`);
	let cache: CacheFile | null = null;
	try {
		const raw = await Bun.file(cachePath).json();
		if (object(raw) && Number.isFinite(raw.fetched_at))
			cache = raw as unknown as CacheFile;
	} catch {
		// Missing or corrupt cache.
	}
	const cached = () => {
		const parsed = cache ? parseSnapshot(cache.snapshot) : null;
		return parsed?.model === model ? parsed : null;
	};
	const now = clock.now();
	if (
		env.SPATZ_NO_NETWORK === "1" ||
		(cache && cache.fetched_at <= now && now - cache.fetched_at < ttlMs)
	)
		return cached();

	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			abort.abort();
			reject(new Error("Snapshot timeout"));
		}, options.timeoutMs ?? DEFAULT_TUNING.openRouterTimeoutMs);
	});
	let snapshot: unknown = null;
	try {
		const response = await Promise.race([
			fetch(`${SNAPSHOT_BASE_URL}/${provider}/${name}.json`, {
				signal: abort.signal,
			}),
			timeout,
		]);
		if (response.status !== 404) {
			if (!response.ok) return cached();
			const text = await Promise.race([response.text(), timeout]);
			if (text.length > MAX_BYTES) return cached();
			snapshot = JSON.parse(text);
			const parsed = parseSnapshot(snapshot);
			if (parsed?.model !== model) return cached();
		}
	} catch {
		return cached();
	} finally {
		clearTimeout(timer);
	}
	try {
		await Bun.write(
			cachePath,
			JSON.stringify({ fetched_at: now, snapshot } satisfies CacheFile),
		);
	} catch {
		// A failed cache write only costs a refetch.
	}
	return parseSnapshot(snapshot);
}
