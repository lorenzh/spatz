// catalog: --models parsing, model-id rule, candidate expansion and cost order.
// Spec: "Candidates and metadata", "Model IDs".
import {
	type Candidate,
	type CandidateKey,
	type Catalog,
	type Config,
	DEFAULT_EFFORTS,
	EFFORTS,
	type Effort,
	type OpenRouterModel,
	type RequestedModel,
} from "../contracts/types.ts";

const isEffort = (e: string): e is Effort =>
	(EFFORTS as readonly string[]).includes(e);

/** Format: <id>[:<effort>+<effort>...],... Throws on unknown effort or empty list. */
export function parseModelsArg(arg: string): RequestedModel[] {
	const entries = arg
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (entries.length === 0) throw new Error("--models: empty model list");
	return entries.map((entry) => {
		const sep = entry.indexOf(":");
		const id = (sep < 0 ? entry : entry.slice(0, sep)).trim();
		if (!id) throw new Error(`--models: missing model id in "${entry}"`);
		if (sep < 0) return { requested_id: id, efforts: null };
		const efforts = entry
			.slice(sep + 1)
			.split("+")
			.map((e) => e.trim());
		for (const e of efforts) {
			if (!isEffort(e))
				throw new Error(
					`--models: unknown effort "${e}" for ${id} (allowed: ${EFFORTS.join(", ")})`,
				);
		}
		return { requested_id: id, efforts: efforts as Effort[] };
	});
}

/** Alias file first; claude-* -> anthropic/ + last dash between two digits becomes a dot; gpt-* -> openai/; ids with "/" stay. */
export function toCanonicalId(
	id: string,
	aliases: Record<string, string>,
): string {
	const alias = Object.hasOwn(aliases, id) ? aliases[id] : undefined;
	if (alias) return alias;
	if (id.includes("/")) return id;
	// Greedy prefix makes this hit the last digit-dash-digit.
	if (id.startsWith("claude-"))
		return `anthropic/${id.replace(/-\d{8}$/, "").replace(/^(.*\d)-(\d)/, "$1.$2")}`;
	if (id.startsWith("gpt-"))
		return `openai/${id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")}`;
	return id;
}

/** Model revision from a dated id ("-20250929" or "-2025-08-07"), else null. */
export function modelVersion(id: string): string | null {
	return /-(\d{8}|\d{4}-\d{2}-\d{2})$/.exec(id)?.[1] ?? null;
}

/**
 * modelVersion, else the revision the harness reports for an undated id: the date of the one
 * dated harness model id whose undated form has the same canonical id (alias, harness or
 * canonical form). Several dated revisions stay unknown (null).
 */
export function resolveModelVersion(
	id: string,
	harnessIds: string[],
	aliases: Record<string, string> = {},
): string | null {
	const own = modelVersion(id);
	if (own) return own;
	const canonical = toCanonicalId(id, aliases);
	const dated = new Set(
		harnessIds.flatMap((h) => {
			const v = modelVersion(h);
			const base = v && h.slice(0, -v.length - 1);
			return base && toCanonicalId(base, aliases) === canonical ? [v] : [];
		}),
	);
	return dated.size === 1 ? ([...dated][0] ?? null) : null;
}

/**
 * Family and version of a canonical id: numeric dash-tokens ("6", "6.1", "4.5") are the version,
 * the rest is the family. "openai/gpt-6.1-sol" -> openai/gpt-sol, [6, 1].
 */
function familyVersion(model: string): { family: string; version: number[] } {
	// A date suffix is a revision, not a version ("openai/gpt-6-sol-2026-01-01" stays unstripped by toCanonicalId).
	const date = modelVersion(model);
	const tokens = (date ? model.slice(0, -date.length - 1) : model).split("-");
	const isNum = (t: string) => /^\d+(\.\d+)*$/.test(t);
	return {
		family: tokens.filter((t) => !isNum(t)).join("-"),
		version: tokens.filter(isNum).flatMap((t) => t.split(".").map(Number)),
	};
}

const newer = (a: number[], b: number[]): boolean => {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d) return d > 0;
	}
	return false;
};

function priceClass(m: OpenRouterModel | undefined, model: string): string {
	if (!m) return `${model}, Preisklasse: unbekannt`;
	const perM = Number((m.price_completion * 1e6).toPrecision(6));
	return `${m.name}, Preisklasse: ${perM} USD/M Output-Tokens`;
}

/** Expands requested models into candidates (default efforts low/medium/high filtered by OpenRouter), attaches metadata and description, sorts by cost order. */
export function buildCatalog(
	requested: RequestedModel[],
	models: OpenRouterModel[],
	config: Pick<Config, "aliases" | "descriptions">,
): Catalog {
	const byId = new Map(models.map((m) => [m.id, m]));
	const seen = new Map<CandidateKey, Candidate>();
	// Only the latest version of each family is a candidate; older outcomes stay in the store.
	const latest = new Map<string, number[]>();
	for (const r of requested) {
		const { family, version } = familyVersion(
			toCanonicalId(r.requested_id, config.aliases),
		);
		const best = latest.get(family);
		if (!best || newer(version, best)) latest.set(family, version);
	}
	for (const r of requested) {
		const model = toCanonicalId(r.requested_id, config.aliases);
		const { family, version } = familyVersion(model);
		const best = latest.get(family) as number[];
		if (newer(best, version)) continue;
		const meta = byId.get(model);
		const supported = meta?.supported_efforts;
		const efforts =
			r.efforts ??
			DEFAULT_EFFORTS.filter((e) => !supported || supported.includes(e));
		for (const effort of efforts) {
			const key = candidateKey({ model, effort });
			if (seen.has(key)) continue;
			seen.set(key, {
				model,
				effort,
				requested_id: r.requested_id,
				known: meta !== undefined,
				price_prompt: meta?.price_prompt ?? null,
				price_completion: meta?.price_completion ?? null,
				context_length: meta?.context_length ?? null,
				description: Object.hasOwn(config.descriptions, model)
					? (config.descriptions[model] as string)
					: priceClass(meta, model),
			});
		}
	}
	return [...seen.values()].sort(compareCost);
}

/** Output price, input price, effort (none < low < medium < high < xhigh < max < ultra), id; unknown models after all known. */
export function compareCost(a: Candidate, b: Candidate): number {
	// Unknown (null price) counts as the most expensive tier.
	const price = (p: number | null) => p ?? Number.POSITIVE_INFINITY;
	return (
		Number(!a.known) - Number(!b.known) ||
		price(a.price_completion) - price(b.price_completion) ||
		price(a.price_prompt) - price(b.price_prompt) ||
		EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort) ||
		(a.model < b.model ? -1 : a.model > b.model ? 1 : 0)
	);
}

/** "model:effort". */
export function candidateKey(
	c: Pick<Candidate, "model" | "effort">,
): CandidateKey {
	return `${c.model}:${c.effort}`;
}
