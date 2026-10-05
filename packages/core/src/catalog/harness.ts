import bundled from "../../../../catalog/harness-models.json";
import { DEFAULT_TUNING, EFFORTS, type Effort } from "../contracts/types.ts";
import type { LoadModelsOptions } from "./openrouter.ts";

export const HARNESS_CATALOG_URL =
	"https://raw.githubusercontent.com/lorenzh/spatz/main/catalog/harness-models.json";
export const HARNESSES = ["claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];
export interface HarnessModel {
	id: string;
	efforts: Effort[];
}
export interface HarnessCatalog {
	schema: 1;
	updated: string;
	harnesses: Record<Harness, { version: string; models: HarnessModel[] }>;
}

const object = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);

/** Validate known harnesses; additive fields and harnesses do not need a schema bump. */
export function parseHarnessCatalog(value: unknown): HarnessCatalog | null {
	if (
		!object(value) ||
		value.schema !== 1 ||
		typeof value.updated !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(value.updated) ||
		!Number.isFinite(Date.parse(value.updated)) ||
		new Date(value.updated).toISOString().slice(0, 10) !== value.updated ||
		!object(value.harnesses)
	)
		return null;
	for (const harness of HARNESSES) {
		const entry = value.harnesses[harness];
		if (
			!object(entry) ||
			typeof entry.version !== "string" ||
			!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(entry.version) ||
			!Array.isArray(entry.models) ||
			entry.models.length === 0 ||
			entry.models.length > 50
		)
			return null;
		const ids = new Set<string>();
		for (const model of entry.models) {
			if (
				!object(model) ||
				typeof model.id !== "string" ||
				model.id.length > 64 ||
				!/^[a-z0-9][a-z0-9._-]*$/.test(model.id) ||
				ids.has(model.id) ||
				!Array.isArray(model.efforts) ||
				model.efforts.length === 0 ||
				!model.efforts.every((e) => EFFORTS.includes(e)) ||
				new Set(model.efforts).size !== model.efforts.length
			)
				return null;
			ids.add(model.id);
		}
	}
	return value as unknown as HarnessCatalog;
}

const checkedBundle = parseHarnessCatalog(bundled);
if (!checkedBundle) throw new Error("Invalid bundled harness catalog");
export const BUNDLED_HARNESS_CATALOG: HarnessCatalog = checkedBundle;

export const formatHarnessModels = (models: HarnessModel[]): string =>
	models.map(({ id, efforts }) => `${id}:${efforts.join("+")}`).join(",");

/** Same cache envelope, TTL and bounded fetch pattern as the OpenRouter catalog. */
export async function loadHarnessCatalog(
	options: LoadModelsOptions,
): Promise<HarnessCatalog> {
	const { fetch, env, cachePath, clock, ttlMs } = options;
	let cache: HarnessCatalog | null = null;
	let fetchedAt = 0;
	try {
		const raw = await Bun.file(cachePath).json();
		if (object(raw) && Number.isFinite(raw.fetched_at)) {
			cache = parseHarnessCatalog(raw.catalog);
			fetchedAt = raw.fetched_at as number;
		}
	} catch {
		// Missing or invalid cache: try the network, then bundled data.
	}
	const fallback = cache ?? BUNDLED_HARNESS_CATALOG;
	const now = clock.now();
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
			reject(new Error("Harness catalog timeout"));
		}, options.timeoutMs ?? DEFAULT_TUNING.openRouterTimeoutMs);
	});
	let catalog: HarnessCatalog;
	try {
		const response = await Promise.race([
			fetch(HARNESS_CATALOG_URL, { signal: abort.signal }),
			timeout,
		]);
		if (!response.ok) return fallback;
		if (!response.body) return fallback;
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await Promise.race([reader.read(), timeout]);
				if (done) break;
				size += value.byteLength;
				if (size > 256 * 1024) return fallback;
				chunks.push(value);
			}
		} finally {
			void reader.cancel().catch(() => {});
		}
		const parsed = parseHarnessCatalog(
			JSON.parse(Buffer.concat(chunks).toString()),
		);
		if (!parsed) return fallback;
		catalog = parsed;
	} catch {
		return fallback;
	} finally {
		clearTimeout(timer);
	}
	try {
		await Bun.write(cachePath, JSON.stringify({ fetched_at: now, catalog }));
	} catch {
		// Cache write failure only costs a refetch next time.
	}
	return catalog;
}
