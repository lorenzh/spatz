import { expect, test } from "bun:test";
import type { PriorCell } from "../catalog/snapshot.ts";
import {
	type Candidate,
	type Catalog,
	type CellStat,
	DEFAULT_TUNING,
	type Difficulty,
	type Effort,
} from "../contracts/types.ts";
import { estimate, recommend, type StrategyContext } from "./index.ts";

const cand = (model: string, effort: Effort): Candidate => ({
	model,
	effort,
	requested_id: model,
	known: true,
	price_prompt: 1e-6,
	price_completion: 2e-6,
	context_length: 1,
	description: model,
});
const cheap = cand("anthropic/claude-sonnet-5.5", "medium");
const dear = cand("anthropic/claude-opus-5.5", "high");
const CATALOG: Catalog = [cheap, dear];

const prior = (
	c: Candidate,
	n_eff: number,
	s_eff: number,
	difficulty: Difficulty = "easy",
	over: Partial<PriorCell> = {},
): PriorCell => ({
	task_type: "code.bugfix",
	difficulty,
	model: c.model,
	effort: c.effort,
	n_eff,
	s_eff,
	n_bench: n_eff,
	version_match: "exact",
	...over,
});
const live = (c: Candidate, n: number, successes: number): CellStat => ({
	task_type: "code.bugfix",
	difficulty: "easy",
	model: c.model,
	effort: c.effort,
	n,
	sum_quality: successes,
	successes,
});
function run(
	history: CellStat[],
	priors: PriorCell[] | undefined,
	over: Partial<StrategyContext["classification"]> = {},
	random = 0.5,
) {
	return recommend(
		{
			classification: {
				task_type: "code.bugfix",
				difficulty: "easy",
				criticality: "none",
				best_candidate: null,
				probabilities: null,
				model_ref: "jev-1.13.0",
				fallback_used: true,
				fallback_reason: "no_key",
				...over,
			},
			random,
			tuning: DEFAULT_TUNING,
			priors,
		},
		CATALOG,
		history,
	);
}
const entry = (d: ReturnType<typeof run>, c: Candidate) =>
	d.ranking.find((r) => r.model === c.model && r.effort === c.effort);

test("no snapshot: ranking and reason are unchanged", () => {
	const without = run([], undefined);
	expect(run([], [])).toEqual(without);
	expect(without.ranking[0]).toEqual({
		model: dear.model,
		effort: dear.effort,
		estimate: 0.5,
		n: 0,
	});
});

test("cold start: the prior moves the estimate, n stays 0, n_prior and n_bench show", () => {
	const d = run([], [prior(cheap, 3, 3), prior(dear, 3, 0)]);
	// w = 2, a = 0 -> (1 + 0) / (2 + 2)
	expect(entry(d, dear)).toMatchObject({ n: 0, n_prior: 2, n_bench: 3 });
	expect(entry(d, dear)?.estimate).toBeCloseTo(0.25);
	expect(d.reason).toContain("version_match: exact");
});

test("bench cells with n = 1 and n = 2 weigh 1 and 2", () => {
	const one = run([], [prior(dear, 1, 1)]);
	expect(entry(one, dear)).toMatchObject({ n: 0, n_prior: 1 });
	expect(entry(one, dear)?.estimate).toBeCloseTo(estimate(0, 0, 1, 1));
	const two = run([], [prior(dear, 2, 2)]);
	expect(entry(two, dear)?.n_prior).toBe(2);
	expect(entry(two, dear)?.estimate).toBeCloseTo(0.75);
});

test("pooled level sums n_eff and s_eff of harder difficulties", () => {
	const history = [{ ...live(cheap, 5, 5), difficulty: "medium" as const }];
	const d = run(history, [
		prior(cheap, 1, 1, "medium"),
		prior(cheap, 1.5, 0.5, "hard"),
	]);
	// pooled easy+medium+hard: n_eff 2.5 -> w 2, a = 2 * 1.5 / 2.5 = 1.2; live 5/5
	expect(entry(d, cheap)).toMatchObject({ n: 5, n_prior: 2, n_bench: 2.5 });
	expect(entry(d, cheap)?.estimate).toBeCloseTo((1 + 5 + 1.2) / (2 + 5 + 2));
	expect(d.reason).toContain("easy+medium+hard level");
});

test("the prior does not open the gates: no live n, no learned pick", () => {
	const d = run([], [prior(cheap, 3, 3)]);
	expect(d.strategy).toBe("rules");
	expect(pickOf(d)).toBe(dear.model);
});
const pickOf = (d: ReturnType<typeof run>) => d.ranking[0]?.model;

test("critical n >= 10 is decided by live counts only", () => {
	const crit = { criticality: "security" as const };
	const huge = [prior(cheap, 3, 3)];
	expect(run([live(cheap, 5, 5)], huge, crit).ranking[0]?.model).toBe(
		dear.model,
	);
	expect(run([live(cheap, 3, 0)], huge, crit).ranking[0]?.model).toBe(
		dear.model,
	);
	const proven = run([live(cheap, 40, 40)], [prior(cheap, 3, 0)], crit);
	expect(proven.ranking[0]?.model).toBe(cheap.model);
	expect(proven.ranking[0]?.n).toBe(40);
});

test("null version gives version_match unknown in the reason", () => {
	const d = run([], [prior(dear, 2, 2, "easy", { version_match: "unknown" })]);
	expect(d.reason).toContain("version_match: unknown");
});
