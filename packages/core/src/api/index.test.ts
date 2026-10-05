import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CoreDeps,
	JevClient,
	JevRequest,
	JevResult,
	Store,
} from "../contracts/deps.ts";
import {
	type Config,
	DEFAULT_TUNING,
	type ReportResult,
	type StatsReport,
} from "../contracts/types.ts";
import { openStore } from "../store/index.ts";
import { createApi } from "./index.ts";

const OPENROUTER_FIXTURE = join(
	import.meta.dir,
	"../catalog/fixtures/openrouter-models.json",
);
const IDS = [
	"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
	"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
	"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
	"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
	"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
	"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
] as const;
const [ID1, ID2] = IDS;
const SESSION = "5e550000-0000-4000-8000-000000000001";
const PROMPT = "9f000000-0000-4000-8000-000000000001";
// luna:low is the cheapest pair, opus:high the most expensive.
const MODELS = "claude-opus-5-5:high,gpt-6-luna:low";
const T0 = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const WRITES = [
	"insertSuggestion",
	"linkSession",
	"touch",
	"closeSuggestion",
	"insertSignal",
	"upsertUsage",
	"rewriteScope",
];

const config = (over: Partial<Config> = {}): Config => ({
	jevEnabled: true,
	tuning: DEFAULT_TUNING,
	aliases: {},
	descriptions: {},
	...over,
});

function jevResult(best = "openai/gpt-6-luna:low"): JevResult {
	return {
		model: "jev-1.13.0",
		answers: {
			task_type: {
				type: "choice",
				choice: "code.bugfix",
				confidence: 0.9,
				probabilities: { "code.bugfix": 0.9, other: 0.1 },
			},
			difficulty: {
				type: "score",
				score: 0,
				confidence: 0.8,
				probabilities: { "0": 0.8, "1": 0.15, "2": 0.05 },
			},
			criticality: {
				type: "choice",
				choice: "none",
				confidence: 0.95,
				probabilities: { none: 0.95, security: 0.05 },
			},
			best_candidate: {
				type: "choice",
				choice: best,
				confidence: 0.7,
				probabilities: { [best]: 0.7 },
			},
		},
		usage: { input_tokens: 10, output_tokens: 4 },
	};
}

function fakeJev(): JevClient & { requests: JevRequest[] } {
	const requests: JevRequest[] = [];
	return {
		requests,
		systemOne: async (request) => {
			requests.push(request);
			return jevResult();
		},
	};
}

type Call = [method: string, args: unknown[]];

/** Real in-memory store that records every call; dispose is a no-op so data survives between api calls. */
function spyStore(): { store: Store; calls: Call[] } {
	const real = openStore(":memory:");
	const calls: Call[] = [];
	const store = Object.fromEntries(
		Object.entries(real).map(([name, fn]) => [
			name,
			(...args: unknown[]) => {
				calls.push([name, args]);
				if (name === "dispose") return undefined;
				if (name === "rewriteScope") {
					// The real store upserts these rows internally: record them as upsertUsage calls.
					const [scope, rows] = args as Parameters<Store["rewriteScope"]>;
					return real.rewriteScope(scope, (windows) => {
						const out = rows(windows);
						for (const u of out) calls.push(["upsertUsage", [u]]);
						return out;
					});
				}
				return (fn as (...a: unknown[]) => unknown)(...args);
			},
		]),
	) as unknown as Store;
	return { store, calls };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "spatz-api-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function setup(over: Partial<CoreDeps> = {}) {
	const { store, calls } = spyStore();
	let now = T0;
	let idIndex = 0;
	const fetched: string[] = [];
	let draws = 0;
	const deps: CoreDeps = {
		env: {},
		homeDir: dir,
		cwd: dir,
		dbPath: join(dir, "spatz.db"),
		openRouterCachePath: join(dir, "openrouter-models.json"),
		duckdbExtensionDir: join(dir, "ext"),
		fetch: async (url) => {
			fetched.push(url);
			return new Response(Bun.file(OPENROUTER_FIXTURE));
		},
		jev: null,
		clock: { now: () => now },
		random: () => {
			draws++;
			return 0.5;
		},
		newId: () => IDS[idIndex++] as string,
		openStore: () => store,
		config: config(),
		...over,
	};
	return {
		deps,
		api: createApi(deps),
		store,
		calls,
		fetched,
		draws: () => draws,
		setNow: (t: number) => {
			now = t;
		},
		writes: () => calls.filter(([m]) => WRITES.includes(m)),
		argsOf: (method: string) =>
			calls.filter(([m]) => m === method).map(([, a]) => a),
	};
}

const suggestInput = (
	task = "Fix the off-by-one in the pagination helper",
) => ({
	task,
	models: MODELS,
	dryRun: false,
});

describe("suggest", () => {
	test("runs the pipeline with Jev and stores the suggestion without task text", async () => {
		const jev = fakeJev();
		const s = setup({ jev });
		const task = "Fix the off-by-one in the pagination helper";

		const out = await s.api.suggest(suggestInput(task));

		expect(out).toEqual({
			models_source: "flag",
			suggestion_id: ID1,
			ranking: [
				{ model: "openai/gpt-6-luna", effort: "low", estimate: 0.5, n: 0 },
				{
					model: "anthropic/claude-opus-5.5",
					effort: "high",
					estimate: 0.5,
					n: 0,
				},
			],
			reason: expect.any(String),
			classification: {
				task_type: "code.bugfix",
				difficulty: "easy",
				criticality: "none",
			},
			fallback_used: false,
			explored: false,
			control: false,
			strategy: "jev-choice",
			is_test: false,
		});
		expect(s.fetched).toEqual(["https://openrouter.ai/api/v1/models"]);
		expect(s.draws()).toBe(1);
		expect(jev.requests).toHaveLength(1);
		expect(jev.requests[0]?.state).toBe(task);
		expect(s.argsOf("cellStats")).toEqual([["code.bugfix"]]);

		const [[record]] = s.argsOf("insertSuggestion") as [[unknown]];
		expect(record).toEqual({
			id: ID1,
			created_at: T0,
			scope: null,
			agent: null,
			turn_id: null,
			agent_id: null,
			session_id: null,
			prompt_id: null,
			task_type: "code.bugfix",
			difficulty: "easy",
			criticality: "none",
			probabilities: expect.objectContaining({
				difficulty: { easy: 0.8, medium: 0.15, hard: 0.05 },
			}),
			model_ref: "jev-1.13.0",
			strategy: "jev-choice",
			ranking: out.ranking,
			reason: out.reason,
			explored: false,
			control: false,
			fallback_used: false,
			fallback_reason: null,
			is_test: false,
			last_event_at: T0,
			closed_at: null,
		});
		expect(JSON.stringify(s.calls)).not.toContain(task);
		expect(JSON.stringify(s.store.getSuggestion(ID1))).not.toContain(task);
	});

	test("--dry-run sets is_test", async () => {
		const s = setup();
		const out = await s.api.suggest({ ...suggestInput(), dryRun: true });
		expect(out.is_test).toBe(true);
		expect(s.store.getSuggestion(ID1)?.is_test).toBe(true);
	});

	test("a hanging OpenRouter request is bounded by openRouterTimeoutMs", async () => {
		const s = setup({
			fetch: () => new Promise<Response>(() => {}),
			config: config({
				tuning: { ...DEFAULT_TUNING, openRouterTimeoutMs: 20 },
			}),
		});
		const r = await s.api.suggest(suggestInput());
		expect(r.ranking.length).toBeGreaterThan(0);
	});

	test("OpenRouter list is cached for 24 h", async () => {
		const s = setup();
		await s.api.suggest(suggestInput());
		s.setNow(T0 + 24 * HOUR - 1);
		await s.api.suggest(suggestInput());
		expect(s.fetched).toHaveLength(1);
		s.setNow(T0 + 24 * HOUR);
		await s.api.suggest(suggestInput());
		expect(s.fetched).toHaveLength(2);
	});

	test("without Jev: fallback_used and strategy rules (most expensive pair)", async () => {
		const s = setup({ jev: null });
		const out = await s.api.suggest(suggestInput());
		expect(out.fallback_used).toBe(true);
		expect(out.strategy).toBe("rules");
		expect(out.ranking[0]).toMatchObject({
			model: "anthropic/claude-opus-5.5",
			effort: "high",
		});
		expect(out.classification).toEqual({
			task_type: "other",
			difficulty: "medium",
			criticality: "none",
		});
	});

	test("without Jev and a control draw: strategy strongest, control true", async () => {
		const s = setup({ jev: null, random: () => 0.05 });
		const out = await s.api.suggest(suggestInput());
		expect(out.fallback_used).toBe(true);
		expect(out.strategy).toBe("strongest");
		expect(out.control).toBe(true);
	});

	test("opt-out: Jev is not called and nothing stored contains the task", async () => {
		const jev = fakeJev();
		const s = setup({ jev, config: config({ jevEnabled: false }) });
		const task = "Refactor the very-private-feature module";
		const out = await s.api.suggest(suggestInput(task));
		expect(jev.requests).toHaveLength(0);
		expect(out.fallback_used).toBe(true);
		expect(JSON.stringify(s.calls)).not.toContain(task);
	});

	test("secret in the task: Jev is not called and nothing stored contains the task", async () => {
		const jev = fakeJev();
		const s = setup({ jev });
		const task = "Rotate the key password=hunter2hunter2 in config";
		const out = await s.api.suggest(suggestInput(task));
		expect(jev.requests).toHaveLength(0);
		expect(out.fallback_used).toBe(true);
		const stored = JSON.stringify(s.calls);
		expect(stored).not.toContain(task);
		expect(stored).not.toContain("hunter2");
	});

	test("learned history from cellStats drives the next suggestion", async () => {
		const s = setup({ jev: fakeJev() });
		for (let i = 0; i < 5; i++) {
			const { suggestion_id } = await s.api.suggest(suggestInput());
			await s.api.report({
				suggestionId: suggestion_id,
				model: "gpt-6-luna",
				effort: "low",
				result: "pass",
			});
		}
		const out = await s.api.suggest(suggestInput());
		expect(out.strategy).toBe("learned");
		expect(out.ranking[0]).toEqual({
			model: "openai/gpt-6-luna",
			effort: "low",
			estimate: 6 / 7,
			n: 5,
		});
	});

	test("invalid --models throws", async () => {
		const s = setup();
		await expect(
			s.api.suggest({ ...suggestInput(), models: "gpt-6-sol:turbo" }),
		).rejects.toThrow();
		expect(s.writes()).toEqual([]);
	});
});

describe("report", () => {
	test("canonicalizes the model, upserts usage, inserts the report signal, closes, returns the outcome", async () => {
		const s = setup();
		await s.api.suggest(suggestInput());
		s.setNow(T0 + 1000);

		const outcome = await s.api.report({
			suggestionId: ID1,
			model: "claude-opus-5-5",
			effort: "high",
			result: "partial",
			rounds: 2,
			note: "needed a second try",
		});

		expect(s.argsOf("upsertUsage")).toEqual([
			[
				{
					suggestion_id: ID1,
					model: "anthropic/claude-opus-5.5",
					effort: "high",
					source: "report",
					scope_key: "",
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
					is_sidechain: false,
					rounds: 2,
					note: "needed a second try",
					reported_at: T0 + 1000,
				},
			],
		]);
		expect(s.argsOf("insertSignal")).toEqual([
			[
				{
					suggestion_id: ID1,
					kind: "report",
					value: 0.5,
					weight: 1,
					source: "report",
					observed_at: T0 + 1000,
					model: "anthropic/claude-opus-5.5",
					effort: "high",
				},
			],
		]);
		expect(s.argsOf("closeSuggestion")).toEqual([[ID1, T0 + 1000]]);
		expect(s.store.getSuggestion(ID1)?.closed_at).toBe(T0 + 1000);
		expect(outcome).toEqual({
			suggestion_id: ID1,
			quality: 0.5,
			model: "anthropic/claude-opus-5.5",
			effort: "high",
		});
	});

	test.each([
		["pass", 1],
		["fail", 0],
	] as const)(
		"result %s -> signal value %d, rounds/note default null",
		async (result, value) => {
			const s = setup();
			await s.api.suggest(suggestInput());
			await s.api.report({
				suggestionId: ID1,
				model: "gpt-6-luna",
				effort: "low",
				result,
			});
			const [[signal]] = s.argsOf("insertSignal") as [[{ value: number }]];
			expect(signal.value).toBe(value);
			const [[usage]] = s.argsOf("upsertUsage") as [[object]];
			expect(usage).toMatchObject({
				model: "openai/gpt-6-luna",
				rounds: null,
				note: null,
			});
		},
	);

	test("rejects an effort outside none..ultra without writing", async () => {
		const s = setup();
		await s.api.suggest(suggestInput());
		const before = s.writes().length;
		await expect(
			s.api.report({
				suggestionId: ID1,
				model: "gpt-6-luna",
				effort: "turbo",
				result: "pass",
			}),
		).rejects.toThrow(/effort/);
		expect(s.writes()).toHaveLength(before);
	});

	test.each(["bogus", "toString", "constructor", "__proto__", "valueOf"])(
		"rejects result %p (incl. inherited property names) without writing",
		async (result) => {
			const s = setup();
			await s.api.suggest(suggestInput());
			const before = s.writes().length;
			await expect(
				s.api.report({
					suggestionId: ID1,
					model: "gpt-6-luna",
					effort: "low",
					// the CLI passes raw argv here; the type does not protect the runtime check
					result: result as ReportResult,
				}),
			).rejects.toThrow(/result/);
			expect(s.writes()).toHaveLength(before);
		},
	);

	test("rejects an unknown suggestion_id without writing", async () => {
		const s = setup();
		await expect(
			s.api.report({
				suggestionId: ID2,
				model: "gpt-6-luna",
				effort: "low",
				result: "pass",
			}),
		).rejects.toThrow(ID2);
		expect(s.writes()).toEqual([]);
	});
});

// ---------- hooks ----------

const base = (over: Record<string, unknown> = {}) => ({
	session_id: SESSION,
	transcript_path: "/nonexistent/main.jsonl",
	cwd: "/tmp/proj",
	prompt_id: PROMPT,
	effort: { level: "high" },
	...over,
});

const bash = (
	command: string,
	stdout = "",
	event: "PostToolUse" | "PostToolUseFailure" = "PostToolUse",
) =>
	JSON.stringify(
		base({
			hook_event_name: event,
			tool_name: "Bash",
			tool_input: { command },
			tool_use_id: "toolu_1",
			...(event === "PostToolUse"
				? { tool_response: { stdout, stderr: "", interrupted: false } }
				: { error: "Exit code 1" }),
		}),
	);

const linkHook = (id: string) =>
	bash(`spatz "fix it" --models ${MODELS}`, `suggestion_id: ${id}\n1. x`);

/** suggest + link to SESSION via the PostToolUse hook. */
async function linked(s: ReturnType<typeof setup>) {
	const { suggestion_id } = await s.api.suggest(suggestInput());
	await s.api.handleHook("PostToolUse", linkHook(suggestion_id));
	return suggestion_id;
}

/** suggest + link to SESSION via the Codex PostToolUse hook of this turn. */
async function codexLinked(s: ReturnType<typeof setup>, turn: string) {
	const { suggestion_id } = await s.api.suggest(suggestInput());
	await s.api.handleHook(
		"codex:PostToolUse",
		JSON.stringify({
			session_id: SESSION,
			turn_id: turn,
			transcript_path: "/nope",
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: `spatz "fix it" --models ${MODELS}` },
			tool_response: `suggestion_id: ${suggestion_id}`,
		}),
	);
	return suggestion_id;
}

const iso = (t: number) => new Date(t).toISOString();
/** Adds a timestamp to every rollout line. */
const stamped = (jsonl: string, at: number) =>
	jsonl
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.stringify({ timestamp: iso(at), ...JSON.parse(l) }))
		.join("\n");
const assistant = (
	id: string,
	model: string,
	output: number,
	extra = {},
	at = T0 + 1000,
) =>
	JSON.stringify({
		type: "assistant",
		timestamp: iso(at),
		message: {
			id,
			model,
			usage: {
				input_tokens: 3,
				output_tokens: output,
				cache_read_input_tokens: 100,
				cache_creation_input_tokens: 7,
			},
		},
		...extra,
	});

describe("handleHook", () => {
	test("Codex command events create outcomes without a report and replay without duplicate signals", async () => {
		const dbPath = join(dir, "recording.db");
		const s = setup({ openStore: () => openStore(dbPath) });
		// The fixture has no timestamps: the turn's own link places it.
		const id = await codexLinked(s, "todo-turn");
		const rollout = await Bun.file(
			`${import.meta.dir}/../signals/fixtures/codex-command-events.jsonl`,
		).text();
		const path = join(dir, "commands.jsonl");
		await Bun.write(path, rollout);
		const stop = JSON.stringify({
			session_id: SESSION,
			turn_id: "todo-turn",
			transcript_path: path,
			hook_event_name: "Stop",
		});
		await s.api.handleHook("codex:Stop", stop);
		const db = new Database(dbPath);
		try {
			expect(
				db
					.query("SELECT quality FROM outcomes WHERE suggestion_id = ?")
					.get(id),
			).toEqual({ quality: 0.8 / 1.8 });
			// A later check succeeds. Replaying the updated snapshot replaces this turn's result.
			await Bun.write(path, rollout.replace('"exit_code":1', '"exit_code":0'));
			s.setNow(T0 + 1000);
			await s.api.handleHook("codex:Stop", stop);
			await s.api.handleHook("codex:Stop", stop);
			expect(
				db
					.query("SELECT kind, value, turn_id FROM signals ORDER BY kind")
					.all(),
			).toEqual([
				{ kind: "build", value: 1, turn_id: "todo-turn" },
				{ kind: "test", value: 1, turn_id: "todo-turn" },
			]);
			expect(
				db.query("SELECT * FROM outcomes WHERE suggestion_id = ?").get(id),
			).toEqual({
				suggestion_id: id,
				quality: 1,
				model: "openai/gpt-6-luna",
				effort: "low",
			});
			expect(db.query("SELECT output_tokens FROM usages").all()).toEqual([
				{ output_tokens: 674 },
			]);
		} finally {
			db.close();
		}
	});
	test("hook diagnostics are opt-in and do not expose input or errors", async () => {
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		try {
			const openStore = () => {
				throw new Error("private database path and secret");
			};
			await setup({ openStore }).api.handleHook(
				"codex:Stop",
				'{"hook_event_name":"Stop"}',
			);
			expect(stderr).not.toHaveBeenCalled();
			await setup({ openStore, env: { SPATZ_DEBUG: "1" } }).api.handleHook(
				"codex:Stop",
				'{"hook_event_name":"Stop"}',
			);
			expect(stderr.mock.calls).toEqual([
				[
					"spatz hook: Recording failed; check hook input, transcript access and database permissions.",
				],
			]);
			stderr.mockClear();
			const path = join(dir, "unknown.jsonl");
			await Bun.write(path, '{"type":"future_rollout_format"}');
			await setup({ env: { SPATZ_DEBUG: "1" } }).api.handleHook(
				"codex:Stop",
				JSON.stringify({
					session_id: SESSION,
					turn_id: "missing",
					transcript_path: path,
					hook_event_name: "Stop",
				}),
			);
			expect(stderr.mock.calls).toEqual([
				[
					"spatz hook: Codex rollout has no matching turn context; check the rollout format.",
				],
			]);
		} finally {
			stderr.mockRestore();
		}
	});
	test("Codex PostToolUse links suggestion with turn_id as prompt id", async () => {
		const s = setup();
		const id = (await s.api.suggest(suggestInput())).suggestion_id;
		await s.api.handleHook(
			"codex:PostToolUse",
			JSON.stringify({
				session_id: SESSION,
				turn_id: PROMPT,
				transcript_path: "/nope",
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_input: { command: `spatz "fix it" --models ${MODELS}` },
				tool_response: `suggestion_id: ${id}`,
			}),
		);
		expect(s.argsOf("linkSession")).toEqual([[id, SESSION, PROMPT, T0]]);
	});
	test("Codex Stop records rollout shell outcomes and cumulative tokens", async () => {
		const s = setup();
		const id = await codexLinked(s, "11111111-1111-1111-1111-111111111111");
		const path = `${import.meta.dir}/../signals/fixtures/codex-rollout.jsonl`;
		const rollout = (await Bun.file(path).text()).replace(
			'cmd:\\"false\\"',
			'cmd:\\"bun test\\"',
		);
		const testPath = join(dir, "codex.jsonl");
		await Bun.write(testPath, rollout);
		await s.api.handleHook(
			"codex:Stop",
			JSON.stringify({
				session_id: SESSION,
				turn_id: "11111111-1111-1111-1111-111111111111",
				transcript_path: testPath,
				hook_event_name: "Stop",
			}),
		);
		expect(s.argsOf("insertSignal").map(([x]) => x)).toEqual([
			{
				suggestion_id: id,
				kind: "test",
				value: 0,
				weight: 1,
				source: "Stop",
				turn_id: "11111111-1111-1111-1111-111111111111",
				observed_at: T0,
			},
		]);
		expect(s.argsOf("rewriteScope")[0]?.[0]).toMatchObject({
			source: "transcript",
			scope_key: "11111111-1111-1111-1111-111111111111",
		});
		const rows = s.argsOf("rewriteScope")[0]?.[1] as (
			windows: { id: string; start: number; end: number }[],
		) => unknown[];
		expect(rows([{ id, start: T0, end: T0 + HOUR }])).toMatchObject([
			{
				suggestion_id: id,
				model: "openai/gpt-6-luna",
				effort: "low",
				input_tokens: 61711,
				output_tokens: 124,
				cache_read_tokens: 48128,
			},
		]);
	});
	test("never throws: invalid JSON, unknown event, missing transcript, store errors", async () => {
		const s = setup();
		await expect(
			s.api.handleHook("Stop", "{not json"),
		).resolves.toBeUndefined();
		await expect(
			s.api.handleHook(
				"Bogus",
				JSON.stringify(base({ hook_event_name: "Bogus" })),
			),
		).resolves.toBeUndefined();
		await linked(s);
		await expect(
			s.api.handleHook(
				"Stop",
				JSON.stringify(
					base({ hook_event_name: "Stop", stop_hook_active: false }),
				),
			),
		).resolves.toBeUndefined();

		const broken = setup({
			openStore: () => {
				throw new Error("disk full");
			},
		});
		await expect(
			broken.api.handleHook("PostToolUse", bash("bun test")),
		).resolves.toBeUndefined();

		const failing = setup();
		failing.store.findOpenSuggestion = () => {
			throw new Error("SQLITE_BUSY");
		};
		await expect(
			failing.api.handleHook("PostToolUse", bash("bun test")),
		).resolves.toBeUndefined();
	});

	test("PostToolUse Bash with a spatz suggest call links the session and closes the previous open suggestion", async () => {
		const s = setup();
		const first = await linked(s);
		expect(s.argsOf("linkSession")).toEqual([[first, SESSION, PROMPT, T0]]);

		s.setNow(T0 + 5000);
		const second = await linked(s);
		expect(s.argsOf("linkSession")[1]).toEqual([
			second,
			SESSION,
			PROMPT,
			T0 + 5000,
		]);
		expect(s.store.getSuggestion(first)?.closed_at).toBe(T0 + 5000);
		expect(s.store.findOpenSuggestion(SESSION, T0 + 5000, HOUR)).toBe(second);
	});

	test.each([
		["PostToolUse", "bun test packages/core", "test", 1, 1],
		["PostToolUseFailure", "bun test packages/core", "test", 0, 1],
		["PostToolUse", "bun run build", "build", 1, 0.8],
		["PostToolUseFailure", "bun run build", "build", 0, 0.8],
	] as const)(
		"%s Bash %p -> signal %s value %d weight %d on the open suggestion, touch",
		async (event, command, kind, value, weight) => {
			const s = setup();
			const id = await linked(s);
			s.setNow(T0 + 1000);
			await s.api.handleHook(event, bash(command, "", event));
			expect(s.argsOf("findOpenSuggestion")).toContainEqual([
				SESSION,
				T0 + 1000,
				7_200_000,
			]);
			expect(s.argsOf("insertSignal")).toEqual([
				[
					{
						suggestion_id: id,
						kind,
						value,
						weight,
						source: event,
						observed_at: T0 + 1000,
					},
				],
			]);
			expect(s.argsOf("touch")).toContainEqual([id, T0 + 1000]);
			expect(s.store.getSuggestion(id)?.last_event_at).toBe(T0 + 1000);
		},
	);

	test("no open suggestion (none linked, or idle > 2 h) -> nothing written", async () => {
		const s = setup();
		await s.api.handleHook("PostToolUse", bash("bun test"));
		expect(s.writes()).toEqual([]);

		await linked(s);
		const before = s.writes().length;
		s.setNow(T0 + 2 * HOUR + 1);
		await s.api.handleHook("PostToolUse", bash("bun test"));
		expect(s.writes()).toHaveLength(before);
	});

	test("timeout boundary: exactly 2 h idle is still open", async () => {
		const s = setup();
		const id = await linked(s);
		s.setNow(T0 + 2 * HOUR);
		await s.api.handleHook("PostToolUse", bash("bun test"));
		expect(s.argsOf("insertSignal")).toEqual([
			[expect.objectContaining({ suggestion_id: id, kind: "test" })],
		]);
		expect(s.argsOf("touch")).toContainEqual([id, T0 + 2 * HOUR]);
	});

	test("Bash commands that are neither spatz, test nor build only refresh the window", async () => {
		const s = setup();
		const id = await linked(s);
		const before = s.writes().length;
		s.setNow(T0 + 1000);
		await s.api.handleHook("PostToolUse", bash("echo ok", "ok"));
		expect(s.writes().slice(before)).toEqual([["touch", [id, T0 + 1000]]]);
	});

	test("events without a signal keep the suggestion open (2 h counts from the last event)", async () => {
		const s = setup();
		const id = await linked(s);
		s.setNow(T0 + HOUR);
		await s.api.handleHook("PostToolUse", bash("echo ok", "ok"));
		s.setNow(T0 + 2 * HOUR + 1);
		await s.api.handleHook("PostToolUse", bash("bun test"));
		expect(s.argsOf("insertSignal")).toEqual([
			[expect.objectContaining({ suggestion_id: id, kind: "test" })],
		]);
	});

	test("handback events do not refresh the window", async () => {
		const s = setup();
		await linked(s);
		s.setNow(T0 + HOUR);
		await s.api.handleHook(
			"UserPromptSubmit",
			JSON.stringify(
				base({
					hook_event_name: "UserPromptSubmit",
					prompt: "<agent-message from a1>done",
				}),
			),
		);
		await s.api.handleHook(
			"PostToolUse",
			JSON.stringify(
				base({
					hook_event_name: "PostToolUse",
					tool_name: "SubagentHandback",
					tool_input: {},
					tool_response: {},
					tool_use_id: "t",
				}),
			),
		);
		s.setNow(T0 + 2 * HOUR + 1);
		await s.api.handleHook("PostToolUse", bash("bun test"));
		expect(s.argsOf("insertSignal")).toEqual([]);
	});

	test("Stop -> usage per canonical model from the main transcript turn", async () => {
		const s = setup();
		const id = await linked(s);
		const path = join(dir, "main.jsonl");
		await Bun.write(
			path,
			[
				JSON.stringify({ type: "user", promptId: "other-prompt" }),
				assistant("m0", "claude-opus-5-5", 999),
				JSON.stringify({ type: "user", promptId: PROMPT }),
				assistant("m1", "claude-sonnet-5-5", 10),
				assistant("m1", "claude-sonnet-5-5", 10),
				assistant("m2", "gpt-6-luna", 5),
				// same canonical model under its OpenRouter name: must add up, not overwrite
				assistant("m3", "anthropic/claude-sonnet-5.5", 20),
				"not json",
			].join("\n"),
		);
		s.setNow(T0 + 1000);
		await s.api.handleHook(
			"Stop",
			JSON.stringify(
				base({
					hook_event_name: "Stop",
					transcript_path: path,
					stop_hook_active: false,
				}),
			),
		);
		const row = {
			suggestion_id: id,
			effort: "high",
			source: "transcript",
			scope_key: PROMPT,
			is_sidechain: false,
			rounds: null,
			note: null,
			reported_at: T0 + 1000,
		};
		expect(s.argsOf("upsertUsage")).toEqual([
			[
				{
					...row,
					model: "anthropic/claude-sonnet-5.5",
					input_tokens: 6,
					output_tokens: 30,
					cache_read_tokens: 200,
					cache_creation_tokens: 14,
				},
			],
			[
				{
					...row,
					model: "openai/gpt-6-luna",
					input_tokens: 3,
					output_tokens: 5,
					cache_read_tokens: 100,
					cache_creation_tokens: 7,
				},
			],
		]);
		expect(s.argsOf("touch")).toContainEqual([id, T0 + 1000]);
		expect(s.store.outcome(id)).toBeNull(); // usage alone is no outcome
	});

	test("SubagentStop -> usage from the agent transcript, source subagent, sidechain", async () => {
		const s = setup();
		const id = await linked(s);
		const path = join(dir, "agent-a1.jsonl");
		const sub = { isSidechain: true, agentId: "a1" };
		await Bun.write(
			path,
			[
				assistant("s1", "claude-sonnet-5-5", 10, sub),
				assistant("s2", "anthropic/claude-sonnet-5.5", 30, sub),
			].join("\n"),
		);
		await s.api.handleHook(
			"SubagentStop",
			JSON.stringify(
				base({
					hook_event_name: "SubagentStop",
					agent_id: "a1",
					agent_type: "general-purpose",
					stop_hook_active: false,
					agent_transcript_path: path,
					effort: undefined,
				}),
			),
		);
		expect(s.argsOf("upsertUsage")).toEqual([
			[
				expect.objectContaining({
					suggestion_id: id,
					model: "anthropic/claude-sonnet-5.5",
					effort: null,
					source: "subagent",
					scope_key: "a1",
					input_tokens: 6,
					output_tokens: 40,
					is_sidechain: true,
				}),
			],
		]);
		expect(s.argsOf("touch")).toContainEqual([id, T0]);
	});

	const stopHook = (path: string) =>
		JSON.stringify(
			base({
				hook_event_name: "Stop",
				transcript_path: path,
				stop_hook_active: false,
			}),
		);
	const subagentStopHook = (path: string) =>
		JSON.stringify(
			base({
				hook_event_name: "SubagentStop",
				agent_id: "a1",
				agent_type: "general-purpose",
				stop_hook_active: false,
				agent_transcript_path: path,
			}),
		);
	const outputBy = (s: ReturnType<typeof setup>, id: string) =>
		Object.fromEntries(
			s
				.argsOf("upsertUsage")
				.map(
					([u]) =>
						u as {
							suggestion_id: string;
							model: string;
							output_tokens: number;
						},
				)
				.filter((u) => u.suggestion_id === id)
				.map((u) => [u.model, u.output_tokens]),
		);

	test("Stop counts only usage inside the recommendation's time window", async () => {
		const s = setup();
		const id = await linked(s);
		const path = join(dir, "main.jsonl");
		await Bun.write(
			path,
			[
				JSON.stringify({ type: "user", promptId: PROMPT }),
				// same turn, but before spatz created the recommendation
				assistant("m0", "claude-opus-5-5", 999, {}, T0 - 1000),
				assistant("m1", "claude-sonnet-5-5", 10, {}, T0 + 1000),
			].join("\n"),
		);
		s.setNow(T0 + 2000);
		await s.api.handleHook("Stop", stopHook(path));
		expect(outputBy(s, id)).toEqual({ "anthropic/claude-sonnet-5.5": 10 });
	});

	test("two recommendations in one turn each get their own slice (main and subagent)", async () => {
		const s = setup();
		const first = await linked(s);
		s.setNow(T0 + 5000);
		const second = await linked(s);
		const main = join(dir, "main.jsonl");
		const agent = join(dir, "agent-a1.jsonl");
		await Bun.write(
			main,
			[
				JSON.stringify({ type: "user", promptId: PROMPT }),
				assistant("m1", "claude-opus-5-5", 999, {}, T0 + 1000),
				assistant("m2", "claude-sonnet-5-5", 10, {}, T0 + 6000),
			].join("\n"),
		);
		const sub = { isSidechain: true, agentId: "a1" };
		await Bun.write(
			agent,
			[
				assistant("s1", "gpt-6-luna", 7, sub, T0 + 2000),
				assistant("s2", "gpt-6-sol", 3, sub, T0 + 7000),
			].join("\n"),
		);
		s.setNow(T0 + 8000);
		await s.api.handleHook("SubagentStop", subagentStopHook(agent));
		await s.api.handleHook("Stop", stopHook(main));
		expect(outputBy(s, first)).toEqual({
			"anthropic/claude-opus-5.5": 999,
			"openai/gpt-6-luna": 7,
		});
		expect(outputBy(s, second)).toEqual({
			"anthropic/claude-sonnet-5.5": 10,
			"openai/gpt-6-sol": 3,
		});
	});

	test("Stop before a delayed link: the link moves later usage from the earlier recommendation to the newer one", async () => {
		const s = setup();
		const first = await linked(s);
		s.setNow(T0 + 5000);
		const { suggestion_id: second } = await s.api.suggest(suggestInput());
		// Claude Code layout: <dir>/<session>.jsonl and <dir>/<session>/subagents/agent-<id>.jsonl
		const main = join(dir, `${SESSION}.jsonl`);
		const agent = join(dir, SESSION, "subagents", "agent-a1.jsonl");
		await Bun.write(
			main,
			[
				JSON.stringify({ type: "user", promptId: PROMPT }),
				assistant("m1", "claude-opus-5-5", 10, {}, T0 + 1000),
				assistant("m2", "claude-sonnet-5-5", 999, {}, T0 + 6000),
			].join("\n"),
		);
		const sub = { isSidechain: true, agentId: "a1" };
		await Bun.write(
			agent,
			[
				assistant("s1", "gpt-6-luna", 7, sub, T0 + 2000),
				assistant("s2", "gpt-6-sol", 2000, sub, T0 + 6500),
			].join("\n"),
		);
		s.setNow(T0 + 7000);
		const stop = JSON.stringify({
			...JSON.parse(stopHook(main)),
			transcript_path: main,
		});
		await s.api.handleHook("Stop", stop);
		await s.api.handleHook("SubagentStop", subagentStopHook(agent));
		// The async link hook of the second call arrives after Stop.
		s.setNow(T0 + 8000);
		await s.api.handleHook(
			"PostToolUse",
			JSON.stringify({
				...JSON.parse(linkHook(second)),
				transcript_path: main,
			}),
		);
		const pairOf = (id: string) => {
			s.store.insertSignal({
				suggestion_id: id,
				kind: "test",
				value: 1,
				weight: 1,
				source: "PostToolUse",
				observed_at: T0 + 9000,
			});
			return s.store.outcome(id)?.model;
		};
		expect(pairOf(first)).toBe("anthropic/claude-opus-5.5");
		expect(pairOf(second)).toBe("openai/gpt-6-sol");

		// Replaying Stop and SubagentStop after the link keeps the same assignment.
		s.setNow(T0 + 9000);
		await s.api.handleHook("Stop", stop);
		await s.api.handleHook("SubagentStop", subagentStopHook(agent));
		expect(s.store.outcome(first)?.model).toBe("anthropic/claude-opus-5.5");
		expect(s.store.outcome(second)?.model).toBe("openai/gpt-6-sol");
	});

	test("a failing rewrite of a scope rolls back and keeps the earlier usage", async () => {
		const dbPath = join(dir, "spatz.db");
		const s = setup({ dbPath, openStore });
		await linked(s);
		const path = join(dir, "main.jsonl");
		await Bun.write(
			path,
			[
				JSON.stringify({ type: "user", promptId: PROMPT }),
				assistant("m1", "claude-sonnet-5-5", 10),
			].join("\n"),
		);
		await s.api.handleHook("Stop", stopHook(path));
		const raw = new Database(dbPath);
		const count = () =>
			raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usages").get()?.n;
		expect(count()).toBe(1);
		// Every insert into usages fails from now on, like a full disk.
		raw.run(
			"CREATE TRIGGER fail BEFORE INSERT ON usages BEGIN SELECT RAISE(ABORT, 'disk full'); END",
		);
		await s.api.handleHook("Stop", stopHook(path));
		expect(count()).toBe(1);
		raw.close();
	});

	test("a compacted transcript (fewer messages, newer last one) rewrites the scope, and a delayed link then moves its later usage", async () => {
		const s = setup();
		const first = await linked(s);
		s.setNow(T0 + 5000);
		const { suggestion_id: second } = await s.api.suggest(suggestInput());
		const user = JSON.stringify({ type: "user", promptId: PROMPT });
		const long = join(dir, "long.jsonl");
		const compacted = join(dir, "compacted.jsonl");
		await Bun.write(
			long,
			[
				user,
				assistant("m1", "claude-opus-5-5", 10, {}, T0 + 1000),
				assistant("m2", "claude-opus-5-5", 10, {}, T0 + 2000),
				assistant("m3", "claude-opus-5-5", 10, {}, T0 + 3000),
			].join("\n"),
		);
		await Bun.write(
			compacted,
			[user, assistant("m4", "claude-sonnet-5-5", 999, {}, T0 + 6000)].join(
				"\n",
			),
		);
		s.setNow(T0 + 7000);
		await s.api.handleHook("Stop", stopHook(long));
		await s.api.handleHook("Stop", stopHook(compacted));
		expect(outputBy(s, first)).toEqual({
			"anthropic/claude-opus-5.5": 30,
			"anthropic/claude-sonnet-5.5": 999,
		});
		// The delayed link of the second call reconciles from the compacted transcript.
		s.setNow(T0 + 8000);
		await s.api.handleHook(
			"PostToolUse",
			JSON.stringify({
				...JSON.parse(linkHook(second)),
				transcript_path: compacted,
			}),
		);
		const pairOf = (id: string) => {
			s.store.insertSignal({
				suggestion_id: id,
				kind: "test",
				value: 1,
				weight: 1,
				source: "PostToolUse",
				observed_at: T0 + 9000,
			});
			return s.store.outcome(id)?.model;
		};
		expect(pairOf(second)).toBe("anthropic/claude-sonnet-5.5");
		expect(pairOf(first)).not.toBe("anthropic/claude-sonnet-5.5");
	});

	test("an older transcript snapshot that commits last does not replace a newer one", async () => {
		const s = setup();
		const id = await linked(s);
		const turn = [
			JSON.stringify({ type: "user", promptId: PROMPT }),
			assistant("m1", "claude-opus-5-5", 10, {}, T0 + 1000),
		];
		const older = join(dir, "older.jsonl");
		const newer = join(dir, "newer.jsonl");
		await Bun.write(older, turn.join("\n"));
		await Bun.write(
			newer,
			[...turn, assistant("m2", "claude-sonnet-5-5", 999, {}, T0 + 2000)].join(
				"\n",
			),
		);
		// Two hook processes of the same turn: the one with the newer snapshot commits first.
		await s.api.handleHook("Stop", stopHook(newer));
		await s.api.handleHook("Stop", stopHook(older));
		s.store.insertSignal({
			suggestion_id: id,
			kind: "test",
			value: 1,
			weight: 1,
			source: "PostToolUse",
			observed_at: T0 + 3000,
		});
		expect(s.store.outcome(id)?.model).toBe("anthropic/claude-sonnet-5.5");
	});

	test("PostToolUse on Agent -> usage source agent_tool with the resolved model and 0 tokens", async () => {
		const s = setup();
		const id = await linked(s);
		await s.api.handleHook(
			"PostToolUse",
			JSON.stringify(
				base({
					hook_event_name: "PostToolUse",
					tool_name: "Agent",
					tool_input: { prompt: "secret prompt text" },
					tool_response: {
						status: "completed",
						agentId: "a1",
						resolvedModel: "claude-sonnet-5-5",
						content: "agent output text",
					},
					tool_use_id: "toolu_2",
				}),
			),
		);
		expect(s.argsOf("upsertUsage")).toEqual([
			[
				{
					suggestion_id: id,
					model: "anthropic/claude-sonnet-5.5",
					effort: null,
					source: "agent_tool",
					scope_key: "a1",
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
					is_sidechain: true,
					rounds: null,
					note: null,
					reported_at: T0,
				},
			],
		]);
		const stored = JSON.stringify(s.calls);
		expect(stored).not.toContain("secret prompt text");
		expect(stored).not.toContain("agent output text");
	});

	test.each([
		["SessionStart", { source: "startup", prompt_id: undefined }, true],
		["UserPromptSubmit", { prompt: "do the thing" }, true],
		["UserPromptSubmit", { prompt: "<agent-message from a1>done" }, false],
		["SubagentStart", { agent_id: "a1", agent_type: "general-purpose" }, true],
		[
			"PostToolUse",
			{
				tool_name: "SubagentHandback",
				tool_input: {},
				tool_response: {},
				tool_use_id: "t",
			},
			false,
		],
	] as const)(
		"%s writes at most a touch (%o)",
		async (event, fields, touches) => {
			const s = setup();
			const id = await linked(s);
			const before = s.writes().length;
			s.setNow(T0 + 1000);
			await s.api.handleHook(
				event,
				JSON.stringify(base({ hook_event_name: event, ...fields })),
			);
			expect(s.writes().slice(before)).toEqual(
				touches ? [["touch", [id, T0 + 1000]]] : [],
			);
		},
	);
});

describe("stats", () => {
	test("calls runStats with dbPath, extension dir, type and success quality 0.8", async () => {
		const report: StatsReport = {
			by_type: [],
			coverage: 0,
			learned_success: null,
			control_success: null,
			fallbacks: {},
			failures: { parse: 0, hook: 0, launcher: 0 },
		};
		const seen: unknown[] = [];
		const s = setup();
		const api = createApi(s.deps, {
			runStats: async (options) => {
				seen.push(options);
				return report;
			},
		});
		expect(await api.stats({ type: "review" })).toBe(report);
		expect(seen).toEqual([
			{
				dbPath: join(dir, "spatz.db"),
				extensionDir: join(dir, "ext"),
				type: "review",
				successQuality: 0.8,
				noneOnlyModels: ["anthropic/claude-haiku-4.5"],
			},
		]);
	});
});

describe("direct mod attribution", () => {
	test("a spawn suggestion never closes the main window and link gives it the real agent id", async () => {
		const s = setup();
		const main = await s.api.suggest({
			...suggestInput(),
			session: SESSION,
			source: "claude-code-mod",
			turn: "t1",
		});
		s.setNow(T0 + 1);
		const spawn = await s.api.suggest({
			...suggestInput(),
			source: "claude-code-mod",
			scope: "subagent",
		});
		expect(s.store.getSuggestion(main.suggestion_id)?.closed_at).toBeNull();
		expect(s.store.getSuggestion(spawn.suggestion_id)).toMatchObject({
			agent_id: null,
			session_id: null,
		});
		s.setNow(T0 + 2);
		const input = {
			suggestionId: spawn.suggestion_id,
			agentId: "a1",
			session: SESSION,
		};
		await s.api.link(input);
		await s.api.link(input);
		expect(s.store.getSuggestion(spawn.suggestion_id)).toMatchObject({
			agent_id: "a1",
			session_id: SESSION,
		});
		expect(s.store.getSuggestion(main.suggestion_id)?.closed_at).toBeNull();
		await expect(s.api.link({ ...input, agentId: "a2" })).rejects.toThrow(
			"already linked",
		);
		await expect(
			s.api.link({ ...input, suggestionId: "nope" }),
		).rejects.toThrow("unknown suggestion_id");
		await expect(s.api.link({ ...input, agentId: " " })).rejects.toThrow();
	});

	test("a mod suggestion with a session needs a turn or an agent id", async () => {
		const s = setup();
		await expect(
			s.api.suggest({
				...suggestInput(),
				session: SESSION,
				source: "claude-code-mod",
			}),
		).rejects.toThrow("needs --turn or --agent-id");
	});

	test("stats opens the store first so migrations run on an old database", async () => {
		const s = setup();
		const order: string[] = [];
		const api = createApi(
			{
				...s.deps,
				openStore: (path) => {
					order.push("open");
					return s.deps.openStore(path);
				},
			},
			{
				runStats: async () => {
					order.push("runStats");
					return {
						by_type: [],
						coverage: 0,
						learned_success: null,
						control_success: null,
						fallbacks: {},
						failures: { parse: 0, hook: 0, launcher: 0 },
					};
				},
			},
		);
		await api.stats({ by: "scope" });
		expect(order).toEqual(["open", "runStats"]);
	});

	test("suggest with --session closes the earlier suggestion of the same scope only", async () => {
		const s = setup();
		const mod = { session: SESSION, source: "claude-code-mod" as const };
		const main1 = await s.api.suggest({
			...suggestInput(),
			...mod,
			turn: "t1",
		});
		s.setNow(T0 + 1);
		const sub1 = await s.api.suggest({
			...suggestInput(),
			...mod,
			agentId: "a1",
		});
		s.setNow(T0 + 2);
		const main2 = await s.api.suggest({
			...suggestInput(),
			...mod,
			turn: "t2",
		});
		expect(s.store.getSuggestion(main1.suggestion_id)?.closed_at).toBe(T0 + 2);
		expect(s.store.getSuggestion(sub1.suggestion_id)?.closed_at).toBeNull();
		expect(s.store.getSuggestion(main2.suggestion_id)?.closed_at).toBeNull();
	});

	test("suggest rejects an invalid scope or source before storing", async () => {
		const s = setup();
		await expect(
			s.api.suggest({ ...suggestInput(), scope: "bogus" as never }),
		).rejects.toThrow("invalid scope");
		await expect(
			s.api.suggest({ ...suggestInput(), source: "bogus" as never }),
		).rejects.toThrow("invalid source");
	});

	test("suggest links session, turn, agent and scope at creation", async () => {
		const s = setup();
		const first = await s.api.suggest({
			...suggestInput(),
			session: SESSION,
			turn: "t1",
			source: "claude-code-mod",
			scope: "turn",
		});
		s.setNow(T0 + 1);
		const sub = await s.api.suggest({
			...suggestInput(),
			session: SESSION,
			turn: "t2",
			agentId: "a1",
			source: "claude-code-mod",
			scope: "subagent",
		});
		expect(s.store.getSuggestion(first.suggestion_id)).toMatchObject({
			session_id: SESSION,
			turn_id: "t1",
			agent_id: null,
			agent: "claude-code-mod",
			scope: "turn",
			closed_at: null,
		});
		expect(s.store.getSuggestion(sub.suggestion_id)).toMatchObject({
			session_id: SESSION,
			turn_id: "t2",
			agent_id: "a1",
			agent: "claude-code-mod",
			scope: "subagent",
		});
		// Both calls are in their transcripts: the mod turn ids are not Claude prompt ids.
		const main = join(dir, "main.jsonl");
		const call = JSON.stringify({
			type: "assistant",
			timestamp: iso(T0 + 1000),
			message: {
				id: "m1",
				model: "claude-sonnet-5-5",
				content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }],
			},
		});
		await Bun.write(main, call);
		await Bun.write(join(dir, "main", "subagents", "agent-a1.jsonl"), call);
		s.setNow(T0 + 2000);
		await s.api.handleHook(
			"PostToolUse",
			JSON.stringify({
				...JSON.parse(bash("bun test")),
				transcript_path: main,
			}),
		);
		await s.api.handleHook(
			"PostToolUseFailure",
			JSON.stringify({
				...JSON.parse(bash("bun test", "", "PostToolUseFailure")),
				transcript_path: main,
				agent_id: "a1",
			}),
		);
		expect(s.store.outcome(first.suggestion_id)?.quality).toBe(1);
		expect(s.store.outcome(sub.suggestion_id)?.quality).toBe(0);
	});

	test("direct usage upserts each turn, preserves follow-ups and creates no outcome", async () => {
		const dbPath = join(dir, "direct.db");
		const s = setup({ dbPath, openStore });
		const { suggestion_id } = await s.api.suggest({
			...suggestInput(),
			session: SESSION,
			agentId: "a1",
			source: "claude-code-mod",
		});
		const input = {
			suggestionId: suggestion_id,
			model: "claude-sonnet-5-5",
			source: "claude-code-mod" as const,
			turn: "t1",
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheCreation: 40,
		};
		await s.api.usage(input);
		await s.api.usage({ ...input, output: 21 });
		const opusUsage = await s.api.usage({
			...input,
			turn: "t2",
			effort: "high",
		});
		expect(opusUsage.effort).toBe("high");
		const db = new Database(dbPath);
		try {
			expect(
				db
					.query(
						"SELECT model, effort, scope_key, turn_id, agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usages ORDER BY turn_id",
					)
					.all(),
			).toEqual([
				{
					model: "anthropic/claude-sonnet-5.5",
					effort: null,
					scope_key: "t1",
					turn_id: "t1",
					agent_id: "a1",
					input_tokens: 10,
					output_tokens: 21,
					cache_read_tokens: 30,
					cache_creation_tokens: 40,
				},
				{
					model: "anthropic/claude-sonnet-5.5",
					effort: "high",
					scope_key: "t2",
					turn_id: "t2",
					agent_id: "a1",
					input_tokens: 10,
					output_tokens: 20,
					cache_read_tokens: 30,
					cache_creation_tokens: 40,
				},
			]);
			expect(db.query("SELECT * FROM outcomes").all()).toEqual([]);
		} finally {
			db.close();
		}

		const haiku = await s.api.suggest(suggestInput());
		const haikuUsage = await s.api.usage({
			...input,
			suggestionId: haiku.suggestion_id,
			model: "claude-haiku-4-5",
			turn: "haiku",
			effort: "high",
		});
		expect(haikuUsage.effort).toBe("none");
		await expect(
			s.api.usage({
				...input,
				suggestionId: haiku.suggestion_id,
				model: "claude-opus-5-5",
				effort: "none",
			}),
		).rejects.toThrow("none is not supported");
		await expect(
			s.api.usage({ ...input, suggestionId: "missing" }),
		).rejects.toThrow("unknown suggestion_id");
		for (const bad of [
			{ input: -1 },
			{ output: 0.5 },
			{ cacheRead: Infinity },
			{ cacheCreation: NaN },
			{ effort: "turbo" },
			{ turn: "" },
			{ model: "" },
			{ source: "transcript" },
		]) {
			await expect(
				s.api.usage({ ...input, ...bad } as typeof input),
			).rejects.toThrow();
		}
	});

	test("direct reports deduplicate by turn and preserve legacy outcomes", async () => {
		const dbPath = join(dir, "reports.db");
		const s = setup({ dbPath, openStore });
		const { suggestion_id } = await s.api.suggest({
			...suggestInput(),
			agentId: "a1",
		});
		const input = {
			suggestionId: suggestion_id,
			model: "claude-sonnet-5-5",
			effort: "high",
			result: "pass" as const,
			source: "claude-code-mod" as const,
			turn: "t1",
		};
		await s.api.report(input);
		await s.api.report(input);
		s.setNow(T0 + 1);
		await s.api.report({ ...input, turn: "t2", result: "fail" });
		const db = new Database(dbPath);
		try {
			expect(
				db
					.query(
						"SELECT turn_id, agent_id, source FROM signals ORDER BY turn_id",
					)
					.all(),
			).toEqual([
				{ turn_id: "t1", agent_id: "a1", source: "claude-code-mod" },
				{ turn_id: "t2", agent_id: "a1", source: "claude-code-mod" },
			]);
			expect(
				db
					.query(
						"SELECT scope_key, turn_id, agent_id FROM usages WHERE source = 'report' ORDER BY turn_id",
					)
					.all(),
			).toEqual([
				{ scope_key: "t1", turn_id: "t1", agent_id: "a1" },
				{ scope_key: "t2", turn_id: "t2", agent_id: "a1" },
			]);
			// A retry of the same pair in a new turn is its own attempt: the first pass stays.
			expect(
				db
					.query("SELECT attempt, quality FROM attempts ORDER BY attempt")
					.all(),
			).toEqual([
				{ attempt: 1, quality: 1 },
				{ attempt: 2, quality: 0 },
			]);
		} finally {
			db.close();
		}
	});
});

test("usage command output never relinks a suggestion through Bash detection", async () => {
	const s = setup();
	const { suggestion_id } = await s.api.suggest({
		...suggestInput(),
		session: "original",
		turn: "t",
		source: "claude-code-mod",
	});
	await s.api.handleHook(
		"PostToolUse",
		bash(
			`spatz usage ${suggestion_id} --model m --turn t --source claude-code-mod --json`,
			JSON.stringify({ suggestion_id }),
		),
	);
	expect(s.store.getSuggestion(suggestion_id)?.session_id).toBe("original");
});

test("Bash links inside subagents retain agent identity and leave main open", async () => {
	const s = setup();
	const main = await linked(s);
	s.setNow(T0 + 1000);
	const { suggestion_id } = await s.api.suggest(suggestInput());
	await s.api.handleHook(
		"PostToolUse",
		JSON.stringify({ ...JSON.parse(linkHook(suggestion_id)), agent_id: "a1" }),
	);
	expect(s.store.getSuggestion(suggestion_id)?.agent_id).toBe("a1");
	expect(s.store.getSuggestion(main)?.closed_at).toBeNull();
});

test("Agent response belongs to its explicitly linked subagent", async () => {
	const s = setup();
	const main = await linked(s);
	const { suggestion_id } = await s.api.suggest({
		...suggestInput(),
		session: SESSION,
		agentId: "a1",
		source: "claude-code-mod",
	});
	await s.api.handleHook(
		"PostToolUse",
		JSON.stringify(
			base({
				hook_event_name: "PostToolUse",
				tool_name: "Agent",
				tool_input: {},
				tool_response: { agentId: "a1", resolvedModel: "claude-sonnet-5-5" },
				tool_use_id: "t",
			}),
		),
	);
	expect(s.argsOf("upsertUsage")).toEqual([
		[expect.objectContaining({ suggestion_id, source: "agent_tool" })],
	]);
	expect(s.store.getSuggestion(main)?.closed_at).toBeNull();
});

test("transcript rewrites keep main and two agent windows separate", async () => {
	const dbPath = join(dir, "windows.db");
	const s = setup({ dbPath, openStore });
	const suggest = (agentId?: string) =>
		s.api.suggest({
			...suggestInput(),
			session: SESSION,
			agentId,
			...(!agentId && { turn: "t0" }),
			source: "claude-code-mod",
			scope: agentId ? "subagent" : "turn",
		});
	const main = (await suggest()).suggestion_id;
	s.setNow(T0 + 10);
	const a = (await suggest("a1")).suggestion_id;
	s.setNow(T0 + 20);
	const b = (await suggest("b1")).suggestion_id;
	const mainPath = join(dir, "main.jsonl");
	await Bun.write(
		mainPath,
		[
			JSON.stringify({ type: "user", promptId: PROMPT }),
			assistant("main", "m/main", 5, {}, T0 + 30),
		].join("\n"),
	);
	const events: [string, string][] = [
		[
			"Stop",
			JSON.stringify(
				base({
					hook_event_name: "Stop",
					transcript_path: mainPath,
					stop_hook_active: false,
				}),
			),
		],
	];
	for (const [agentId, tokens] of [
		["a1", 10],
		["b1", 20],
	] as const) {
		const path = join(dir, `${agentId}.jsonl`);
		await Bun.write(
			path,
			assistant(
				agentId,
				`m/${agentId}`,
				tokens,
				{ isSidechain: true, agentId },
				T0 + 30,
			),
		);
		events.push([
			"SubagentStop",
			JSON.stringify(
				base({
					hook_event_name: "SubagentStop",
					agent_id: agentId,
					agent_type: "test",
					agent_transcript_path: path,
					stop_hook_active: false,
				}),
			),
		]);
	}
	s.setNow(T0 + 40);
	for (const [event, body] of [...events, ...events.toReversed()])
		await s.api.handleHook(event, body);
	const db = new Database(dbPath);
	try {
		const rows = db
			.query(
				"SELECT suggestion_id, model, output_tokens FROM usages ORDER BY model",
			)
			.all();
		expect(rows).toEqual([
			{ suggestion_id: a, model: "m/a1", output_tokens: 10 },
			{ suggestion_id: b, model: "m/b1", output_tokens: 20 },
			{ suggestion_id: main, model: "m/main", output_tokens: 5 },
		]);
	} finally {
		db.close();
	}
});

describe("resolved candidates", () => {
	test("family constrains Jev input, stored ranking and returned ranking", async () => {
		const jev = fakeJev();
		const { api, store } = setup({ jev, env: { SPATZ_MODELS: MODELS } });
		const result = await api.suggest({
			task: "Fix a bug",
			dryRun: true,
			family: "openai",
		});
		expect(result.models_source).toBe("env");
		expect(
			Object.keys(jev.requests[0]?.questions.best_candidate.criteria ?? {}),
		).toEqual(["openai/gpt-6-luna:low"]);
		expect(result.ranking.every((c) => c.model.startsWith("openai/"))).toBe(
			true,
		);
		expect(store.getSuggestion(result.suggestion_id)?.ranking).toEqual(
			result.ranking,
		);
	});
	test("resolution and family failures do not fetch, classify or write", async () => {
		const jev = fakeJev();
		const { api, fetched, writes } = setup({ jev });
		await expect(
			api.suggest({ task: "Fix a bug", dryRun: true }),
		).rejects.toThrow("No candidate models");
		await expect(
			api.suggest({
				task: "Fix a bug",
				models: "gpt-6-luna",
				family: "claude",
				dryRun: true,
			}),
		).rejects.toThrow("no matching candidates");
		expect(fetched).toEqual([]);
		expect(jev.requests).toEqual([]);
		expect(writes()).toEqual([]);
	});
});

test("harness catalog is used only at preset precedence", async () => {
	const remote = {
		schema: 1,
		updated: "2026-10-05",
		harnesses: {
			"claude-code": {
				version: "2.1.0",
				models: [{ id: "claude-new", efforts: ["high"] }],
			},
			codex: {
				version: "0.100.0",
				models: [{ id: "gpt-new", efforts: ["low"] }],
			},
		},
	};
	const urls: string[] = [];
	const { api } = setup({
		env: { CODEX_THREAD_ID: "t" },
		fetch: async (url) => {
			urls.push(url);
			return Response.json(
				url.includes("raw.githubusercontent.com") ? remote : { data: [] },
			);
		},
	});
	const result = await api.suggest({ task: "test", dryRun: true });
	expect(result.models_source).toBe("preset:codex");
	expect(result.ranking.map((m) => [m.model, m.effort])).toEqual([
		["openai/gpt-new", "low"],
	]);
	expect(urls.some((url) => url.includes("raw.githubusercontent.com"))).toBe(
		true,
	);
	urls.length = 0;
	await api.suggest({
		task: "test",
		models: "gpt-explicit:high",
		dryRun: true,
	});
	expect(urls.some((url) => url.includes("raw.githubusercontent.com"))).toBe(
		false,
	);
});

test("SPATZ_NO_NETWORK skips both catalogs and Jev, including injected config", async () => {
	const jev = fakeJev();
	const { api, fetched } = setup({
		env: { SPATZ_NO_NETWORK: "1", CODEX_THREAD_ID: "t" },
		jev,
	});
	const result = await api.suggest({ task: "test", dryRun: true });
	expect(result.models_source).toBe("preset:codex");
	expect(result.ranking.length).toBeGreaterThan(0);
	expect(fetched).toEqual([]);
	expect(jev.requests).toEqual([]);
});

test("preset catalogs start in parallel and the mod receives the full resolved ladder", async () => {
	const started: string[] = [];
	const releases: (() => void)[] = [];
	const { api } = setup({
		env: { CLAUDECODE: "1" },
		fetch: async (url) => {
			started.push(url);
			await new Promise<void>((resolve) => {
				releases.push(resolve);
				if (releases.length === 2) for (const release of releases) release();
			});
			return new Response("offline", { status: 503 });
		},
	});
	const start = performance.now();
	const result = await api.suggest({
		task: "test",
		dryRun: true,
		source: "claude-code-mod",
	});
	expect(performance.now() - start).toBeLessThan(1000);
	expect(started).toHaveLength(2);
	expect(result.models_source).toBe("preset:claude-code");
	expect(result.candidates?.length).toBeGreaterThan(3);
	expect(result.candidates?.some((c) => c.effort === "max")).toBe(true);
	expect(
		result.candidates?.every((c) => c.model.startsWith("anthropic/")),
	).toBe(true);
});

test("none rejects known reasoning models in suggestions and reports, but accepts unknown models", async () => {
	const s = setup();
	for (const model of [
		"claude-opus-5-5",
		"anthropic/claude-opus-5.5",
		"gpt-6-astra",
	]) {
		await expect(
			s.api.suggest({ task: "test", models: `${model}:none`, dryRun: true }),
		).rejects.toThrow(`none is not supported for ${model}`);
		await expect(
			s.api.report({
				suggestionId: ID1,
				model,
				effort: "none",
				result: "pass",
			}),
		).rejects.toThrow(`none is not supported for ${model}`);
	}
	expect(s.fetched).toEqual([]);
	expect(s.writes()).toEqual([]);
	for (const model of ["claude-haiku-4-5-20251001", "unknown-model"]) {
		const r = await s.api.suggest({
			task: "test",
			models: `${model}:none`,
			dryRun: true,
		});
		expect(r.ranking[0]?.effort).toBe("none");
		expect(
			(
				await s.api.report({
					suggestionId: r.suggestion_id,
					model,
					effort: "none",
					result: "pass",
				})
			)?.effort,
		).toBe("none");
	}
});
test("missing efforts from mod usage, Claude hooks and Codex hooks use the available none-only catalog", async () => {
	const dbPath = join(dir, "none.db");
	const s = setup({ dbPath, openStore });
	const id = await linked(s);
	await s.api.usage({
		suggestionId: id,
		model: "claude-haiku-4-5-20251001",
		source: "claude-code-mod",
		turn: "mod",
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheCreation: 0,
	});
	const path = join(dir, "main.jsonl");
	await Bun.write(
		path,
		[
			JSON.stringify({ type: "user", promptId: PROMPT }),
			assistant("a", "claude-haiku-4-5-20251001", 3),
		].join("\n"),
	);
	await s.api.handleHook(
		"Stop",
		JSON.stringify(
			base({
				hook_event_name: "Stop",
				effort: undefined,
				transcript_path: path,
				stop_hook_active: false,
			}),
		),
	);
	// A future none-only model must work from cache, without a release or network request.
	const bundled = (await import("../catalog/harness.ts"))
		.BUNDLED_HARNESS_CATALOG;
	const catalog = structuredClone(bundled);
	catalog.harnesses.codex.models.push({ id: "gpt-future", efforts: ["none"] });
	await Bun.write(
		join(dir, ".spatz", "harness-models.json"),
		JSON.stringify({ fetched_at: T0, catalog }),
	);
	const rollout = (
		await Bun.file(
			`${import.meta.dir}/../signals/fixtures/codex-command-events.jsonl`,
		).text()
	)
		.replaceAll("gpt-6-luna", "gpt-future")
		.replace(/,"effort":"[^"]*"/g, "");
	const codexPath = join(dir, "codex.jsonl");
	await Bun.write(codexPath, stamped(rollout, T0 + 1000));
	await s.api.handleHook(
		"codex:Stop",
		JSON.stringify({
			session_id: SESSION,
			turn_id: "todo-turn",
			transcript_path: codexPath,
			hook_event_name: "Stop",
		}),
	);
	const db = new Database(dbPath);
	try {
		expect(
			db.query("SELECT model, effort FROM usages ORDER BY model, source").all(),
		).toEqual([
			{ model: "anthropic/claude-haiku-4.5", effort: "none" },
			{ model: "anthropic/claude-haiku-4.5", effort: "none" },
			{ model: "openai/gpt-future", effort: "none" },
		]);
	} finally {
		db.close();
	}
});

describe("attempts, signal binding and failure counts", () => {
	const turnTranscript = async (calls: [string, string, number][]) => {
		const path = join(dir, "main.jsonl");
		await Bun.write(
			path,
			[
				JSON.stringify({ type: "user", promptId: PROMPT, timestamp: iso(T0) }),
				...calls.map(([tool, model, at], i) =>
					JSON.stringify({
						type: "assistant",
						timestamp: iso(at),
						message: {
							id: `m${i}`,
							model,
							content: [{ type: "tool_use", id: tool, name: "Bash" }],
						},
					}),
				),
			].join("\n"),
		);
		return path;
	};
	const testHook = (
		path: string,
		tool: string,
		event: "PostToolUse" | "PostToolUseFailure" = "PostToolUseFailure",
	) =>
		JSON.stringify(
			base({
				hook_event_name: event,
				transcript_path: path,
				tool_name: "Bash",
				tool_input: { command: "bun test" },
				tool_use_id: tool,
				...(event === "PostToolUse"
					? { tool_response: { stdout: "", stderr: "", interrupted: false } }
					: { error: "Exit code 1" }),
			}),
		);

	test("a late test hook lands on the suggestion of its tool call; a dispatching main session keeps the used pair", async () => {
		const s = setup();
		const first = await linked(s);
		const path = await turnTranscript([
			["toolu_old", "claude-sonnet-5-5", T0 + 1000],
		]);
		s.setNow(T0 + 5000);
		await linked(s);
		s.setNow(T0 + 6000);
		await s.api.handleHook("PostToolUseFailure", testHook(path, "toolu_old"));
		expect(s.argsOf("insertSignal")).toEqual([
			[
				{
					suggestion_id: first,
					kind: "test",
					value: 0,
					weight: 1,
					source: "PostToolUseFailure",
					observed_at: T0 + 1000,
				},
			],
		]);
		expect(s.argsOf("recordFailure")).toEqual([]);
	});

	test("a stronger retry is credited to its own pair, the failed cheap pair keeps its failure", async () => {
		const dbPath = join(dir, "attempts.db");
		const s = setup({ openStore: () => openStore(dbPath) });
		const { suggestion_id: id } = await s.api.suggest({
			...suggestInput(),
			scope: "escalate",
			source: "claude-code-mod",
			session: SESSION,
			turn: PROMPT,
		});
		const path = await turnTranscript([
			["toolu_cheap", "claude-sonnet-5-5", T0 + 1000],
			["toolu_strong", "claude-opus-5-5", T0 + 2000],
		]);
		s.setNow(T0 + 3000);
		await s.api.handleHook("PostToolUseFailure", testHook(path, "toolu_cheap"));
		await s.api.handleHook(
			"PostToolUse",
			testHook(path, "toolu_strong", "PostToolUse"),
		);
		const db = new Database(dbPath);
		try {
			expect(
				db
					.query(
						"SELECT attempt, model, effort, quality FROM attempts WHERE suggestion_id = ? ORDER BY attempt",
					)
					.all(id),
			).toEqual([
				{
					attempt: 1,
					model: "anthropic/claude-sonnet-5.5",
					effort: "high",
					quality: 0,
				},
				{
					attempt: 2,
					model: "anthropic/claude-opus-5.5",
					effort: "high",
					quality: 1,
				},
			]);
		} finally {
			db.close();
		}
	});

	test("without the event in the transcript: the open suggestion of its own prompt, and a parse failure", async () => {
		const s = setup();
		const id = await linked(s);
		s.setNow(T0 + 1000);
		await s.api.handleHook("PostToolUse", bash("bun test"));
		expect(s.argsOf("insertSignal")[0]?.[0]).toMatchObject({
			suggestion_id: id,
			observed_at: T0 + 1000,
		});
		expect(s.argsOf("recordFailure")).toEqual([
			["parse", "PostToolUse", T0 + 1000, PROMPT],
		]);
	});

	test("a late Codex Stop binds its turn by the rollout time", async () => {
		const s = setup();
		const first = await linked(s);
		const path = join(dir, "rollout.jsonl");
		await Bun.write(
			path,
			[
				{
					type: "turn_context",
					payload: { turn_id: "t1", model: "gpt-6-luna", effort: "low" },
				},
				{
					type: "event_msg",
					payload: {
						type: "item_completed",
						item: {
							type: "CommandExecution",
							id: "c1",
							command: ["/bin/bash", "-lc", "bun test"],
							exit_code: 1,
						},
					},
				},
			]
				.map((r) => JSON.stringify({ timestamp: iso(T0 + 1000), ...r }))
				.join("\n"),
		);
		s.setNow(T0 + 5000);
		await linked(s);
		s.setNow(T0 + 6000);
		await s.api.handleHook(
			"codex:Stop",
			JSON.stringify({
				session_id: SESSION,
				turn_id: "t1",
				transcript_path: path,
				hook_event_name: "Stop",
			}),
		);
		expect(s.argsOf("insertSignal")).toEqual([
			[
				{
					suggestion_id: first,
					kind: "test",
					value: 0,
					weight: 1,
					source: "Stop",
					turn_id: "t1",
					observed_at: T0 + 1000,
				},
			],
		]);
		// Usage goes with the signal, so the old suggestion gets a used pair and a learning row.
		expect(
			s
				.argsOf("upsertUsage")
				.map(([u]) => (u as { suggestion_id: string }).suggestion_id),
		).toEqual([first]);
		expect(s.store.outcome(first)).toEqual({
			suggestion_id: first,
			quality: 0,
			model: "openai/gpt-6-luna",
			effort: "low",
		});
		const taskType = s.store.getSuggestion(first)?.task_type ?? "other";
		expect(s.store.cellStats(taskType)).toContainEqual(
			expect.objectContaining({
				model: "openai/gpt-6-luna",
				effort: "low",
				n: 1,
			}),
		);
	});

	test("hook errors and empty transcript turns are counted", async () => {
		const failing = setup();
		failing.store.findOpenSuggestion = () => {
			throw new Error("SQLITE_BUSY");
		};
		await failing.api.handleHook("PostToolUse", bash("bun test"));
		expect(failing.argsOf("recordFailure")).toEqual([
			["hook", "PostToolUse", T0, PROMPT],
		]);

		const s = setup();
		await linked(s);
		const path = join(dir, "empty.jsonl");
		await Bun.write(path, JSON.stringify({ type: "user", promptId: PROMPT }));
		await s.api.handleHook(
			"Stop",
			JSON.stringify(
				base({
					hook_event_name: "Stop",
					stop_hook_active: false,
					transcript_path: path,
				}),
			),
		);
		const missing = join(dir, "missing.jsonl");
		await Bun.write(missing, '{"type":"future_rollout_format"}');
		await s.api.handleHook(
			"codex:Stop",
			JSON.stringify({
				session_id: SESSION,
				turn_id: "nope",
				transcript_path: missing,
				hook_event_name: "Stop",
			}),
		);
		expect(s.argsOf("recordFailure")).toEqual([
			["parse", "Stop", T0, PROMPT],
			["parse", "codex:Stop", T0, "nope"],
		]);
	});

	test("suggest stores the fallback reason; stats adds launcher failures", async () => {
		const s = setup();
		const { suggestion_id } = await s.api.suggest(suggestInput());
		expect(s.store.getSuggestion(suggestion_id)?.fallback_reason).toBe(
			"no_key",
		);
		const report: StatsReport = {
			by_type: [],
			coverage: 0,
			learned_success: null,
			control_success: null,
			fallbacks: {},
			failures: { parse: 1, hook: 2, launcher: 0 },
		};
		const api = createApi(s.deps, { runStats: async () => report });
		expect((await api.stats({})).failures).toEqual({
			parse: 1,
			hook: 2,
			launcher: 0,
		});
		await Bun.write(join(dir, ".spatz", "launcher-failures"), "1\n2\n");
		expect((await api.stats({})).failures).toEqual({
			parse: 1,
			hook: 2,
			launcher: 2,
		});
	});
});

describe("bindings without a time, same-turn escalation, reconciliation and failure turns", () => {
	const codexRollout = (turns: [string, number][]) =>
		turns
			.flatMap(([turn, exit_code]) => [
				{
					type: "turn_context",
					payload: { turn_id: turn, model: "gpt-6-luna", effort: "low" },
				},
				{
					type: "event_msg",
					payload: {
						type: "item_completed",
						item: {
							type: "CommandExecution",
							id: `c-${turn}`,
							command: ["/bin/bash", "-lc", "bun test"],
							exit_code,
						},
					},
				},
			])
			.map((r) => JSON.stringify(r))
			.join("\n");
	const codexStop = (turn: string, path: string) =>
		JSON.stringify({
			session_id: SESSION,
			turn_id: turn,
			transcript_path: path,
			hook_event_name: "Stop",
		});
	const codexLink = (id: string, turn: string, path = "/nope") =>
		JSON.stringify({
			session_id: SESSION,
			turn_id: turn,
			transcript_path: path,
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: `spatz "fix it" --models ${MODELS}` },
			tool_response: `suggestion_id: ${id}`,
		});

	test("Claude: without a transcript an event names its prompt; an old prompt never lands on the new suggestion", async () => {
		const s = setup();
		const inPrompt = (json: string, prompt: string) =>
			JSON.stringify({ ...JSON.parse(json), prompt_id: prompt });
		const old = (await s.api.suggest(suggestInput())).suggestion_id;
		await s.api.handleHook("PostToolUse", inPrompt(linkHook(old), "p1"));
		s.setNow(T0 + 5000);
		const now = (await s.api.suggest(suggestInput())).suggestion_id;
		await s.api.handleHook("PostToolUse", inPrompt(linkHook(now), "p2"));
		s.setNow(T0 + 6000);
		const fail = bash("bun test", "", "PostToolUseFailure");
		await s.api.handleHook("PostToolUseFailure", inPrompt(fail, "p1"));
		await s.api.handleHook("PostToolUseFailure", inPrompt(fail, "p3"));
		expect(s.argsOf("insertSignal")).toEqual([]);
		await s.api.handleHook("PostToolUse", inPrompt(bash("bun test"), "p2"));
		expect(s.argsOf("insertSignal")).toEqual([
			[expect.objectContaining({ suggestion_id: now, value: 1 })],
		]);
		expect(s.argsOf("recordFailure").map(([, , , turn]) => turn)).toEqual([
			"p1",
			"p3",
			"p2",
		]);
	});

	test("Codex: a rollout without timestamps binds only by its turn and counts as a parse failure", async () => {
		const s = setup();
		const old = (await s.api.suggest(suggestInput())).suggestion_id;
		await s.api.handleHook("codex:PostToolUse", codexLink(old, "t1"));
		s.setNow(T0 + 5000);
		const now = (await s.api.suggest(suggestInput())).suggestion_id;
		await s.api.handleHook("codex:PostToolUse", codexLink(now, "t2"));
		const path = join(dir, "rollout.jsonl");
		await Bun.write(
			path,
			codexRollout([
				["t1", 1],
				["t2", 0],
				["t3", 1],
			]),
		);
		s.setNow(T0 + 6000);
		await s.api.handleHook("codex:Stop", codexStop("t1", path));
		await s.api.handleHook("codex:Stop", codexStop("t3", path));
		expect(s.argsOf("insertSignal")).toEqual([]);
		await s.api.handleHook("codex:Stop", codexStop("t2", path));
		expect(s.argsOf("insertSignal")).toEqual([
			[expect.objectContaining({ suggestion_id: now, value: 1 })],
		]);
		expect(s.store.outcome(now)?.model).toBe("openai/gpt-6-luna");
		expect(s.store.outcome(old)).toBeNull();
		expect(s.argsOf("recordFailure")).toEqual([
			["parse", "codex:Stop", T0 + 6000, "t1"],
			["parse", "codex:Stop", T0 + 6000, "t3"],
			["parse", "codex:Stop", T0 + 6000, "t2"],
		]);
	});

	test("Codex: a late link moves the turn's signals and usage together", async () => {
		const s = setup();
		const first = (await s.api.suggest(suggestInput())).suggestion_id;
		await s.api.handleHook("codex:PostToolUse", codexLink(first, "t0"));
		s.setNow(T0 + 5000);
		const late = (await s.api.suggest(suggestInput())).suggestion_id;
		const path = join(dir, "rollout.jsonl");
		await Bun.write(path, stamped(codexRollout([["t1", 1]]), T0 + 6000));
		s.setNow(T0 + 7000);
		await s.api.handleHook("codex:Stop", codexStop("t1", path));
		expect(s.store.outcome(first)?.model).toBe("openai/gpt-6-luna");
		// A newer suggestion of another turn shrinks the first window: t1 stays where its time is.
		s.setNow(T0 + 7500);
		const newer = (await s.api.suggest(suggestInput())).suggestion_id;
		await s.api.handleHook("codex:PostToolUse", codexLink(newer, "t2", path));
		expect(s.store.outcome(first)?.model).toBe("openai/gpt-6-luna");
		expect(s.store.usageScopes([newer])).toEqual([]);
		s.setNow(T0 + 8000);
		await s.api.handleHook("codex:PostToolUse", codexLink(late, "t1", path));
		expect(s.store.outcome(first)).toBeNull();
		expect(s.store.outcome(newer)).toBeNull();
		expect(s.store.usageScopes([newer])).toEqual([]);
		expect(s.store.outcome(late)).toEqual({
			suggestion_id: late,
			quality: 0,
			model: "openai/gpt-6-luna",
			effort: "low",
		});
		expect(s.store.usageScopes([first])).toEqual([]);
		expect(s.store.usageScopes([late])).toEqual([
			{ source: "transcript", scope_key: "t1", effort: "low" },
		]);
	});

	test("a transcript time ahead of the clock counts as the hook time", async () => {
		const s = setup();
		const id = await linked(s);
		const path = join(dir, "ahead.jsonl");
		await Bun.write(
			path,
			JSON.stringify({
				type: "assistant",
				timestamp: iso(T0 + HOUR),
				message: {
					id: "m1",
					model: "claude-sonnet-5-5",
					content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }],
				},
			}),
		);
		s.setNow(T0 + 1000);
		await s.api.handleHook(
			"PostToolUse",
			JSON.stringify({
				...JSON.parse(bash("bun test")),
				transcript_path: path,
			}),
		);
		expect(s.argsOf("insertSignal")).toEqual([
			[expect.objectContaining({ suggestion_id: id, observed_at: T0 + 1000 })],
		]);
	});

	test("two direct reports in one turn keep the cheap failure; a replay does not duplicate", async () => {
		const dbPath = join(dir, "escalate.db");
		const s = setup({ openStore: () => openStore(dbPath) });
		const { suggestion_id } = await s.api.suggest(suggestInput());
		const cheap = {
			suggestionId: suggestion_id,
			model: "gpt-6-luna",
			effort: "low",
			result: "fail" as const,
			source: "claude-code-mod" as const,
			turn: "t1",
		};
		await s.api.report(cheap);
		await s.api.report(cheap);
		s.setNow(T0 + 1000);
		await s.api.report({
			...cheap,
			model: "claude-opus-5-5",
			effort: "high",
			result: "pass",
		});
		const db = new Database(dbPath);
		try {
			expect(db.query("SELECT COUNT(*) AS n FROM signals").get()).toEqual({
				n: 2,
			});
			expect(
				db
					.query("SELECT model, effort, quality FROM attempts ORDER BY attempt")
					.all(),
			).toEqual([
				{ model: "openai/gpt-6-luna", effort: "low", quality: 0 },
				{ model: "anthropic/claude-opus-5.5", effort: "high", quality: 1 },
			]);
		} finally {
			db.close();
		}
	});

	test("malformed hook input counts as a hook failure; failures count once per turn", async () => {
		const dbPath = join(dir, "failures.db");
		const s = setup({ openStore: () => openStore(dbPath) });
		await s.api.handleHook("PostToolUse", "{not json");
		await s.api.handleHook("codex:Stop", '{"turn_id":"t9"}');
		await linked(s);
		await s.api.handleHook("PostToolUse", bash("bun test"));
		await s.api.handleHook("PostToolUse", bash("bun build"));
		const db = new Database(dbPath);
		try {
			expect(
				db
					.query(
						"SELECT kind, source, turn_id FROM failures ORDER BY kind, observed_at",
					)
					.all(),
			).toEqual([
				{ kind: "hook", source: "PostToolUse", turn_id: null },
				{ kind: "hook", source: "codex:Stop", turn_id: "t9" },
				{ kind: "parse", source: "PostToolUse", turn_id: PROMPT },
			]);
		} finally {
			db.close();
		}
	});
});
