import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Outcome,
	ReportInput,
	SpatzApi,
	StatsInput,
	StatsReport,
	SuggestInput,
	Suggestion,
} from "@spatz/core";
import { type CliIO, main } from "./main.ts";

const suggestion: Suggestion = {
	suggestion_id: "abc-123",
	models_source: "flag",
	ranking: [
		{ model: "openai/gpt-6-sol", effort: "medium", estimate: 0.85, n: 7 },
		{
			model: "anthropic/claude-opus-5.5",
			effort: "high",
			estimate: 0.9,
			n: 12,
		},
	],
	reason: "Cheapest pair with enough outcomes.",
	classification: {
		task_type: "code.bugfix",
		difficulty: "medium",
		criticality: "none",
	},
	fallback_used: false,
	explored: true,
	control: false,
	strategy: "learned",
	is_test: false,
};

const outcome: Outcome = {
	attempt_id: "attempt-2",
	ordinal: 2,
	root_id: "attempt-1",
	input_tokens: 100,
	output_tokens: 200,
	cache_read_tokens: 300,
	cache_creation_tokens: 400,
	suggestion_id: "abc-123",
	quality: 1,
	model: "openai/gpt-6-sol",
	effort: "medium",
};

const statsReport: StatsReport = {
	by_type: [
		{
			task_type: "code.bugfix",
			n: 4,
			pairs: [
				{
					model: "openai/gpt-6-sol",
					effort: "medium",
					n: 3,
					success_rate: 2 / 3,
				},
				{
					model: "anthropic/claude-opus-5.5",
					effort: null,
					n: 1,
					success_rate: 1,
				},
			],
			cost_usd: null,
			adoption_rate: 0.75,
			input_tokens: 1200,
			output_tokens: 340,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		},
	],
	coverage: 0.8,
	learned_success: 0.7,
	control_success: null,
	dispatches: 0,
	routed_by_mod: 0,
	swapped: 0,
	fallbacks: {},
	failures: { parse: 0, hook: 0, launcher: 0 },
};

function fakeIO(stdin: () => Promise<string> = async () => "{}") {
	const out: string[] = [];
	const err: string[] = [];
	const io: CliIO = {
		stdout: (t) => out.push(t),
		stderr: (t) => err.push(t),
		readStdin: stdin,
	};
	return { io, out, err, stdout: () => out.join("\n") };
}

function fakeApi(overrides: Partial<SpatzApi> = {}) {
	const calls: { method: string; args: unknown[] }[] = [];
	const api: SpatzApi = {
		startAttempt: async () => {
			throw new Error("unexpected attempt start");
		},
		bindAttempt: async () => {
			throw new Error("unexpected attempt bind");
		},
		finalizeAttempts: async () => {
			throw new Error("unexpected attempt finalize");
		},
		importRollout: async () => {
			throw new Error("unexpected import");
		},
		usage: async () => {
			throw new Error("unexpected usage");
		},
		link: async () => {
			throw new Error("unexpected link");
		},
		suggest: async (input: SuggestInput) => {
			calls.push({ method: "suggest", args: [input] });
			return suggestion;
		},
		report: async (input: ReportInput) => {
			calls.push({ method: "report", args: [input] });
			return outcome;
		},
		handleHook: async (event: string, stdin: string) => {
			calls.push({ method: "handleHook", args: [event, stdin] });
		},
		stats: async (input: StatsInput) => {
			calls.push({ method: "stats", args: [input] });
			return statsReport;
		},
		...overrides,
	};
	return { api, calls };
}

describe("suggest", () => {
	test("explicit suggest forwards the retry chain", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		expect(
			await main(
				["suggest", "fix the retry", "--retry-of", "previous"],
				io,
				api,
			),
		).toBe(0);
		expect(calls).toEqual([
			{
				method: "suggest",
				args: [{ task: "fix the retry", dryRun: false, retryOf: "previous" }],
			},
		]);
	});
	test("passes task and raw --models to api.suggest", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		const code = await main(
			["fix bug", "--models", "claude-opus-5-5,gpt-6-sol"],
			io,
			api,
		);
		expect(code).toBe(0);
		expect(calls).toEqual([
			{
				method: "suggest",
				args: [
					{
						task: "fix bug",
						models: "claude-opus-5-5,gpt-6-sol",
						dryRun: false,
					},
				],
			},
		]);
	});

	test("--dry-run sets dryRun true", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		await main(["fix bug", "--models", "gpt-6-sol", "--dry-run"], io, api);
		expect(calls[0]?.args[0]).toEqual({
			task: "fix bug",
			models: "gpt-6-sol",
			dryRun: true,
		});
	});

	test("omitted models and family pass through to core resolution", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		expect(await main(["fix bug", "--family", "gpt"], io, api)).toBe(0);
		expect(calls).toEqual([
			{
				method: "suggest",
				args: [{ task: "fix bug", family: "gpt", dryRun: false }],
			},
		]);
	});

	test("missing task exits 2", async () => {
		const { io, err } = fakeIO();
		const { api, calls } = fakeApi();
		const code = await main(["--models", "gpt-6-sol"], io, api);
		expect(code).toBe(2);
		expect(err.length).toBeGreaterThan(0);
		expect(calls).toEqual([]);
	});

	test("unknown option exits 2", async () => {
		const { io, err } = fakeIO();
		const { api } = fakeApi();
		const code = await main(["t", "--models", "m", "--bogus"], io, api);
		expect(code).toBe(2);
		expect(err.length).toBeGreaterThan(0);
	});

	test("text output: suggestion_id line, ranking, reason, flags", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi();
		await main(["fix bug", "--models", "gpt-6-sol"], io, api);
		const lines = stdout().split("\n");
		expect(lines[0]).toBe("suggestion_id: abc-123");
		expect(lines[1]).toContain("openai/gpt-6-sol:medium");
		expect(lines[1]).toContain("0.85");
		expect(lines[1]).toContain("n=7");
		expect(lines[2]).toContain("anthropic/claude-opus-5.5:high");
		expect(lines[2]).toContain("n=12");
		const text = stdout();
		expect(text).toContain("Cheapest pair with enough outcomes.");
		expect(text).toContain("explored: true");
		expect(text).toContain("control: false");
		expect(text).toContain("fallback_used: false");
	});

	test("text output: complete ordered lines incl. numbering and classification", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi();
		await main(["fix bug", "--models", "gpt-6-sol"], io, api);
		expect(stdout()).toBe(
			[
				"suggestion_id: abc-123",
				"1. openai/gpt-6-sol:medium  estimate=0.85  n=7",
				"2. anthropic/claude-opus-5.5:high  estimate=0.90  n=12",
				"reason: Cheapest pair with enough outcomes.",
				"task_type: code.bugfix  difficulty: medium  criticality: none",
				"explored: true  control: false  fallback_used: false",
			].join("\n"),
		);
	});

	test("text output marks dry-run suggestions", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi({
			suggest: async () => ({ ...suggestion, is_test: true }),
		});
		await main(["t", "--models", "m", "--dry-run"], io, api);
		expect(stdout().split("\n").at(-1)).toBe(
			"explored: true  control: false  fallback_used: false  (dry-run)",
		);
	});

	test("api error prints message on stderr and exits 1", async () => {
		const { io, err, out } = fakeIO();
		const { api } = fakeApi({
			suggest: async () => {
				throw new Error("db locked");
			},
		});
		const code = await main(["t", "--models", "m"], io, api);
		expect(code).toBe(1);
		expect(err.join("\n")).toContain("db locked");
		expect(out).toEqual([]);
	});
});

describe("--json", () => {
	test("suggest prints JSON of the api result", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi();
		const code = await main(["t", "--models", "m", "--json"], io, api);
		expect(code).toBe(0);
		expect(stdout()).toBe(JSON.stringify(suggestion));
	});

	test("report prints JSON of the api result", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi();
		const code = await main(
			[
				"report",
				"abc-123",
				"--model",
				"m",
				"--effort",
				"low",
				"--result",
				"pass",
				"--json",
			],
			io,
			api,
		);
		expect(code).toBe(0);
		expect(stdout()).toBe(JSON.stringify(outcome));
	});

	test("report prints JSON null when api returns null", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi({ report: async () => null });
		await main(
			[
				"report",
				"x",
				"--model",
				"m",
				"--effort",
				"low",
				"--result",
				"fail",
				"--json",
			],
			io,
			api,
		);
		expect(stdout()).toBe("null");
	});

	test("stats prints JSON of the api result", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi();
		const code = await main(["stats", "--json"], io, api);
		expect(code).toBe(0);
		expect(stdout()).toBe(JSON.stringify(statsReport));
	});
});

describe("report", () => {
	test("forwards explicit attempt and correction and returns the selected report", async () => {
		const { io, stdout } = fakeIO();
		const { api, calls } = fakeApi();
		expect(
			await main(
				[
					"report",
					"abc-123",
					"--model",
					"m",
					"--effort",
					"low",
					"--result",
					"pass",
					"--attempt",
					"attempt-2",
					"--correct",
					"--json",
				],
				io,
				api,
			),
		).toBe(0);
		expect(calls[0]?.args[0]).toEqual({
			suggestionId: "abc-123",
			model: "m",
			effort: "low",
			result: "pass",
			attempt: "attempt-2",
			correct: true,
		});
		expect(JSON.parse(stdout())).toEqual(outcome);
	});
	test("calls api.report with rounds as integer and note", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		const code = await main(
			[
				"report",
				"abc-123",
				"--model",
				"gpt-6-sol",
				"--effort",
				"medium",
				"--result",
				"partial",
				"--rounds",
				"3",
				"--note",
				"needed a hint",
			],
			io,
			api,
		);
		expect(code).toBe(0);
		expect(calls).toEqual([
			{
				method: "report",
				args: [
					{
						suggestionId: "abc-123",
						model: "gpt-6-sol",
						effort: "medium",
						result: "partial",
						rounds: 3,
						note: "needed a hint",
					},
				],
			},
		]);
	});

	test("omits rounds and note when not given", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		await main(
			[
				"report",
				"abc-123",
				"--model",
				"m",
				"--effort",
				"high",
				"--result",
				"pass",
			],
			io,
			api,
		);
		expect(calls[0]?.args[0]).toEqual({
			suggestionId: "abc-123",
			model: "m",
			effort: "high",
			result: "pass",
		});
	});

	test("text output names the suggestion and quality", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi();
		await main(
			[
				"report",
				"abc-123",
				"--model",
				"m",
				"--effort",
				"high",
				"--result",
				"pass",
			],
			io,
			api,
		);
		expect(stdout()).toContain("abc-123");
		expect(stdout()).toContain("quality: 1");
	});

	test("invalid --result exits 2 without calling api", async () => {
		const { io, err } = fakeIO();
		const { api, calls } = fakeApi();
		const code = await main(
			[
				"report",
				"abc-123",
				"--model",
				"m",
				"--effort",
				"high",
				"--result",
				"great",
			],
			io,
			api,
		);
		expect(code).toBe(2);
		expect(err.join("\n")).toContain("--result");
		expect(calls).toEqual([]);
	});

	test("non-integer --rounds exits 2", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		const code = await main(
			[
				"report",
				"x",
				"--model",
				"m",
				"--effort",
				"high",
				"--result",
				"pass",
				"--rounds",
				"1.5",
			],
			io,
			api,
		);
		expect(code).toBe(2);
		expect(calls).toEqual([]);
	});

	for (const rounds of ["9".repeat(400), "9007199254740993", "-1", ""]) {
		test(`--rounds ${rounds.slice(0, 20)}${rounds.length > 20 ? "..." : ""} exits 2 without calling api`, async () => {
			const { io, err } = fakeIO();
			const { api, calls } = fakeApi();
			const code = await main(
				[
					"report",
					"x",
					"--model",
					"m",
					"--effort",
					"high",
					"--result",
					"pass",
					"--rounds",
					rounds,
				],
				io,
				api,
			);
			expect(code).toBe(2);
			expect(err.join("\n")).toContain("--rounds");
			expect(calls).toEqual([]);
		});
	}

	test("--rounds accepts the largest safe integer", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		const code = await main(
			[
				"report",
				"x",
				"--model",
				"m",
				"--effort",
				"high",
				"--result",
				"pass",
				"--rounds",
				String(Number.MAX_SAFE_INTEGER),
			],
			io,
			api,
		);
		expect(code).toBe(0);
		expect(calls[0]?.args[0]).toMatchObject({
			rounds: Number.MAX_SAFE_INTEGER,
		});
	});

	test("missing id or required option exits 2", async () => {
		const { api, calls } = fakeApi();
		expect(
			await main(
				["report", "--model", "m", "--effort", "e", "--result", "pass"],
				fakeIO().io,
				api,
			),
		).toBe(2);
		expect(
			await main(
				["report", "x", "--effort", "e", "--result", "pass"],
				fakeIO().io,
				api,
			),
		).toBe(2);
		expect(
			await main(
				["report", "x", "--model", "m", "--result", "pass"],
				fakeIO().io,
				api,
			),
		).toBe(2);
		expect(calls).toEqual([]);
	});

	test("api error prints message on stderr and exits 1", async () => {
		const { io, err } = fakeIO();
		const { api } = fakeApi({
			report: async () => {
				throw new Error("unknown suggestion");
			},
		});
		const code = await main(
			["report", "x", "--model", "m", "--effort", "high", "--result", "pass"],
			io,
			api,
		);
		expect(code).toBe(1);
		expect(err.join("\n")).toContain("unknown suggestion");
	});
});

describe("hook", () => {
	test("reads stdin and calls api.handleHook, prints nothing, exits 0", async () => {
		const { io, out, err } = fakeIO(async () => '{"hook_event_name":"Stop"}');
		const { api, calls } = fakeApi();
		const code = await main(["hook", "Stop"], io, api);
		expect(code).toBe(0);
		expect(calls).toEqual([
			{ method: "handleHook", args: ["Stop", '{"hook_event_name":"Stop"}'] },
		]);
		expect(out).toEqual([]);
		expect(err).toEqual([]);
	});

	test("accepts --agent codex and keeps hook execution quiet", async () => {
		const { io, out, err } = fakeIO(async () => '{"hook_event_name":"Stop"}');
		const { api, calls } = fakeApi();
		expect(await main(["hook", "Stop", "--agent", "codex"], io, api)).toBe(0);
		expect(calls[0]?.args).toEqual([
			"codex:Stop",
			'{"hook_event_name":"Stop"}',
		]);
		expect(out).toEqual([]);
		expect(err).toEqual([]);
	});

	test("exits 0 when api.handleHook throws", async () => {
		const { io, out, err } = fakeIO();
		const { api } = fakeApi({
			handleHook: async () => {
				throw new Error("boom");
			},
		});
		expect(await main(["hook", "PostToolUse"], io, api)).toBe(0);
		expect(out).toEqual([]);
		expect(err).toEqual([]);
	});

	test("exits 0 when reading stdin throws", async () => {
		const { io, out } = fakeIO(async () => {
			throw new Error("stdin closed");
		});
		const { api, calls } = fakeApi();
		expect(await main(["hook", "Stop"], io, api)).toBe(0);
		expect(out).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("exits 0 without event or with --json", async () => {
		const { io, out } = fakeIO();
		const { api } = fakeApi();
		expect(await main(["hook"], io, api)).toBe(0);
		expect(await main(["hook", "Stop", "--json", "--weird"], io, api)).toBe(0);
		expect(out).toEqual([]);
	});
});

describe("cli.ts wiring (subprocess, temp HOME, no API keys)", () => {
	const cli = `${import.meta.dir}/cli.ts`;
	async function spawnCli(args: string[], stdin: string) {
		const home = await mkdtemp(join(tmpdir(), "spatz-cli-"));
		try {
			const proc = Bun.spawn([process.execPath, cli, ...args], {
				env: { HOME: home, PATH: process.env.PATH ?? "" },
				cwd: home,
				stdin: new TextEncoder().encode(stdin),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, out, err] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return { code, out, err };
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	test("hook exits 0 with no output, even if core wiring fails", async () => {
		const { code, out } = await spawnCli(["hook", "Stop"], "{}");
		expect(out).toBe("");
		expect(code).toBe(0);
	});

	test("usage error exits 2 before touching core", async () => {
		const { code, err } = await spawnCli([], "");
		expect(code).toBe(2);
		expect(err).toContain("usage");
	});
});

describe("stats", () => {
	test("calls api.stats with type", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		const code = await main(["stats", "--type", "code.bugfix"], io, api);
		expect(code).toBe(0);
		expect(calls).toEqual([
			{ method: "stats", args: [{ type: "code.bugfix" }] },
		]);
	});

	test("calls api.stats without type", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		await main(["stats"], io, api);
		expect(calls).toEqual([{ method: "stats", args: [{}] }]);
	});

	test("invalid --type exits 2", async () => {
		const { io, err } = fakeIO();
		const { api, calls } = fakeApi();
		expect(await main(["stats", "--type", "nope"], io, api)).toBe(2);
		expect(err.join("\n")).toContain("--type");
		expect(calls).toEqual([]);
	});

	test("text output: n, success rate per pair, adoption rate, tokens", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi();
		await main(["stats"], io, api);
		const text = stdout();
		expect(text).toContain("code.bugfix");
		expect(text).toContain("n=4");
		expect(text).toContain("openai/gpt-6-sol:medium");
		expect(text).toContain("67%");
		expect(text).toContain("anthropic/claude-opus-5.5:-");
		expect(text).toContain("100%");
		expect(text).toContain("adoption=75%");
		expect(text).toContain("input_tokens=1200");
		expect(text).toContain("output_tokens=340");
		expect(text).toContain("coverage: 80%");
	});

	test("text output: complete ordered lines incl. null success as -", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi();
		await main(["stats"], io, api);
		expect(stdout()).toBe(
			[
				"code.bugfix  n=4  adoption=75%  input_tokens=1200  output_tokens=340  cache_read_tokens=0  cache_creation_tokens=0  cost_usd=-",
				"  openai/gpt-6-sol:medium  n=3  success=67%",
				"  anthropic/claude-opus-5.5:-  n=1  success=100%",
				"coverage: 80%  learned_success: 70%  control_success: -",
				"dispatches: 0  routed_by_mod: 0  swapped: 0",
				"fallbacks: -",
				"failures: parse=0  hook=0  launcher=0",
			].join("\n"),
		);
	});

	test("text output: null learned_success and set control_success", async () => {
		const { io, stdout } = fakeIO();
		const { api } = fakeApi({
			stats: async () => ({
				by_type: [],
				coverage: 0,
				learned_success: null,
				control_success: 0.5,
				dispatches: 0,
				routed_by_mod: 0,
				swapped: 0,
				fallbacks: {},
				failures: { parse: 0, hook: 0, launcher: 0 },
			}),
		});
		await main(["stats"], io, api);
		expect(stdout()).toBe(
			"coverage: 0%  learned_success: -  control_success: 50%\ndispatches: 0  routed_by_mod: 0  swapped: 0\nfallbacks: -\nfailures: parse=0  hook=0  launcher=0",
		);
	});

	test("api error prints message on stderr and exits 1", async () => {
		const { io, err } = fakeIO();
		const { api } = fakeApi({
			stats: async () => {
				throw new Error("duckdb missing");
			},
		});
		expect(await main(["stats"], io, api)).toBe(1);
		expect(err.join("\n")).toContain("duckdb missing");
	});
});

describe("mod CLI", () => {
	test("attempt start, bind, and finalize carry stable execution identity", async () => {
		const seen: unknown[] = [];
		const { api } = fakeApi({
			startAttempt: async (input) => {
				seen.push(input);
				return { id: "a1" } as never;
			},
			bindAttempt: async (input) => {
				seen.push(input);
			},
			finalizeAttempts: async (input) => {
				seen.push(input);
			},
		});
		const { io, stdout } = fakeIO();
		expect(
			await main(
				[
					"attempt",
					"start",
					"s1",
					"--key",
					"t:0",
					"--model",
					"m",
					"--effort",
					"low",
					"--session",
					"session",
					"--agent-id",
					"child",
					"--turn",
					"t",
					"--owns-usage",
					"--json",
				],
				io,
				api,
			),
		).toBe(0);
		expect(JSON.parse(stdout())).toEqual({ id: "a1" });
		expect(
			await main(
				[
					"attempt",
					"bind",
					"a1",
					"--call",
					"call1",
					"--session",
					"session",
					"--agent-id",
					"child",
				],
				fakeIO().io,
				api,
			),
		).toBe(0);
		expect(
			await main(
				["attempt", "finalize", "--session", "session", "--agent-id", "child"],
				fakeIO().io,
				api,
			),
		).toBe(0);
		expect(seen).toEqual([
			{
				suggestionId: "s1",
				key: "t:0",
				model: "m",
				effort: "low",
				session: "session",
				agentId: "child",
				turn: "t",
				ownsUsage: true,
			},
			{ attempt: "a1", call: "call1", session: "session", agentId: "child" },
			{ session: "session", agentId: "child" },
		]);
		for (const args of [
			["attempt"],
			["attempt", "wat"],
			["attempt", "start", "s1"],
			["attempt", "bind", "a1"],
			["attempt", "finalize"],
		])
			expect(await main(args, fakeIO().io, api)).toBe(2);
	});
	test("suggest passes explicit linking flags and scope", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		expect(
			await main(
				[
					"task",
					"--models",
					"m",
					"--scope",
					"subagent",
					"--session",
					"s",
					"--turn",
					"t",
					"--agent-id",
					"a",
					"--source",
					"claude-code-mod",
				],
				io,
				api,
			),
		).toBe(0);
		expect(calls).toEqual([
			{
				method: "suggest",
				args: [
					{
						task: "task",
						models: "m",
						dryRun: false,
						scope: "subagent",
						session: "s",
						turn: "t",
						agentId: "a",
						source: "claude-code-mod",
					},
				],
			},
		]);
	});
	test("link passes the agent id and session and prints JSON", async () => {
		const { io, stdout } = fakeIO();
		const seen: unknown[] = [];
		const { api } = fakeApi({
			link: async (input) => {
				seen.push(input);
				return { suggestion_id: input.suggestionId } as never;
			},
		});
		expect(
			await main(
				["link", "id", "--agent-id", "a1", "--session", "s", "--json"],
				io,
				api,
			),
		).toBe(0);
		expect(seen).toEqual([{ suggestionId: "id", agentId: "a1", session: "s" }]);
		expect(JSON.parse(stdout())).toEqual({
			suggestion_id: "id",
			agent_id: "a1",
		});
		for (const argv of [
			["link", "--agent-id", "a1", "--session", "s"],
			["link", "id", "--session", "s"],
			["link", "id", "--agent-id", "a1"],
		])
			expect(await main(argv, fakeIO().io, fakeApi().api)).toBe(2);
	});

	test("usage passes token counts and turn and prints JSON", async () => {
		const { io, stdout } = fakeIO();
		const seen: unknown[] = [];
		const { api } = fakeApi({
			usage: async (input) => {
				seen.push(input);
				return { suggestion_id: input.suggestionId } as never;
			},
		});
		expect(
			await main(
				[
					"usage",
					"id",
					"--model",
					"m",
					"--input",
					"1",
					"--output",
					"2",
					"--cache-read",
					"3",
					"--cache-creation",
					"4",
					"--turn",
					"t",
					"--source",
					"claude-code-mod",
					"--cost-usd",
					"0.123",
					"--json",
				],
				io,
				api,
			),
		).toBe(0);
		expect(seen).toEqual([
			{
				suggestionId: "id",
				model: "m",
				costUsd: 0.123,
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheCreation: 4,
				turn: "t",
				source: "claude-code-mod",
			},
		]);
		expect(JSON.parse(stdout())).toEqual({ suggestion_id: "id" });
	});
	test.each([
		["0", 0],
		["0.123", 0.123],
		[".5", 0.5],
		["1.", 1],
		["1e-7", 1e-7],
		["", null],
		[" ", null],
		[" 1 ", null],
		["1\n", null],
		["0x10", null],
		["0b10", null],
		["0o10", null],
		["-1", null],
		["NaN", null],
		["Infinity", null],
		["1e309", null],
		["1usd", null],
	])("usage validates decimal --cost-usd %j", async (value, expected) => {
		const { io, err, out } = fakeIO();
		const seen: unknown[] = [];
		const { api } = fakeApi({
			usage: async (input) => {
				seen.push(input.costUsd);
				return { suggestion_id: input.suggestionId } as never;
			},
		});
		const code = await main(
			[
				"usage",
				"id",
				"--model",
				"m",
				"--input",
				"0",
				"--output",
				"0",
				"--cache-read",
				"0",
				"--cache-creation",
				"0",
				"--turn",
				"t",
				"--source",
				"claude-code-mod",
				`--cost-usd=${value}`,
			],
			io,
			api,
		);
		expect(code).toBe(expected === null ? 2 : 0);
		expect(seen).toEqual(expected === null ? [] : [expected]);
		if (expected === null) {
			expect(err.join("\n")).toContain("--cost-usd must be");
			expect(out).toEqual([]);
		} else expect(err).toEqual([]);
	});
	test("report passes the direct turn and source", async () => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		expect(
			await main(
				[
					"report",
					"id",
					"--model",
					"m",
					"--effort",
					"low",
					"--result",
					"pass",
					"--turn",
					"t",
					"--source",
					"claude-code-mod",
				],
				io,
				api,
			),
		).toBe(0);
		expect(calls[0]?.args).toEqual([
			{
				suggestionId: "id",
				model: "m",
				effort: "low",
				result: "pass",
				turn: "t",
				source: "claude-code-mod",
			},
		]);
	});
	test("scope stats print cache share and the unscoped line", async () => {
		const { io, stdout } = fakeIO();
		const seen: unknown[] = [];
		const { api } = fakeApi({
			stats: async (input) => {
				seen.push(input);
				return {
					...statsReport,
					by_scope: [
						{
							scope: null,
							n: 2,
							success_rate: 0.5,
							input_tokens: 10,
							output_tokens: 20,
							cache_read_tokens: 60,
							cache_creation_tokens: 30,
							cost_usd: null,
							cache_read_share: 0.6,
						},
					],
				};
			},
		});
		expect(await main(["stats", "--by", "scope"], io, api)).toBe(0);
		expect(seen).toEqual([{ by: "scope" }]);
		expect(stdout()).toContain(
			"unscoped  n=2  success=50%  input_tokens=10  output_tokens=20  cache_read_tokens=60  cache_creation_tokens=30  cache_read_share=60%  cost_usd=-",
		);
	});
	test.each(["-1", "1.5", "NaN", "9007199254740992", ""])(
		"usage rejects invalid token count %p before core",
		async (value) => {
			const { io, err } = fakeIO();
			const { api, calls } = fakeApi();
			expect(
				await main(
					[
						"usage",
						"id",
						"--model",
						"m",
						"--input",
						value,
						"--output",
						"0",
						"--cache-read",
						"0",
						"--cache-creation",
						"0",
						"--turn",
						"t",
						"--source",
						"claude-code-mod",
					],
					io,
					api,
				),
			).toBe(2);
			expect(err.join()).toContain("--input");
			expect(calls).toEqual([]);
		},
	);
	test.each([
		["--scope", "bogus"],
		["--source", "bogus"],
	])("suggest rejects %p %p", async (flag, value) => {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		expect(
			await main(
				["task", "--models", "m", flag as string, value as string],
				io,
				api,
			),
		).toBe(2);
		expect(calls).toEqual([]);
	});
});

test.each(["type", "scope", "json"])(
	"stats shows diagnostics with %p",
	async (mode) => {
		const flags =
			mode === "scope" ? ["--by", "scope"] : mode === "json" ? ["--json"] : [];
		const { io, stdout } = fakeIO();
		const { api } = fakeApi({
			stats: async () => ({
				...statsReport,
				...(flags.includes("scope") ? { by_scope: [] } : {}),
				fallbacks: { timeout: 2, unknown: 1 },
				failures: { parse: 3, hook: 4, launcher: 5 },
			}),
		});
		expect(await main(["stats", ...flags], io, api)).toBe(0);
		if (flags.includes("--json")) {
			expect(JSON.parse(stdout())).toMatchObject({
				fallbacks: { timeout: 2, unknown: 1 },
				failures: { parse: 3, hook: 4, launcher: 5 },
			});
		} else {
			expect(stdout()).toContain("fallbacks: timeout=2  unknown=1");
			expect(stdout()).toContain("failures: parse=3  hook=4  launcher=5");
		}
	},
);

test("import-rollout validates arguments and calls core", async () => {
	const seen: unknown[] = [];
	const { api } = fakeApi({
		importRollout: async (input) => {
			seen.push(input);
			return { suggestion_id: input.suggestionId, turns: 2 };
		},
	});
	const { io, stdout } = fakeIO();
	expect(
		await main(
			["import-rollout", "run.jsonl", "--suggestion", "id", "--json"],
			io,
			api,
		),
	).toBe(0);
	expect(seen).toEqual([{ file: "run.jsonl", suggestionId: "id" }]);
	expect(JSON.parse(stdout())).toEqual({ suggestion_id: "id", turns: 2 });
	for (const args of [
		["import-rollout"],
		["import-rollout", "run.jsonl"],
		["import-rollout", "--suggestion", "id"],
	])
		expect(await main(args, fakeIO().io, api)).toBe(2);
});

test("suggestion CLI forwards requested models and the explicit absent marker", async () => {
	for (const requested of ["opus", "-"]) {
		const { io } = fakeIO();
		const { api, calls } = fakeApi();
		expect(
			await main(
				["task", "--requested", requested, "--requested-agent", "pinned"],
				io,
				api,
			),
		).toBe(0);
		expect(calls[0]?.args[0]).toMatchObject({
			requested,
			requestedAgent: "pinned",
		});
	}
});

test("report forwards confirmation of an explicit attempt", async () => {
	const { io } = fakeIO();
	const { api, calls } = fakeApi();
	expect(
		await main(
			[
				"report",
				"abc-123",
				"--model",
				"m",
				"--effort",
				"low",
				"--result",
				"pass",
				"--attempt",
				"attempt-id",
				"--confirm",
			],
			io,
			api,
		),
	).toBe(0);
	expect(calls[0]?.args[0]).toMatchObject({
		attempt: "attempt-id",
		confirm: true,
	});
});
