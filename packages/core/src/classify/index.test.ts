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
	candidate(
		"anthropic/claude-sonnet-5.5",
		"low",
		"Günstig, für einfache Arbeit.",
	),
	candidate("anthropic/claude-opus-5.5", "high", "Stärkstes Modell, teuer."),
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
		// Literal copy of the spec table "task_type | Beschreibung für Jev".
		const spec = {
			"code.bugfix":
				"Ein Fehler im bestehenden Code wird gefunden und behoben.",
			"code.feature": "Neuer Code fügt eine Funktion hinzu.",
			"code.refactor":
				"Der Code ändert seine Struktur, das Verhalten bleibt gleich.",
			"code.explain": "Der Agent erklärt Code und ändert nichts.",
			review:
				"Der Agent prüft fremde Arbeit: ein Review oder eine Verifikation.",
			spec: "Der Agent schreibt oder ändert eine Spezifikation.",
			planning:
				"Der Agent plant Schritte, Architektur oder Vorgehen ohne Code.",
			other: "Keine der anderen Optionen passt.",
		};
		expect(q.criteria).toEqual(spec);
		expect(TASK_TYPE_DESCRIPTIONS).toEqual(spec);
	});

	test("difficulty is a score with the rubric in order leicht, mittel, schwer", () => {
		const q = request.questions.difficulty;
		expect(q.type).toBe("score");
		expect(q.criteria).toHaveLength(3);
		expect(q.criteria[0]).toStartWith("leicht");
		expect(q.criteria[0]).toContain(
			"Klarer Auftrag mit wenig Kontext. Ein Ort oder ein Thema.",
		);
		expect(q.criteria[1]).toStartWith("mittel");
		expect(q.criteria[1]).toContain(
			"Mehrere Stellen oder Themen. Der Weg braucht etwas Analyse.",
		);
		expect(q.criteria[2]).toStartWith("schwer");
		expect(q.criteria[2]).toContain(
			"Viele Teile, eine unklare Ursache, eine Entwurfsentscheidung oder viel Kontext.",
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
		expect(q.criteria.none).toContain("Auch sichtbare Fehler gehören hierher.");
		expect(q.criteria.business_logic).toBe(
			"Geld, Preise, Abrechnung, Verträge oder rechtliche Regeln.",
		);
		expect(q.criteria.security).toBe(
			"Anmeldung, Berechtigungen, Geheimnisse oder Schwachstellen.",
		);
		expect(q.criteria.data_integrity).toBe(
			"Gespeicherte Daten: Migrationen, Löschen oder Schutz vor Datenverlust.",
		);
	});

	test("best_candidate labels are candidate keys with the candidate descriptions", () => {
		const q = request.questions.best_candidate;
		expect(q.type).toBe("choice");
		expect(q.criteria).toEqual({
			"anthropic/claude-sonnet-5.5:low": "Günstig, für einfache Arbeit.",
			"anthropic/claude-opus-5.5:high": "Stärkstes Modell, teuer.",
		});
	});
});

describe("parseJevResult", () => {
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
			difficulty: "mittel",
			criticality: "none",
			best_candidate: "anthropic/claude-sonnet-5.5:low",
			probabilities: {
				task_type: { "code.bugfix": 0.9, other: 0.1 },
				difficulty: { leicht: 0.1, mittel: 0.7, schwer: 0.2 },
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
			"mittel",
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
		[{ leicht: 0.8, mittel: 0.1, schwer: 0.1 }, "leicht"],
		[{ leicht: 0.5, mittel: 0.3, schwer: 0.2 }, "leicht"],
		[{ leicht: 0.45, mittel: 0.3, schwer: 0.25 }, "mittel"],
		[{ leicht: 0.1, mittel: 0.6, schwer: 0.3 }, "mittel"],
		[{ leicht: 0.3, mittel: 0.4, schwer: 0.3 }, "schwer"],
		[{ leicht: 0.3, mittel: 0.3, schwer: 0.4 }, "schwer"],
		[{ leicht: 0, mittel: 0, schwer: 1 }, "schwer"],
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
				difficulty: "mittel",
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
