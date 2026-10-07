// Compares the pinned official prices (catalog/official-prices.json) with
// OpenRouter's current prices and reports every difference. It never changes
// the table: a person checks the official page and updates it by hand.
// Usage: bun scripts/price-check.ts   (exit 1 when a price changed or a model is gone)
import { appendFileSync } from "node:fs";
import table from "../catalog/official-prices.json";
import {
	OPENROUTER_MODELS_URL,
	parseOpenRouterModels,
} from "../packages/core/src/catalog/openrouter.ts";
import type { OpenRouterModel } from "../packages/core/src/contracts/types.ts";

const FIELDS = [
	["input", "price_prompt"],
	["cache_read", "price_cache_read"],
	["cache_write", "price_cache_write"],
	["output", "price_completion"],
] as const;
type Field = (typeof FIELDS)[number][0];
/** USD per 1M tokens; null when the official page lists no price. */
type Official = Record<Field, number | null> & { prefer_official?: string[] };

/** USD per 1M tokens, without float noise from the per-token values. */
const perMillion = (usdPerToken: number | null) =>
	usdPerToken === null ? null : Number((usdPerToken * 1e6).toPrecision(12));

/**
 * `changed`: a price that differs, or a model OpenRouter no longer lists.
 * `notes`: a difference the table already accounts for (a preferred official
 * field) or a price only OpenRouter lists.
 */
export function priceDiffs(
	official: Record<string, Official>,
	models: OpenRouterModel[],
): { changed: string[]; notes: string[] } {
	const byId = new Map(models.map((m) => [m.id, m]));
	const changed: string[] = [];
	const notes: string[] = [];
	for (const [id, o] of Object.entries(official)) {
		const m = byId.get(id);
		if (!m) {
			changed.push(`${id}: not listed at OpenRouter`);
			continue;
		}
		for (const [field, key] of FIELDS) {
			const mine = o[field];
			const theirs = perMillion(m[key]);
			if (mine === theirs) continue;
			const line = `${id} ${field}: official ${mine ?? "none"}${o.prefer_official?.includes(field) ? " (preferred)" : ""}, OpenRouter ${theirs ?? "none"}`;
			if (mine === null || o.prefer_official?.includes(field)) notes.push(line);
			else changed.push(line);
		}
	}
	return { changed, notes };
}

if (import.meta.main) {
	const res = await fetch(OPENROUTER_MODELS_URL, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
	const { changed, notes } = priceDiffs(
		table.models as Record<string, Official>,
		parseOpenRouterModels(await res.json()),
	);
	const report = [
		`# Official prices vs OpenRouter`,
		"",
		changed.length
			? "Changed (check the official page, then update catalog/official-prices.json by hand):"
			: "No changed prices.",
		...changed.map((l) => `- ${l}`),
		...(notes.length
			? ["", "Expected differences:", ...notes.map((l) => `- ${l}`)]
			: []),
		"",
	].join("\n");
	console.log(report);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
	for (const l of changed) console.log(`::warning::${l}`);
	process.exit(changed.length ? 1 : 0);
}
