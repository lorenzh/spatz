// recommend: estimates per cell and the four strategies; pure, no IO.
// Spec: "Recommendation" (Cell and filters, estimation, selection, critical tasks, exploration, output).
import { normalizeDifficulty } from "../contracts/difficulty.ts";
import {
	type Candidate,
	type Catalog,
	type CellStat,
	type Classification,
	type Decision,
	DIFFICULTIES,
	type Difficulty,
	type RankingEntry,
	type StrategyName,
	type Tuning,
} from "../contracts/types.ts";

export interface StrategyContext {
	classification: Classification;
	/** One uniform draw in [0, 1) per suggestion. */
	random: number;
	tuning: Tuning;
}

/** Beta mean: (1 + successes) / (2 + n). */
export function estimate(successes: number, n: number): number {
	return (1 + successes) / (2 + n);
}

/** 5 % quantile of Beta(1 + s, 1 + n - s), by bisection on the binomial form of the CDF (integer s and n). */
export function lowerBound(successes: number, n: number): number {
	const a = Math.round(successes) + 1;
	const m = Math.round(n) + 1; // a + b - 1
	const cdf = (x: number) => {
		// I_x(a, b) = P(Binomial(m, x) >= a)
		// Terms in log space: (1 - x) ** m underflows on large histories.
		let p = 0;
		let logTerm = m * Math.log1p(-x); // j = 0
		const logRatio = Math.log(x) - Math.log1p(-x);
		for (let j = 0; j <= m; j++) {
			if (j >= a) p += Math.exp(logTerm);
			logTerm += Math.log((m - j) / (j + 1)) + logRatio;
		}
		return p;
	};
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 50; i++) {
		const mid = (lo + hi) / 2;
		if (cdf(mid) < 0.05) lo = mid;
		else hi = mid;
	}
	return lo;
}

interface Est {
	n: number;
	estimate: number;
	successes: number;
}
/** Estimate and n per catalog candidate on one level. */
type Level = (c: Candidate) => Est;

const keyOf = (c: { model: string; effort: string }) =>
	`${c.model}:${c.effort}`;

/** Sums n and sum_quality of the given difficulties of the task_type; rows outside the catalog are ignored. */
function level(
	ctx: StrategyContext,
	history: CellStat[],
	difficulties: readonly Difficulty[],
): Level {
	const sums = new Map<string, { n: number; sum: number }>();
	// sum counts successes; quality-mean learning overrated partial-heavy pairs.
	for (const s of history) {
		if (s.task_type !== ctx.classification.task_type) continue;
		if (!difficulties.includes(normalizeDifficulty(s.difficulty))) continue;
		const k = keyOf(s);
		const cur = sums.get(k) ?? { n: 0, sum: 0 };
		cur.n += s.n;
		cur.sum += s.successes;
		sums.set(k, cur);
	}
	return (c) => {
		const s = sums.get(keyOf(c)) ?? { n: 0, sum: 0 };
		return { n: s.n, estimate: estimate(s.sum, s.n), successes: s.sum };
	};
}

const cellLevel = (ctx: StrategyContext, history: CellStat[]) =>
	level(ctx, history, [normalizeDifficulty(ctx.classification.difficulty)]);

function decision(
	catalog: Catalog,
	index: number,
	at: Level,
	strategy: StrategyName,
	reason: string,
	flags: { explored?: boolean; control?: boolean } = {},
): Decision {
	return {
		strategy,
		ranking: catalog.slice(index, index + 3).map((c) => {
			const { n, estimate } = at(c);
			return { model: c.model, effort: c.effort, estimate, n };
		}),
		reason,
		explored: flags.explored ?? false,
		control: flags.control ?? false,
	};
}

const label = (c: Candidate) => `${c.model} (${c.effort})`;

/** Steps 3 and 4 on one level; null when no catalog candidate has n >= minN. */
function pickOnLevel(catalog: Catalog, at: Level, t: Tuning): number | null {
	const ests = catalog.map(at);
	let best = ests.findIndex((e) => e.n >= t.minN);
	if (best < 0) return null;
	const cheapest = ests.findIndex(
		(e) => e.n >= t.minN && e.estimate >= t.minEstimate,
	);
	if (cheapest >= 0) return cheapest;
	ests.forEach((e, i) => {
		// only pairs with n >= minN; tie -> more expensive
		if (e.n >= t.minN && e.estimate >= (ests[best] as Est).estimate) best = i;
	});
	return best;
}

/** Cell, then extended level (same task_type, same and harder difficulties). null when even the extended level has too little data. */
export function learned(
	ctx: StrategyContext,
	catalog: Catalog,
	history: CellStat[],
): Decision | null {
	const difficulty = normalizeDifficulty(ctx.classification.difficulty);
	const levels: [Level, string][] = [[cellLevel(ctx, history), "cell"]];
	if (difficulty !== "hard") {
		const harder = DIFFICULTIES.slice(DIFFICULTIES.indexOf(difficulty));
		levels.push([level(ctx, history, harder), `${harder.join("+")} level`]);
	}
	for (const [at, name] of levels) {
		const i = pickOnLevel(catalog, at, ctx.tuning);
		if (i === null) continue;
		const c = catalog[i] as Candidate;
		const qualified =
			at(c).n >= ctx.tuning.minN && at(c).estimate >= ctx.tuning.minEstimate;
		const why = qualified
			? "is the cheapest pair that meets the learned limits"
			: "has the highest estimate because no pair meets the learned limits";
		return decision(
			catalog,
			i,
			at,
			qualified ? "learned" : "learned-fallback",
			`${label(c)} ${why} on the ${name}.`,
		);
	}
	return null;
}

/** Jev's best_candidate. null when Jev was not involved or the key is not in the catalog. */
export function jevChoice(
	ctx: StrategyContext,
	catalog: Catalog,
	history: CellStat[],
): Decision | null {
	const { fallback_used, best_candidate } = ctx.classification;
	if (fallback_used || best_candidate === null) return null;
	const i = catalog.findIndex((c) => keyOf(c) === best_candidate);
	if (i < 0) return null;
	return decision(
		catalog,
		i,
		cellLevel(ctx, history),
		"jev-choice",
		`Too little data, so Jev's best candidate ${label(catalog[i] as Candidate)} is recommended.`,
	);
}

/** Fallback without Jev: most expensive candidate. */
export function rules(
	ctx: StrategyContext,
	catalog: Catalog,
	history: CellStat[],
): Decision {
	const i = catalog.length - 1;
	return decision(
		catalog,
		i,
		cellLevel(ctx, history),
		"rules",
		`Without Jev and learned data the most expensive pair ${label(catalog[i] as Candidate)} is recommended.`,
	);
}

/** Baseline/control: most expensive candidate, control true. */
export function strongest(
	ctx: StrategyContext,
	catalog: Catalog,
	history: CellStat[],
): Decision {
	const i = catalog.length - 1;
	return decision(
		catalog,
		i,
		cellLevel(ctx, history),
		"strongest",
		`Control group: the most expensive pair ${label(catalog[i] as Candidate)} is recommended.`,
		{ control: true },
	);
}

/** Critical tasks: most expensive pair unless a cheaper one has cell n >= criticalMinN and a 5 % lower Beta bound >= criticalMinEstimate. */
function critical(
	ctx: StrategyContext,
	catalog: Catalog,
	history: CellStat[],
): Decision {
	const at = cellLevel(ctx, history);
	const t = ctx.tuning;
	const crit = ctx.classification.criticality;
	const i = catalog.findIndex((c, j) => {
		const e = at(c);
		return (
			j < catalog.length - 1 &&
			e.n >= t.criticalMinN &&
			lowerBound(e.successes, e.n) >= t.criticalMinEstimate
		);
	});
	if (i >= 0)
		return decision(
			catalog,
			i,
			at,
			"learned",
			`For a ${crit} task ${label(catalog[i] as Candidate)} is the cheapest pair with enough proven success in this cell.`,
		);
	const last = catalog.length - 1;
	return decision(
		catalog,
		last,
		at,
		"strongest",
		`For a ${crit} task the most expensive pair ${label(catalog[last] as Candidate)} is recommended.`,
	);
}

/** Decision order: critical rule, random draw (control/exploration), learned, jev-choice, rules. Catalog must be non-empty and in cost order. */
export function recommend(
	ctx: StrategyContext,
	catalog: Catalog,
	history: CellStat[],
): Decision {
	if (ctx.classification.criticality !== "none")
		return critical(ctx, catalog, history);
	const { controlRate, exploreRate } = ctx.tuning;
	if (ctx.random < controlRate) return strongest(ctx, catalog, history);
	const normal =
		learned(ctx, catalog, history) ??
		jevChoice(ctx, catalog, history) ??
		rules(ctx, catalog, history);
	if (ctx.random >= controlRate + exploreRate) return normal;

	// Exploration: cheaper than the normal pick, fewest cell outcomes, tie -> cheaper.
	const normalKey = keyOf(normal.ranking[0] as RankingEntry);
	const normalIndex = catalog.findIndex((c) => keyOf(c) === normalKey);
	if (normalIndex <= 0) return normal;
	const at = cellLevel(ctx, history);
	let pick = 0;
	for (let j = 1; j < normalIndex; j++)
		if (at(catalog[j] as Candidate).n < at(catalog[pick] as Candidate).n)
			pick = j;
	return decision(
		catalog,
		pick,
		at,
		normal.strategy,
		`Exploration: ${label(catalog[pick] as Candidate)} is cheaper than the normal pick and has the fewest outcomes in this cell.`,
		{ explored: true },
	);
}
