// catalog: OpenRouter model list with a local 24 h cache.
// Spec: "Metadata".
import type { Clock, Env, FetchFn } from "../contracts/deps.ts";
import { DEFAULT_TUNING, type OpenRouterModel } from "../contracts/types.ts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null =>
	v !== null && typeof v === "object" ? (v as Raw) : null;

/** USD per token from a non-negative decimal string; NaN for anything else ("-1", "0x10", "1e309", null). */
const price = (v: unknown): number => {
	const n =
		typeof v === "string" && /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v)
			? Number(v)
			: Number.NaN;
	return Number.isFinite(n) ? n : Number.NaN;
};

const nullablePrice = (value: unknown): number | null => {
	const parsed = price(value);
	return Number.isNaN(parsed) ? null : parsed;
};

const isPrice = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Shape check for cached entries against the OpenRouterModel contract. */
function isModel(v: unknown): v is OpenRouterModel {
	const m = obj(v);
	return (
		typeof m?.id === "string" &&
		typeof m.name === "string" &&
		isPrice(m.price_prompt) &&
		isPrice(m.price_completion) &&
		(m.price_cache_read == null || isPrice(m.price_cache_read)) &&
		(m.price_cache_write == null || isPrice(m.price_cache_write)) &&
		(m.context_length === null || typeof m.context_length === "number") &&
		(m.supported_efforts === null ||
			(Array.isArray(m.supported_efforts) &&
				m.supported_efforts.every((e) => typeof e === "string")))
	);
}

/** Trims the /api/v1/models JSON ({ data: [...] }); prices parsed from strings (USD per token). */
export function parseOpenRouterModels(json: unknown): OpenRouterModel[] {
	const data = obj(json)?.data;
	if (!Array.isArray(data)) return [];
	const out: OpenRouterModel[] = [];
	for (const entry of data) {
		const m = obj(entry);
		const pricing = obj(m?.pricing);
		const prompt = price(pricing?.prompt);
		const completion = price(pricing?.completion);
		// "-1" marks variable-price routers: treat as unknown to OpenRouter.
		if (typeof m?.id !== "string" || !(prompt >= 0) || !(completion >= 0))
			continue;
		const efforts = obj(m.reasoning)?.supported_efforts;
		out.push({
			id: m.id,
			name: typeof m.name === "string" ? m.name : m.id,
			price_prompt: prompt,
			price_completion: completion,
			price_cache_read: nullablePrice(pricing?.input_cache_read),
			price_cache_write: nullablePrice(pricing?.input_cache_write),
			context_length:
				typeof m.context_length === "number" ? m.context_length : null,
			supported_efforts: Array.isArray(efforts)
				? efforts.filter((e): e is string => typeof e === "string")
				: null,
		});
	}
	return out;
}

export interface LoadModelsOptions {
	fetch: FetchFn;
	env: Env;
	cachePath: string;
	clock: Clock;
	ttlMs: number;
	/** Abort the request (headers and body) after this many ms. Default DEFAULT_TUNING.openRouterTimeoutMs. */
	timeoutMs?: number;
}

interface CacheFile {
	fetched_at: number;
	models: OpenRouterModel[];
}

async function readCache(path: string): Promise<CacheFile | null> {
	try {
		const c = obj(await Bun.file(path).json());
		if (
			typeof c?.fetched_at !== "number" ||
			!Array.isArray(c.models) ||
			!c.models.every(isModel)
		)
			return null;
		return {
			fetched_at: c.fetched_at,
			models: c.models.map((m) => ({
				...m,
				price_cache_read: m.price_cache_read ?? null,
				price_cache_write: m.price_cache_write ?? null,
			})),
		};
	} catch {
		return null;
	}
}

/** Fresh cache -> no fetch. Else fetch (Authorization: Bearer OPENROUTER_API_KEY only if set), write cache. Fetch error or timeout -> stale cache; no cache -> []. */
export async function loadOpenRouterModels(
	options: LoadModelsOptions,
): Promise<OpenRouterModel[]> {
	const { fetch, env, cachePath, clock, ttlMs } = options;
	const cache = await readCache(cachePath);
	if (env.SPATZ_NO_NETWORK === "1") return cache?.models ?? [];
	const now = clock.now();
	if (cache && now - cache.fetched_at < ttlMs) return cache.models;

	const key = env.OPENROUTER_API_KEY;
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Raced as well as passed as signal: an injected fetch may ignore the signal.
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			abort.abort();
			reject(new Error("OpenRouter timeout"));
		}, options.timeoutMs ?? DEFAULT_TUNING.openRouterTimeoutMs);
	});
	const bounded = <T>(p: Promise<T>) => {
		p.catch(() => {}); // the loser of the race may reject after the abort
		return Promise.race([p, timeout]);
	};
	let models: OpenRouterModel[];
	try {
		const res = await bounded(
			fetch(OPENROUTER_MODELS_URL, {
				...(key && { headers: { Authorization: `Bearer ${key}` } }),
				signal: abort.signal,
			}),
		);
		if (!res.ok) return cache?.models ?? [];
		models = parseOpenRouterModels(await bounded(res.json()));
	} catch {
		return cache?.models ?? [];
	} finally {
		clearTimeout(timer);
	}
	try {
		await Bun.write(
			cachePath,
			JSON.stringify({ fetched_at: now, models } satisfies CacheFile),
		);
	} catch {
		// Cache write failure only costs a refetch next time.
	}
	return models;
}
