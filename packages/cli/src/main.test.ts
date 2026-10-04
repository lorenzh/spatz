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
		difficulty: "mittel",
		criticality: "none",
	},
	fallback_used: false,
	explored: true,
	control: false,
	strategy: "learned",
	is_test: false,
};

const outcome: Outcome = {
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
			adoption_rate: 0.75,
			input_tokens: 1200,
			output_tokens: 340,
		},
	],
	coverage: 0.8,
	learned_success: 0.7,
	control_success: null,
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

	test("missing --models prints to stderr and exits 2", async () => {
		const { io, err } = fakeIO();
		const { api, calls } = fakeApi();
		const code = await main(["fix bug"], io, api);
		expect(code).toBe(2);
		expect(err.join("\n")).toContain("--models");
		expect(calls).toEqual([]);
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
				"task_type: code.bugfix  difficulty: mittel  criticality: none",
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
				"code.bugfix  n=4  adoption=75%  input_tokens=1200  output_tokens=340",
				"  openai/gpt-6-sol:medium  n=3  success=67%",
				"  anthropic/claude-opus-5.5:-  n=1  success=100%",
				"coverage: 80%  learned_success: 70%  control_success: -",
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
			}),
		});
		await main(["stats"], io, api);
		expect(stdout()).toBe(
			"coverage: 0%  learned_success: -  control_success: 50%",
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
