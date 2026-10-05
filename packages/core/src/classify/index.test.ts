import { afterEach, describe, expect, test } from "bun:test";
import {
	APITimeoutError,
	AuthenticationError,
	RateLimitError,
	type TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { JevClient, JevRequest, JevResult } from "../contracts/deps.ts";
import {
	type Candidate,
	type Catalog,
	type Config,
	DEFAULT_TUNING,
	JEV_MODEL,
} from "../contracts/types.ts";
import {
	buildJevRequest,
	classify,
	createJevClient,
	parseJevResult,
	roundUpDifficulty,
	TASK_TYPE_DESCRIPTIONS,
} from "./index.ts";

function candidate(
	model: string,
	effort: Candidate["effort"],
	description: string,
): Candidate {
	return {
		model,
		effort,
		requested_id: model,
		known: true,
		price_prompt: 0.000001,
		price_completion: 0.000005,
		context_length: 200000,
		description,
	};
}

const catalog: Catalog = [
	candidate("anthropic/claude-sonnet-5.5", "low", "Cheap, for simple work."),
	candidate("anthropic/claude-opus-5.5", "high", "Strongest model, expensive."),
];

const config: Config = {
	jevEnabled: true,
	tuning: DEFAULT_TUNING,
	aliases: {},
	descriptions: {},
};

function jevResult(overrides: Partial<JevResult["answers"]> = {}): JevResult {
	return {
		model: "jev-1.13.0",
		answers: {
			task_type: {
				type: "choice",
				choice: "code.bugfix",
				confidence: 1,
				probabilities: { "code.bugfix": 0.9, other: 0.1 },
			},
			difficulty: {
				type: "score",
				score: 0,
				confidence: 1,
				probabilities: { "0": 0.8, "1": 0.15, "2": 0.05 },
			},
			criticality: {
				type: "choice",
				choice: "none",
				confidence: 0.9,
				probabilities: { none: 0.9, security: 0.1 },
			},
			best_candidate: {
				type: "choice",
				choice: "anthropic/claude-sonnet-5.5:low",
				confidence: 0.93,
				probabilities: {
					"anthropic/claude-sonnet-5.5:low": 0.93,
					"anthropic/claude-opus-5.5:high": 0.07,
				},
			},
			...overrides,
		},
		usage: { input_tokens: 815, output_tokens: 239 },
	};
}

function fakeJev(
	answer: () => Promise<JevResult>,
): JevClient & { calls: { request: JevRequest; timeout?: number }[] } {
	const calls: { request: JevRequest; timeout?: number }[] = [];
	return {
		calls,
		systemOne(request, options) {
			calls.push({ request, timeout: options?.timeout });
			return answer();
		},
	};
}

describe("buildJevRequest", () => {
	const request = buildJevRequest("Fix the pagination bug", catalog);

	test("pins the model and sends the task as state", () => {
		expect(request.model).toBe("jev-1.13.0");
		expect(request.model).toBe(JEV_MODEL);
		expect(request.state).toBe("Fix the pagination bug");
	});

	test("asks exactly four questions", () => {
		expect(Object.keys(request.questions).sort()).toEqual([
			"best_candidate",
			"criticality",
			"difficulty",
			"task_type",
		]);
	});

	test("task_type is a choice over the 8 options with the spec descriptions", () => {
		const q = request.questions.task_type;
		expect(q.type).toBe("choice");
		// Literal copy of the spec table "task_type | Description for Jev".
		const spec = {
			"code.bugfix": "Find and fix a bug in existing code.",
			"code.feature": "Add a feature with new code.",
			"code.refactor":
				"Change the code structure without changing its behavior.",
			"code.explain": "Explain code without changing it.",
			review: "Review or verify someone else's work.",
			spec: "Write or change a specification.",
			planning: "Plan steps, architecture or an approach without writing code.",
			other: "None of the other options fits.",
		};
		expect(q.criteria).toEqual(spec);
		expect(TASK_TYPE_DESCRIPTIONS).toEqual(spec);
	});

	test("difficulty is a score with the rubric in order easy, medium, hard", () => {
		const q = request.questions.difficulty;
		expect(q.type).toBe("score");
		expect(q.criteria).toHaveLength(3);
		expect(q.criteria[0]).toStartWith("easy");
		expect(q.criteria[0]).toContain(
			"A clear task with little context. One place or one topic.",
		);
		expect(q.criteria[1]).toStartWith("medium");
		expect(q.criteria[1]).toContain(
			"Several places or topics. The approach needs some analysis.",
		);
		expect(q.criteria[2]).toStartWith("hard");
		expect(q.criteria[2]).toContain(
			"Many parts, an unclear cause, a design decision or much context.",
		);
	});

	test("criticality is a choice over 4 options; none includes visible bugs", () => {
		const q = request.questions.criticality;
		expect(q.type).toBe("choice");
		expect(Object.keys(q.criteria)).toEqual([
			"none",
			"business_logic",
			"security",
			"data_integrity",
		]);
		expect(q.criteria.none).toContain("Visible bugs also belong here.");
		expect(q.criteria.business_logic).toBe(
			"Money, prices, billing, contracts or legal rules.",
		);
		expect(q.criteria.security).toBe(
			"Login, permissions, secrets or vulnerabilities.",
		);
		expect(q.criteria.data_integrity).toBe(
			"Stored data: migrations, deletion or protection against data loss.",
		);
	});

	test("best_candidate labels are candidate keys with the candidate descriptions", () => {
		const q = request.questions.best_candidate;
		expect(q.type).toBe("choice");
		expect(q.criteria).toEqual({
			"anthropic/claude-sonnet-5.5:low": "Cheap, for simple work.",
			"anthropic/claude-opus-5.5:high": "Strongest model, expensive.",
		});
	});
});

describe("parseJevResult", () => {
	test("accepts legacy and English probability keys and returns only English keys", () => {
		for (const probabilities of [
			{ leicht: 0.1, mittel: 0.7, schwer: 0.2 },
			{ easy: 0.1, medium: 0.7, hard: 0.2 },
			{ easy: 0.1, medium: 0.7, hard: 0.2, leicht: 0.9, mittel: 0, schwer: 0 },
		] as Record<string, number>[]) {
			const result = jevResult();
			result.answers.difficulty.probabilities = probabilities;
			const parsed = parseJevResult(result, catalog, DEFAULT_TUNING);
			expect(parsed.difficulty).toBe("medium");
			expect(parsed.probabilities?.difficulty).toEqual({
				easy: 0.1,
				medium: 0.7,
				hard: 0.2,
			});
		}
		expect(
			roundUpDifficulty({ leicht: 0.3, mittel: 0.4, schwer: 0.3 }, 0.5),
		).toBe("hard");
	});

	test("maps answers, difficulty keys and keeps all probabilities", () => {
		const result = jevResult({
			difficulty: {
				type: "score",
				score: 1,
				confidence: 0.7,
				probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
			},
		});
		expect(parseJevResult(result, catalog, DEFAULT_TUNING)).toEqual({
			task_type: "code.bugfix",
			difficulty: "medium",
			criticality: "none",
			best_candidate: "anthropic/claude-sonnet-5.5:low",
			probabilities: {
				task_type: { "code.bugfix": 0.9, other: 0.1 },
				difficulty: { easy: 0.1, medium: 0.7, hard: 0.2 },
				criticality: { none: 0.9, security: 0.1 },
				best_candidate: {
					"anthropic/claude-sonnet-5.5:low": 0.93,
					"anthropic/claude-opus-5.5:high": 0.07,
				},
			},
			model_ref: "jev-1.13.0",
			fallback_used: false,
			fallback_reason: null,
		});
	});

	test("model_ref is the model reported by the result", () => {
		const result = { ...jevResult(), model: "jev-1.13.0-x" };
		expect(parseJevResult(result, catalog, DEFAULT_TUNING).model_ref).toBe(
			"jev-1.13.0-x",
		);
	});

	test("applies the round-up rule to difficulty", () => {
		const result = jevResult({
			difficulty: {
				type: "score",
				score: 0.8,
				confidence: 0.45,
				probabilities: { "0": 0.45, "1": 0.3, "2": 0.25 },
			},
		});
		expect(parseJevResult(result, catalog, DEFAULT_TUNING).difficulty).toBe(
			"medium",
		);
	});

	test("best_candidate is null when Jev picks a key outside the catalog", () => {
		const result = jevResult({
			best_candidate: {
				type: "choice",
				choice: "openai/gpt-6-sol:medium",
				confidence: 1,
				probabilities: { "openai/gpt-6-sol:medium": 1 },
			},
		});
		expect(
			parseJevResult(result, catalog, DEFAULT_TUNING).best_candidate,
		).toBeNull();
	});
});

describe("roundUpDifficulty", () => {
	test.each([
		[{ easy: 0.8, medium: 0.1, hard: 0.1 }, "easy"],
		[{ easy: 0.5, medium: 0.3, hard: 0.2 }, "easy"],
		[{ easy: 0.45, medium: 0.3, hard: 0.25 }, "medium"],
		[{ easy: 0.1, medium: 0.6, hard: 0.3 }, "medium"],
		[{ easy: 0.3, medium: 0.4, hard: 0.3 }, "hard"],
		[{ easy: 0.3, medium: 0.3, hard: 0.4 }, "hard"],
		[{ easy: 0, medium: 0, hard: 1 }, "hard"],
	] as const)("%p -> %p", (probabilities, expected) => {
		expect(roundUpDifficulty(probabilities, 0.5)).toBe(expected);
	});
});

describe("classify", () => {
	test("calls Jev with the tuned timeout and returns its classification", async () => {
		const jev = fakeJev(async () => jevResult());
		const result = await classify("Fix the bug", catalog, jev, config);
		expect(jev.calls).toHaveLength(1);
		expect(jev.calls[0]?.timeout).toBe(1000);
		expect(jev.calls[0]?.request.model).toBe("jev-1.13.0");
		expect(jev.calls[0]?.request.state).toBe("Fix the bug");
		expect(result.task_type).toBe("code.bugfix");
		expect(result.fallback_used).toBe(false);
	});

	test("timeout follows tuning.jevTimeoutMs", async () => {
		const jev = fakeJev(async () => jevResult());
		await classify("Fix the bug", catalog, jev, {
			...config,
			tuning: { ...DEFAULT_TUNING, jevTimeoutMs: 1234 },
		});
		expect(jev.calls[0]?.timeout).toBe(1234);
	});

	test.each([
		["timeout", (): unknown => new APITimeoutError(1000)],
		["auth", (): unknown => new AuthenticationError(401, {}, new Headers())],
		["rate_limit", (): unknown => new RateLimitError(429, {}, new Headers())],
		["error", (): unknown => new Error("boom")],
		["error", (): unknown => "not even an error"],
	] as const)(
		"Jev error -> rules fallback with reason %p",
		async (reason, makeError) => {
			const jev = fakeJev(() => Promise.reject(makeError()));
			const result = await classify("Fix the login page", catalog, jev, config);
			expect(result).toEqual({
				task_type: "other",
				difficulty: "medium",
				criticality: "security",
				best_candidate: null,
				probabilities: null,
				model_ref: null,
				fallback_used: true,
				fallback_reason: reason,
			});
		},
	);

	test("a malformed Jev result falls back instead of throwing", async () => {
		const jev = fakeJev(async () => ({ model: "jev-1.13.0" }) as JevResult);
		const result = await classify("Fix the bug", catalog, jev, config);
		expect(result.fallback_used).toBe(true);
		expect(result.fallback_reason).toBe("error");
	});

	test("opt-out skips Jev", async () => {
		const jev = fakeJev(async () => jevResult());
		const result = await classify("Fix the bug", catalog, jev, {
			...config,
			jevEnabled: false,
		});
		expect(jev.calls).toHaveLength(0);
		expect(result.fallback_reason).toBe("opt_out");
		expect(result.fallback_used).toBe(true);
	});

	test("no client -> no_key", async () => {
		const result = await classify("Fix the bug", catalog, null, config);
		expect(result.fallback_reason).toBe("no_key");
	});

	test("a secret in the task skips Jev", async () => {
		const jev = fakeJev(async () => jevResult());
		const result = await classify(
			"Deploy with password=hunter2",
			catalog,
			jev,
			config,
		);
		expect(jev.calls).toHaveLength(0);
		expect(result.fallback_reason).toBe("secret");
		expect(result.criticality).toBe("security");
	});

	test.each([
		[`Push with ghp_${"A1b2".repeat(9)} to the repo`],
		['Use the config {"password":"hunter2"} for staging'],
		["Call the API with xoxb-1234567890-abcdefghij"],
	])("token prefix or quoted secret never reaches Jev: %p", async (task) => {
		const jev = fakeJev(async () => jevResult());
		const result = await classify(task, catalog, jev, config);
		expect(jev.calls).toHaveLength(0);
		expect(result.fallback_reason).toBe("secret");
	});
});

describe("createJevClient", () => {
	const KEY = "test-key-not-real-0123456789";
	const realFetch = globalThis.fetch;
	const savedEnv = process.env.TYPESAFE_API_KEY;
	afterEach(() => {
		globalThis.fetch = realFetch;
		if (savedEnv === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = savedEnv;
	});

	function stubFetch(response: () => Response) {
		const calls: { url: string; init?: RequestInit }[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return response();
		}) as typeof fetch;
		return calls;
	}

	test("passes the key explicitly, pins the model, logs nothing, never retries", async () => {
		delete process.env.TYPESAFE_API_KEY;
		const calls = stubFetch(
			() =>
				new Response(JSON.stringify({ error: "rate" }), {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);
		const client = createJevClient(KEY) as unknown as TypeSafeClient;
		expect(client.logLevel).toBe("off");
		expect(client.retry.maxRetries).toBe(0);
		expect(client.defaultModel).toBe("jev-1.13.0");

		const logged: unknown[] = [];
		const methods = ["log", "info", "warn", "error", "debug"] as const;
		const saved = methods.map((m) => console[m]);
		for (const m of methods)
			console[m] = (...args: unknown[]) => logged.push(args);
		let error: unknown;
		try {
			await (client as unknown as JevClient).systemOne(
				buildJevRequest("Fix the bug", catalog),
				{ timeout: 1000 },
			);
		} catch (e) {
			error = e;
		} finally {
			methods.forEach((m, i) => {
				console[m] = saved[i] as never;
			});
		}

		expect(error).toBeInstanceOf(RateLimitError);
		expect(calls).toHaveLength(1);
		expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
			`Bearer ${KEY}`,
		);
		expect(logged).toHaveLength(0);
		expect(Bun.inspect(error)).not.toContain(KEY);
	});

	test("the key does not appear in the returned client", () => {
		const client = createJevClient(KEY);
		expect(Bun.inspect(client)).not.toContain(KEY);
		expect(JSON.stringify(client)).not.toContain(KEY);
	});
});
