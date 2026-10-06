import { describe, expect, test } from "bun:test";
import {
	type Candidate,
	type Catalog,
	type CellStat,
	type Classification,
	type Criticality,
	DEFAULT_TUNING,
	type Decision,
	type Difficulty,
	type Effort,
} from "../contracts/types.ts";
import {
	estimate,
	jevChoice,
	learned,
	lowerBound,
	recommend,
	rules,
	type StrategyContext,
	strongest,
} from "./index.ts";

// Catalog in cost order, cheapest first: c0 < c1 < c2 < c3.
function cand(model: string, effort: Effort): Candidate {
	return {
		model,
		effort,
		requested_id: model,
		known: true,
		price_prompt: 0.000001,
		price_completion: 0.000002,
		context_length: 200000,
		description: model,
	};
}
const c0 = cand("openai/gpt-6-luna", "low");
const c1 = cand("anthropic/claude-sonnet-5.5", "medium");
const c2 = cand("anthropic/claude-opus-5.5", "low");
const c3 = cand("anthropic/claude-opus-5.5", "high");
const CATALOG: Catalog = [c0, c1, c2, c3];
const key = (c: { model: string; effort: Effort }) => `${c.model}:${c.effort}`;

function cls(over: Partial<Classification> = {}): Classification {
	return {
		task_type: "code.bugfix",
		difficulty: "easy",
		criticality: "none",
		best_candidate: key(c1),
		probabilities: null,
		model_ref: "jev-1.13.0",
		fallback_used: false,
		fallback_reason: null,
		...over,
	};
}
function ctx(
	random: number,
	over: Partial<Classification> = {},
): StrategyContext {
	return { classification: cls(over), random, tuning: DEFAULT_TUNING };
}
function stat(
	c: Candidate,
	n: number,
	sum: number,
	difficulty: Difficulty = "easy",
	task_type: CellStat["task_type"] = "code.bugfix",
	successes = sum,
): CellStat {
	return {
		task_type,
		difficulty,
		model: c.model,
		effort: c.effort,
		n,
		sum_quality: sum,
		successes,
	};
}
const pick = (d: Decision) => d.ranking[0];
const LEARNED = 0.5; // random draw in the 80 % learned band

test("legacy difficulty inputs pool exactly like English and print English reasons", () => {
	const history = [
		stat(c0, 3, 3, "medium"),
		stat(c0, 2, 2, "hard"),
		stat(c1, 20, 20, "easy"),
	];
	const expected = recommend(
		ctx(LEARNED, { difficulty: "medium" }),
		CATALOG,
		history,
	);
	const legacyContext = JSON.parse(JSON.stringify(ctx(LEARNED)));
	legacyContext.classification.difficulty = "mittel";
	const legacyHistory = JSON.parse(JSON.stringify(history));
	for (const [i, difficulty] of ["mittel", "schwer", "leicht"].entries())
		legacyHistory[i].difficulty = difficulty;
	expect(recommend(legacyContext, CATALOG, legacyHistory)).toEqual(expected);
	expect(expected.reason).toContain("medium+hard level");
	expect(expected.ranking[0]?.n).toBe(5);
});

describe("estimate", () => {
	test("is the Beta mean (1 + sum) / (2 + n)", () => {
		expect(estimate(0, 0)).toBe(0.5);
		expect(estimate(4, 5)).toBeCloseTo(5 / 7);
		expect(estimate(9, 10)).toBeCloseTo(10 / 12);
	});
});

describe("lowerBound", () => {
	test("stays stable on large histories", () => {
		expect(lowerBound(0, 1100)).toBeCloseTo(1 - 0.95 ** (1 / 1101), 9);
		expect(lowerBound(1100, 1100)).toBeCloseTo(0.05 ** (1 / 1101), 6);
		const x = lowerBound(550, 1100);
		expect(x).toBeGreaterThan(0.47);
		expect(x).toBeLessThan(0.5);
	});
	test("is the 5 % quantile of Beta(1 + s, 1 + n - s)", () => {
		// Beta(s+1, 1) has CDF x^(s+1).
		expect(lowerBound(10, 10)).toBeCloseTo(0.05 ** (1 / 11), 6);
		expect(lowerBound(28, 28)).toBeCloseTo(0.05 ** (1 / 29), 6);
		// Beta(1, 1) is uniform.
		expect(lowerBound(0, 0)).toBeCloseTo(0.05, 6);
		// Beta(6, 2) has CDF 7x^6 - 6x^7.
		const x = lowerBound(5, 6);
		expect(7 * x ** 6 - 6 * x ** 7).toBeCloseTo(0.05, 6);
	});
});

describe("binary success", () => {
	test("partial outcomes count as failures, not as 0.5 quality", () => {
		// 6 passes and 2 partials: quality (1+7)/10 = 0.8 qualifies; success (1+6)/10 = 0.7 does not.
		const history = [stat(c0, 8, 7, "easy", "code.bugfix", 6), stat(c1, 8, 8)];
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(pick(d)).toMatchObject({ model: c1.model, estimate: 0.9 });
		expect(d.strategy).toBe("learned");
	});

	test("replay fixture: a partial-heavy review x medium cell moves only that pick", () => {
		// Fixture shaped like the live db: review x medium, cheapest pair passes half and is partial otherwise.
		const fixture = [
			stat(c0, 12, 9, "medium", "review", 6),
			stat(c0, 10, 9.5, "medium", "review", 9), // cell total: n 22, quality 18.5, successes 15
			stat(c1, 10, 10, "medium", "review"),
			stat(c0, 10, 10, "easy", "code.bugfix"), // all passes: unchanged
		];
		// Mean-quality learning picked c0 (19.5/24 ≈ 0.81); binary rejects it (16/24 ≈ 0.67) and picks c1.
		const review = recommend(
			ctx(LEARNED, { task_type: "review", difficulty: "medium" }),
			CATALOG,
			fixture,
		);
		expect(pick(review)).toMatchObject({ model: c1.model, effort: c1.effort });
		const bugfix = recommend(ctx(LEARNED), CATALOG, fixture);
		expect(pick(bugfix)).toMatchObject({ model: c0.model, effort: c0.effort });
	});
});

describe("critical tasks", () => {
	const crits: Criticality[] = ["business_logic", "security", "data_integrity"];

	test("without data the most expensive pair wins, never control or exploration", () => {
		for (const criticality of crits) {
			for (const r of [0, 0.05, 0.1, 0.15, 0.5, 0.99]) {
				const d = recommend(ctx(r, { criticality }), CATALOG, []);
				expect(pick(d)).toMatchObject({ model: c3.model, effort: c3.effort });
				expect(d.control).toBe(false);
				expect(d.explored).toBe(false);
			}
		}
	});

	test("cheapest pair with cell n >= 10 and 5 % lower bound >= 0.9 wins", () => {
		const history = [
			stat(c0, 10, 10), // estimate 11/12 but lower bound 0.05^(1/11) ≈ 0.76
			stat(c1, 30, 30), // lower bound 0.05^(1/31) ≈ 0.908 qualifies
			stat(c2, 40, 40), // qualifies, but more expensive
		];
		for (const r of [0.05, 0.15, 0.5]) {
			const d = recommend(
				ctx(r, { criticality: "security" }),
				CATALOG,
				history,
			);
			expect(pick(d)).toMatchObject({
				model: c1.model,
				effort: c1.effort,
				n: 30,
			});
			expect(d.control).toBe(false);
			expect(d.explored).toBe(false);
		}
	});

	test("estimate 0.9 with a lower bound below 0.9 does not qualify", () => {
		const history = [stat(c0, 18, 17)]; // mean 18/20 = 0.9, bound ≈ 0.75
		const d = recommend(
			ctx(LEARNED, { criticality: "security" }),
			CATALOG,
			history,
		);
		expect(pick(d)).toMatchObject({ model: c3.model, effort: c3.effort });
	});

	test("estimate below 0.9 or data only on the extended level does not count", () => {
		const history = [
			stat(c1, 10, 9), // 10/12 ≈ 0.83
			stat(c0, 50, 50, "hard"), // other cell
		];
		const d = recommend(
			ctx(LEARNED, { criticality: "security" }),
			CATALOG,
			history,
		);
		expect(pick(d)).toMatchObject({ model: c3.model, effort: c3.effort });
	});
});

describe("random draw", () => {
	const qualified = [stat(c1, 5, 5)];

	test("random < 0.1 recommends the most expensive pair as control", () => {
		const d = recommend(ctx(0.05), CATALOG, qualified);
		expect(pick(d)).toMatchObject({ model: c3.model, effort: c3.effort });
		expect(d.control).toBe(true);
		expect(d.explored).toBe(false);
		expect(d.strategy).toBe("strongest");
	});

	test("exploration picks the cheaper pair with fewest cell outcomes, even below 0.8", () => {
		const history = [stat(c0, 3, 3), stat(c1, 1, 0), stat(c2, 5, 5)];
		const d = recommend(ctx(0.15), CATALOG, history);
		expect(pick(d)).toMatchObject({ model: c1.model, effort: c1.effort, n: 1 });
		expect(pick(d)?.estimate).toBeCloseTo(1 / 3);
		expect(d.explored).toBe(true);
		expect(d.control).toBe(false);
		expect(d.reason).toMatch(/explor/i);
	});

	test("exploration counts cell outcomes, not extended-level outcomes", () => {
		const history = [
			stat(c0, 3, 3),
			stat(c1, 1, 0),
			stat(c2, 5, 5),
			stat(c1, 10, 10, "hard"), // extended: c1 11 > c0 3
		];
		const d = recommend(ctx(0.15), CATALOG, history);
		expect(pick(d)).toMatchObject({ model: c1.model, effort: c1.effort, n: 1 });
		expect(pick(d)?.estimate).toBeCloseTo(1 / 3);
		expect(d.explored).toBe(true);
	});

	test("exploration tie on outcome count goes to the cheaper pair", () => {
		const history = [stat(c0, 1, 1), stat(c1, 1, 1), stat(c2, 5, 5)];
		const d = recommend(ctx(0.1), CATALOG, history);
		expect(pick(d)).toMatchObject({ model: c0.model, effort: c0.effort });
		expect(d.explored).toBe(true);
	});

	test("exploration without a cheaper pair keeps the normal pick", () => {
		const d = recommend(ctx(0.19), CATALOG, [stat(c0, 5, 5)]);
		expect(pick(d)).toMatchObject({ model: c0.model, effort: c0.effort });
		expect(d.explored).toBe(false);
		expect(d.strategy).toBe("learned");
	});

	test("random >= 0.2 is the learned choice", () => {
		const d = recommend(ctx(0.2), CATALOG, qualified);
		expect(pick(d)).toMatchObject({ model: c1.model, effort: c1.effort });
		expect(d.explored).toBe(false);
		expect(d.control).toBe(false);
	});
});

describe("learned choice", () => {
	test("cheapest pair with n >= 5 and estimate >= 0.8 wins", () => {
		const history = [
			stat(c0, 5, 2), // 3/7, too low
			stat(c1, 4, 4), // n too low
			stat(c2, 5, 5), // 6/7 qualifies
			stat(c3, 30, 30), // qualifies, more expensive
		];
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(pick(d)).toMatchObject({ model: c2.model, effort: c2.effort, n: 5 });
		expect(pick(d)?.estimate).toBeCloseTo(6 / 7);
		expect(d.strategy).toBe("learned");
	});

	test("estimate exactly 0.8 qualifies (inclusive)", () => {
		const history = [
			stat(c0, 8, 7), // 8/10 = 0.8 exactly
			stat(c1, 20, 20), // qualifies, more expensive
		];
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(pick(d)).toMatchObject({
			model: c0.model,
			effort: c0.effort,
			estimate: 0.8,
			n: 8,
		});
	});

	test("enough data but nobody qualifies: highest estimate with n >= 5 wins", () => {
		const history = [stat(c0, 5, 2), stat(c2, 6, 3), stat(c1, 2, 2)]; // 3/7, 4/8, 3/4 (n too low)
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(pick(d)).toMatchObject({ model: c2.model, effort: c2.effort, n: 6 });
		expect(d.strategy).toBe("learned-fallback");
	});

	test("best-estimate step skips pairs with too few outcomes", () => {
		const history = [stat(c1, 5, 2), stat(c0, 1, 1)]; // c0 2/3 > 3/7, but n = 1
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(pick(d)).toMatchObject({ model: c1.model, effort: c1.effort, n: 5 });
	});

	test("highest estimate tie goes to the more expensive pair", () => {
		const history = [stat(c1, 5, 3), stat(c2, 5, 3)]; // both 4/7 > 0.5
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(pick(d)).toMatchObject({ model: c2.model, effort: c2.effort });
	});

	test("returns null when cell and extended level have too little data", () => {
		expect(learned(ctx(LEARNED), CATALOG, [stat(c0, 4, 4)])).toBeNull();
	});
});

describe("extended level", () => {
	test("easy sums easy, medium and hard of the same task_type", () => {
		const history = [
			stat(c0, 2, 2, "easy"),
			stat(c0, 2, 2, "medium"),
			stat(c0, 1, 1, "hard"),
			stat(c1, 20, 20, "easy", "review"), // other task_type
		];
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(pick(d)).toMatchObject({ model: c0.model, effort: c0.effort, n: 5 });
		expect(pick(d)?.estimate).toBeCloseTo(6 / 7);
		expect(d.strategy).toBe("learned");
	});

	test("medium uses medium and hard, not easy", () => {
		const easyOnly = [stat(c0, 10, 10, "easy")];
		const d = recommend(
			ctx(LEARNED, { difficulty: "medium" }),
			CATALOG,
			easyOnly,
		);
		expect(d.strategy).toBe("jev-choice");

		const hard = [stat(c0, 5, 5, "hard")];
		const e = recommend(ctx(LEARNED, { difficulty: "medium" }), CATALOG, hard);
		expect(e.strategy).toBe("learned");
		expect(pick(e)).toMatchObject({ model: c0.model, n: 5 });
	});

	test("medium sums medium and hard when neither alone has n >= 5", () => {
		const history = [
			stat(c0, 3, 3, "medium"),
			stat(c0, 2, 2, "hard"),
			stat(c0, 10, 0, "easy"), // easier, ignored
		];
		const d = recommend(
			ctx(LEARNED, { difficulty: "medium" }),
			CATALOG,
			history,
		);
		expect(d.strategy).toBe("learned");
		expect(pick(d)).toMatchObject({ model: c0.model, effort: c0.effort, n: 5 });
		expect(pick(d)?.estimate).toBeCloseTo(6 / 7);
	});

	test("hard has no extension", () => {
		const easier = [stat(c0, 10, 10, "easy"), stat(c0, 10, 10, "medium")];
		const d = recommend(ctx(LEARNED, { difficulty: "hard" }), CATALOG, easier);
		expect(d.strategy).toBe("jev-choice");
	});

	test("extended level enough data but none qualifies: highest estimate", () => {
		const history = [
			stat(c0, 5, 1, "medium"), // 2/7
			stat(c1, 3, 2, "medium"),
			stat(c1, 3, 1, "hard"), // 6 outcomes, 4/8
			stat(c2, 1, 1, "hard"), // 2/3, but n = 1
		];
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(pick(d)).toMatchObject({ model: c1.model, effort: c1.effort, n: 6 });
		expect(d.strategy).toBe("learned-fallback");
	});
});

describe("jev-choice and rules", () => {
	test("too little data uses Jev's best candidate", () => {
		const d = recommend(ctx(LEARNED), CATALOG, [stat(c0, 1, 1)]);
		expect(pick(d)).toMatchObject({ model: c1.model, effort: c1.effort });
		expect(d.strategy).toBe("jev-choice");
		expect(d.explored).toBe(false);
		expect(d.control).toBe(false);
	});

	test("best candidate outside the catalog falls back to rules", () => {
		const c = ctx(LEARNED, { best_candidate: "openai/unknown:high" });
		expect(jevChoice(c, CATALOG, [])).toBeNull();
		const d = recommend(c, CATALOG, []);
		expect(d.strategy).toBe("rules");
		expect(pick(d)).toMatchObject({ model: c3.model, effort: c3.effort });
	});

	test("without Jev rules picks the most expensive pair", () => {
		for (const over of [
			{ fallback_used: true, best_candidate: null, model_ref: null },
			{ best_candidate: null },
		]) {
			const d = recommend(ctx(LEARNED, over), CATALOG, []);
			expect(d.strategy).toBe("rules");
			expect(pick(d)).toMatchObject({ model: c3.model, effort: c3.effort });
		}
		expect(
			jevChoice(ctx(LEARNED, { fallback_used: true }), CATALOG, []),
		).toBeNull();
	});

	test("rules and strongest return the most expensive pair", () => {
		expect(pick(rules(ctx(LEARNED), CATALOG, []))).toMatchObject({
			model: c3.model,
			effort: c3.effort,
		});
		const s = strongest(ctx(LEARNED), CATALOG, []);
		expect(pick(s)).toMatchObject({ model: c3.model, effort: c3.effort });
		expect(s.control).toBe(true);
	});
});

describe("eligibility filter", () => {
	test("history rows outside the catalog are ignored, also for 'enough data'", () => {
		const history = [
			{ ...stat(c0, 50, 50), model: "openai/not-passed" },
			{ ...stat(c3, 50, 50), effort: "max" as Effort },
			stat(c0, 2, 2),
		];
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(d.strategy).toBe("jev-choice");
		expect(d.ranking.every((r) => CATALOG.some((c) => key(c) === key(r)))).toBe(
			true,
		);
	});
});

describe("ranking", () => {
	test("pick then up to two next more expensive pairs with cell estimate and n", () => {
		const history = [stat(c1, 5, 5), stat(c2, 3, 1)];
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(d.ranking).toHaveLength(3);
		expect(d.ranking[0]).toMatchObject({
			model: c1.model,
			effort: c1.effort,
			n: 5,
		});
		expect(d.ranking[1]).toEqual({
			model: c2.model,
			effort: c2.effort,
			estimate: 2 / 5,
			n: 3,
		});
		expect(d.ranking[2]).toEqual({
			model: c3.model,
			effort: c3.effort,
			estimate: 0.5,
			n: 0,
		});
	});

	test("ranking is capped at three entries when more pairs follow", () => {
		const d = recommend(ctx(LEARNED), CATALOG, [
			stat(c0, 5, 5),
			stat(c1, 3, 1),
		]);
		expect(d.ranking).toEqual([
			{ model: c0.model, effort: c0.effort, estimate: 6 / 7, n: 5 },
			{ model: c1.model, effort: c1.effort, estimate: 2 / 5, n: 3 },
			{ model: c2.model, effort: c2.effort, estimate: 0.5, n: 0 },
		]);
	});

	test("ranking shrinks near the expensive end", () => {
		expect(
			recommend(ctx(LEARNED), CATALOG, [stat(c2, 5, 5)]).ranking,
		).toHaveLength(2);
		expect(
			recommend(ctx(LEARNED, { best_candidate: null }), CATALOG, []).ranking,
		).toHaveLength(1);
	});

	test("extended level values are used for the ranking", () => {
		const history = [
			stat(c0, 5, 5, "hard"),
			stat(c1, 2, 1, "medium"),
			stat(c1, 1, 1, "easy"),
		];
		const d = recommend(ctx(LEARNED), CATALOG, history);
		expect(d.ranking[0]).toMatchObject({ model: c0.model, n: 5 });
		expect(d.ranking[1]).toEqual({
			model: c1.model,
			effort: c1.effort,
			estimate: 3 / 5,
			n: 3,
		});
	});
});

describe("reason", () => {
	test("is one non-empty sentence for every path", () => {
		const cases: Decision[] = [
			recommend(ctx(LEARNED, { criticality: "security" }), CATALOG, []),
			recommend(ctx(0.05), CATALOG, []),
			recommend(ctx(0.15), CATALOG, [stat(c2, 5, 5)]),
			recommend(ctx(LEARNED), CATALOG, [stat(c2, 5, 5)]),
			recommend(ctx(LEARNED), CATALOG, [stat(c2, 5, 1)]),
			recommend(ctx(LEARNED), CATALOG, []),
			recommend(ctx(LEARNED, { best_candidate: null }), CATALOG, []),
		];
		for (const d of cases) {
			expect(d.reason.length).toBeGreaterThan(0);
			expect(d.reason).toMatch(/[.]$/);
			expect(d.reason).not.toMatch(/[.!?]\s+\S/);
			expect(d.reason).not.toContain("\n");
		}
	});
});
