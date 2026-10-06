// End to end: spawns the real CLI against a temp HOME and database. No network:
// the OpenRouter cache is pre-filled and fresh, Jev is disabled, and a dead proxy
// makes any accidental fetch fail fast.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Outcome, StatsReport, Suggestion } from "@spatz/core";
import openRouterFixture from "../../core/src/catalog/fixtures/openrouter-models.json";
import { parseOpenRouterModels } from "../../core/src/catalog/openrouter.ts";
import codexHooks from "../../core/src/signals/fixtures/codex-hook-inputs.json";
import { SCHEMA_VERSION } from "../../core/src/store/index.ts";
import hookEvents from "./fixtures/hook-events.json";

const CLI = join(import.meta.dir, "cli.ts");
const SIGNAL_FIXTURES = join(
	import.meta.dir,
	"../../core/src/signals/fixtures",
);
const TASK =
	"Fix the off-by-one error in the pagination helper in src/list.ts; the tests in list.test.ts fail.";
const MODELS = "claude-opus-5-5:high+medium,claude-sonnet-5-5:medium+low";
const SESSION = hookEvents.spatzCall.session_id;
const PROMPT = hookEvents.spatzCall.prompt_id;

let home: string;
let dbPath: string;
let transcriptStart: number;
let transcriptEarliest: number;

/** Keep fixture source order within the real suggestion/report window. */
async function shiftedTranscript(name: string): Promise<string> {
	let text = await Bun.file(join(SIGNAL_FIXTURES, name)).text();
	if (name === "main-transcript.jsonl") {
		const calls = [undefined, undefined, hookEvents.agentTool];
		let index = 0;
		text = text
			.split("\n")
			.map((line) => {
				if (!line) return line;
				const row = JSON.parse(line);
				if (row.message?.content?.[0]?.type === "tool_use") {
					const call = calls[index++];
					if (call)
						row.message.content = [
							{
								type: "tool_use",
								id: call.tool_use_id,
								name: call.tool_name,
								input: call.tool_input,
							},
						];
				}
				return JSON.stringify(row);
			})
			.join("\n");
		// Main-session verification follows the captured child execution in source order.
		text +=
			"\n" +
			[hookEvents.testPass, hookEvents.buildFail]
				.map((call, index) =>
					JSON.stringify({
						type: "assistant",
						uuid: `verify-entry-${index}`,
						timestamp: `2026-10-03T22:19:${28 + index}.000Z`,
						message: {
							id: `verify-message-${index}`,
							model: "claude-sonnet-5-5",
							usage: {
								input_tokens: 0,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
							content: [
								{
									type: "tool_use",
									id: call.tool_use_id,
									name: call.tool_name,
									input: call.tool_input,
								},
							],
						},
					}),
				)
				.join("\n");
	}
	const stamps = [...text.matchAll(/"timestamp": *"([^"]+)"/g)].map((m) =>
		Date.parse(m[1] as string),
	);
	if (name === "main-transcript.jsonl") {
		transcriptStart = Date.now();
		transcriptEarliest = Math.min(...stamps);
	}
	const path = join(home, name);
	await Bun.write(
		path,
		text.replace(
			/"timestamp": *"([^"]+)"/g,
			(_, t: string) =>
				`"timestamp": "${new Date(transcriptStart + Math.round((Date.parse(t) - transcriptEarliest) / 1000)).toISOString()}"`,
		),
	);
	return path;
}
let mainTranscript: string;
let subagentTranscript: string;

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "spatz-e2e-"));
	dbPath = join(home, ".spatz", "spatz.db");
	mainTranscript = await shiftedTranscript("main-transcript.jsonl");
	subagentTranscript = await shiftedTranscript("subagent-transcript.jsonl");
	await Bun.write(
		join(home, ".spatz", "openrouter-models.json"),
		JSON.stringify({
			fetched_at: Date.now(),
			models: parseOpenRouterModels(openRouterFixture),
		}),
	);
	// Pre-installed DuckDB sqlite extension, so stats never downloads.
	await symlink(
		process.env.SPATZ_DUCKDB_EXTENSION_DIR ??
			join(homedir(), ".spatz", "duckdb-extensions"),
		join(home, ".spatz", "duckdb-extensions"),
	);
});

afterAll(async () => {
	await rm(home, { recursive: true, force: true });
});

async function spatz(args: string[], stdin?: string, env = {}) {
	const proc = Bun.spawn([process.execPath, CLI, ...args], {
		cwd: home,
		// Explicit env: no API keys reach the child.
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			SPATZ_NO_JEV: "1",
			HTTPS_PROXY: "http://127.0.0.1:9",
			HTTP_PROXY: "http://127.0.0.1:9",
			...env,
		},
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

/** Hook fixture as stdin JSON, placeholders filled in. */
function hookJson(event: object, stdout = "") {
	return JSON.stringify(event)
		.replaceAll("$MAIN_TRANSCRIPT", mainTranscript)
		.replaceAll("$SUBAGENT_TRANSCRIPT", subagentTranscript)
		.replace('"$STDOUT"', JSON.stringify(stdout));
}

const hook = (event: { hook_event_name: string }, stdout?: string) =>
	spatz(["hook", event.hook_event_name], hookJson(event, stdout));
function db() {
	return new Database(dbPath, { readonly: true });
}

let firstId: string;
let linkedId: string;
let linkedStdout: string;

test("newer database schemas fail CLI commands but both hook families exit silently", async () => {
	const futureHome = await mkdtemp(join(tmpdir(), "spatz-future-"));
	const path = join(futureHome, ".spatz", "spatz.db");
	await Bun.write(path, "");
	const future = new Database(path);
	try {
		future.run(
			await Bun.file(
				join(import.meta.dir, "../../core/src/store/fixtures/v5.sql"),
			).text(),
		);
		future.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		for (const args of [
			["stats", "--json"],
			[TASK, "--models", MODELS, "--dry-run", "--json"],
		]) {
			const result = await spatz(args, undefined, {
				HOME: futureHome,
				SPATZ_NO_NETWORK: "1",
			});
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(
				new RegExp(`schema.*${SCHEMA_VERSION + 1}.*upgrade.*CLI`, "i"),
			);
		}
		for (const args of [
			["hook", "Stop"],
			["hook", "Stop", "--agent", "codex"],
		]) {
			const result = await spatz(
				args,
				JSON.stringify({
					hook_event_name: "Stop",
					session_id: "session",
					cwd: futureHome,
				}),
				{ HOME: futureHome, SPATZ_NO_NETWORK: "1" },
			);
			expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
		}
		expect(future.query("PRAGMA user_version").get()).toEqual({
			user_version: SCHEMA_VERSION + 1,
		});
		expect(future.query("SELECT COUNT(*) AS n FROM failures").get()).toEqual({
			n: 1,
		});
	} finally {
		future.close();
		await rm(futureHome, { recursive: true, force: true });
	}
});

describe("suggest", () => {
	test("without Jev: rule fallback picks the most expensive pair (--json)", async () => {
		const r = await spatz([TASK, "--models", `${MODELS},gpt-6-luna`, "--json"]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		const s: Suggestion = JSON.parse(r.stdout);
		firstId = s.suggestion_id;
		expect(s.fallback_used).toBe(true);
		expect(s.is_test).toBe(false);
		// One random draw per suggestion: 10 % control, 10 % exploration, else rules.
		expect(s.strategy).toBe(s.control ? "strongest" : "rules");
		expect(s.explored && s.control).toBe(false);
		expect(s.classification).toEqual({
			task_type: "other",
			difficulty: "medium",
			criticality: "none",
		});
		expect(s.ranking.length).toBeGreaterThanOrEqual(1);
		expect(s.ranking.length).toBeLessThanOrEqual(3);
		const top = s.ranking[0];
		const opusHigh =
			top?.model === "anthropic/claude-opus-5.5" && top.effort === "high";
		expect(opusHigh).toBe(!s.explored);
	});

	test("the database holds the suggestion but never the task text", async () => {
		const d = db();
		try {
			const row = d
				.query("SELECT * FROM suggestions WHERE id = ?")
				.get(firstId) as Record<string, unknown>;
			expect(row).toMatchObject({ is_test: 0, fallback_used: 1 });
			const dump = JSON.stringify(d.query("SELECT * FROM suggestions").all());
			expect(dump).not.toContain("off-by-one");
			expect(dump).not.toContain("pagination");
		} finally {
			d.close();
		}
	});

	test("--models without efforts expands to low, medium, high", async () => {
		const r = await spatz([TASK, "--models", "gpt-6-luna", "--json"]);
		expect(r.code).toBe(0);
		const s: Suggestion = JSON.parse(r.stdout);
		// Exploration may pick a cheaper effort; the catalog is luna low < medium < high.
		const top = s.ranking[0];
		expect(top?.model).toBe("openai/gpt-6-luna");
		expect(top?.effort).toBe(s.explored ? "low" : "high");
		if (!s.explored) expect(s.ranking.map((e) => e.effort)).toEqual(["high"]);
	});

	test("text output starts with the suggestion_id line; --dry-run marks it", async () => {
		const r = await spatz([TASK, "--models", MODELS, "--dry-run"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/^suggestion_id: [0-9a-f-]{36}\n1\. /);
		expect(r.stdout).toContain("(dry-run)");
		expect(r.stdout).toContain("fallback_used: true");
	});

	test("no models and no harness is a usage error (exit 2)", async () => {
		const r = await spatz([TASK]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("No candidate models found");
		expect(r.stdout).toBe("");
	});

	test("unknown effort in --models fails with exit 1", async () => {
		const r = await spatz([TASK, "--models", "claude-opus-5-5:turbo"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('unknown effort "turbo"');
	});
});

describe("hook", () => {
	test("Codex hook flag routes the real Codex input quietly", async () => {
		const event = codexHooks.calls[0];
		if (!event) throw new Error("missing Codex fixture call");
		expect(
			await spatz(
				["hook", event.hook_event_name, "--agent", "codex"],
				JSON.stringify(event),
			),
		).toEqual({ stdout: "", stderr: "", code: 0 });
	});
	test("a spatz call in Bash links the session to the suggestion", async () => {
		const s = await spatz([TASK, "--models", MODELS, "--json"]);
		linkedStdout = s.stdout;
		linkedId = (JSON.parse(s.stdout) as Suggestion).suggestion_id;
		mainTranscript = await shiftedTranscript("main-transcript.jsonl");
		subagentTranscript = await shiftedTranscript("subagent-transcript.jsonl");
		const r = await hook(hookEvents.spatzCall, linkedStdout);
		expect(r).toEqual({ stdout: "", stderr: "", code: 0 });
		const d = db();
		try {
			expect(
				d
					.query("SELECT session_id, prompt_id FROM suggestions WHERE id = ?")
					.get(linkedId),
			).toEqual({ session_id: SESSION, prompt_id: PROMPT });
		} finally {
			d.close();
		}
	});

	test("concurrent hook processes lose no link", async () => {
		// Dry-runs stay out of the stats below.
		const outs = await Promise.all(
			Array.from({ length: 12 }, () =>
				spatz([TASK, "--models", MODELS, "--dry-run", "--json"]),
			),
		);
		const runs = outs.map((s, i) => ({
			stdout: s.stdout,
			id: (JSON.parse(s.stdout) as Suggestion).suggestion_id,
			session: `race-${i}`,
		}));
		const results = await Promise.all(
			runs.map((r) =>
				spatz(
					["hook", "PostToolUse"],
					hookJson(
						{ ...hookEvents.spatzCall, session_id: r.session },
						r.stdout,
					),
				),
			),
		);
		for (const r of results) expect(r.code).toBe(0);
		const d = db();
		try {
			for (const r of runs)
				expect(
					d.query("SELECT session_id FROM suggestions WHERE id = ?").get(r.id),
				).toEqual({ session_id: r.session });
		} finally {
			d.close();
		}
	});

	test("test, build, Stop, SubagentStop and Agent events write signals and usages", async () => {
		for (const e of [
			hookEvents.testPass,
			hookEvents.buildFail,
			hookEvents.agentTool,
			hookEvents.subagentStop,
			hookEvents.stop,
			// Both are ignored by spec ("Hook rules").
			hookEvents.handback,
			hookEvents.agentMessage,
		]) {
			expect(await hook(e)).toEqual({ stdout: "", stderr: "", code: 0 });
		}
		const d = db();
		try {
			expect(
				d
					.query(
						"SELECT kind, value, weight FROM latest_attempt_events WHERE suggestion_id = ? AND kind IN ('test', 'build') ORDER BY kind",
					)
					.all(linkedId),
			).toEqual([
				{ kind: "build", value: 0, weight: 0.8 },
				{ kind: "test", value: 1, weight: 1 },
			]);
			const usages = d
				.query(
					"SELECT model, effort, agent_key, output_tokens FROM latest_attempt_events WHERE suggestion_id = ? AND kind = 'usage'",
				)
				.all(linkedId) as Record<string, unknown>[];
			expect(usages.length).toBeGreaterThan(0);
			expect(
				usages
					.filter((u) => u.agent_key !== "")
					.every((u) => u.effort === null),
			).toBe(true);
			expect(usages.reduce((n, u) => n + Number(u.output_tokens ?? 0), 0)).toBe(
				445,
			);
			// Hook-only outcome: weighted mean of the latest test (1, w 1) and build (0, w 0.8).
			const o = d
				.query("SELECT quality FROM outcomes WHERE suggestion_id = ?")
				.get(linkedId) as { quality: number };
			expect(o.quality).toBeCloseTo(1 / 1.8, 6);
		} finally {
			d.close();
		}
	});

	test("bad input, unknown events and a broken store still exit 0 silently", async () => {
		const quiet = { stdout: "", stderr: "", code: 0 };
		expect(await spatz(["hook", "Nope"], "not json")).toEqual(quiet);
		expect(await spatz(["hook"], "")).toEqual(quiet);
		// HOME is a file: the store cannot open.
		const file = join(home, "not-a-dir");
		await Bun.write(file, "x");
		expect(
			await spatz(["hook", "PostToolUse"], hookJson(hookEvents.testPass), {
				HOME: file,
			}),
		).toEqual(quiet);
	});
});

describe("report", () => {
	test("report overrides hook signals and closes the suggestion (--json)", async () => {
		const r = await spatz([
			"report",
			linkedId,
			"--model",
			"claude-sonnet-5-5",
			"--effort",
			"medium",
			"--result",
			"pass",
			"--rounds",
			"2",
			"--note",
			"ok",
			"--json",
		]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		const o: Outcome = JSON.parse(r.stdout);
		expect(o).toMatchObject({
			suggestion_id: linkedId,
			quality: 1,
			model: "anthropic/claude-sonnet-5.5",
			effort: "medium",
		});
	});

	test("after the report no suggestion of the session is open", async () => {
		const before = await countSignals();
		expect((await hook(hookEvents.testPass)).code).toBe(0);
		expect(await countSignals()).toBe(before);
	});

	test("text output names the suggestion and quality", async () => {
		const r = await spatz([
			"report",
			firstId,
			"--model",
			"claude-opus-5-5",
			"--effort",
			"high",
			"--result",
			"partial",
		]);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(
			`reported: ${firstId}  quality: 0.5  pair: anthropic/claude-opus-5.5:high\n`,
		);
	});

	test("unknown suggestion_id exits 1, invalid --result exits 2", async () => {
		const unknown = await spatz([
			"report",
			"00000000-0000-0000-0000-000000000000",
			"--model",
			"m",
			"--effort",
			"low",
			"--result",
			"pass",
		]);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("unknown suggestion_id");
		const bad = await spatz([
			"report",
			linkedId,
			"--model",
			"m",
			"--effort",
			"low",
			"--result",
			"great",
		]);
		expect(bad.code).toBe(2);
	});
});

async function countSignals() {
	const d = db();
	try {
		return (
			d
				.query(
					"SELECT COUNT(*) AS n FROM attempt_events WHERE kind IN ('test', 'build', 'report')",
				)
				.get() as { n: number }
		).n;
	} finally {
		d.close();
	}
}

describe("stats", () => {
	test("--json aggregates per task_type, excludes dry-runs", async () => {
		const r = await spatz(["stats", "--json"]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		const s: StatsReport = JSON.parse(r.stdout);
		const other = s.by_type.find((t) => t.task_type === "other");
		// Main verification and its report score the same delegated attempt.
		expect(other?.n).toBe(2);
		expect(other?.pairs).toEqual([
			{
				model: "anthropic/claude-opus-5.5",
				effort: "high",
				n: 1,
				success_rate: 0,
			},
			{
				model: "anthropic/claude-sonnet-5.5",
				effort: "medium",
				n: 1,
				success_rate: 1,
			},
		]);
		expect(other?.output_tokens).toBeGreaterThan(0);
		expect(other).toHaveProperty("incomplete", expect.any(Number));
		expect(other?.incomplete).toBeGreaterThan(0);
		expect(s.coverage).toBeCloseTo(2 / 3, 6);
	});

	test("--type filters; text output lists pairs and coverage", async () => {
		const r = await spatz(["stats", "--type", "other"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/^other {2}n=2 /);
		expect(r.stdout).toContain(
			"anthropic/claude-sonnet-5.5:medium  n=1  success=100%",
		);
		expect(r.stdout).toContain("coverage: 67%");
		const bad = await spatz(["stats", "--type", "bogus"]);
		expect(bad.code).toBe(2);
	});
});

test("mod CLI stores explicit attribution, usage replays, direct reports and scope stats", async () => {
	const suggested = await spatz([
		TASK,
		"--models",
		MODELS,
		"--session",
		"mod-session",
		"--turn",
		"turn-1",
		"--agent-id",
		"agent-1",
		"--scope",
		"subagent",
		"--source",
		"claude-code-mod",
		"--json",
	]);
	expect(suggested.code).toBe(0);
	const { suggestion_id: id } = JSON.parse(suggested.stdout) as Suggestion;
	const usageArgs = [
		"usage",
		id,
		"--model",
		"claude-sonnet-5-5",
		"--effort",
		"low",
		"--input",
		"10",
		"--output",
		"20",
		"--cache-read",
		"60",
		"--cache-creation",
		"30",
		"--turn",
		"turn-1",
		"--source",
		"claude-code-mod",
		"--json",
	];
	for (let n = 0; n < 2; n++) {
		const used = await spatz(usageArgs);
		expect(used.code).toBe(0);
		expect(JSON.parse(used.stdout)).toMatchObject({
			suggestion_id: id,
			turn_id: "turn-1",
			scope_key: "turn-1",
			agent_id: "agent-1",
			source: "claude-code-mod",
			is_sidechain: true,
		});
	}
	const reportArgs = [
		"report",
		id,
		"--model",
		"claude-sonnet-5-5",
		"--effort",
		"low",
		"--result",
		"pass",
		"--turn",
		"turn-1",
		"--source",
		"claude-code-mod",
		"--json",
	];
	for (let n = 0; n < 2; n++) expect((await spatz(reportArgs)).code).toBe(0);
	const d = db();
	try {
		expect(
			d
				.query(
					"SELECT scope, agent, session_id, turn_id, agent_id FROM suggestions WHERE id = ?",
				)
				.get(id),
		).toEqual({
			scope: "subagent",
			agent: "claude-code-mod",
			session_id: "mod-session",
			turn_id: "turn-1",
			agent_id: "agent-1",
		});
		expect(
			d
				.query(
					"SELECT COUNT(*) AS n FROM latest_attempt_events WHERE suggestion_id = ? AND source = 'claude-code-mod' AND kind = 'usage'",
				)
				.get(id),
		).toEqual({ n: 1 });
		expect(
			d
				.query(
					"SELECT COUNT(*) AS n FROM attempt_events WHERE kind IN ('test', 'build', 'report') AND suggestion_id = ?",
				)
				.get(id),
		).toEqual({ n: 1 });
	} finally {
		d.close();
	}
	const stats = await spatz(["stats", "--by", "scope", "--json"]);
	expect(stats.code).toBe(0);
	const scopes = (JSON.parse(stats.stdout) as StatsReport).by_scope;
	expect(scopes?.find((r) => r.scope === "subagent")).toEqual({
		scope: "subagent",
		n: 1,
		success_rate: 1,
		input_tokens: 10,
		output_tokens: 20,
		cache_read_tokens: 60,
		cache_creation_tokens: 30,
		cost_usd: 0.000307,
		incomplete: 0,
		cache_read_share: 0.6,
	});
	expect(scopes?.some((r) => r.scope === null)).toBe(true);
});

describe("candidate resolution CLI", () => {
	test.each([
		[
			{ CLAUDECODE: "1", CODEX_COMPANION_SESSION_ID: "plugin" },
			"preset:claude-code",
			"anthropic/",
		],
		[{ CODEX_THREAD_ID: "inner", CLAUDECODE: "1" }, "preset:codex", "openai/"],
		[{ SPATZ_MODELS: "gpt-6-luna:low", CLAUDECODE: "1" }, "env", "openai/"],
	] as const)("resolves %j", async (env, source, prefix) => {
		const r = await spatz([TASK, "--dry-run", "--json"], undefined, env);
		expect(r.code).toBe(0);
		const s: Suggestion = JSON.parse(r.stdout);
		expect(s.models_source).toBe(source);
		expect(s.ranking.every((c) => c.model.startsWith(prefix))).toBe(true);
	});

	test("flag > env > project > user > preset through real config files", async () => {
		const user = join(home, ".spatz/config.json");
		const project = join(home, ".spatz.json");
		try {
			await Bun.write(user, JSON.stringify({ models: "gpt-6-luna:low" }));
			const run = async (args: string[] = [], env = { CLAUDECODE: "1" }) => {
				const r = await spatz(
					[TASK, "--dry-run", "--json", ...args],
					undefined,
					env,
				);
				expect(r.code).toBe(0);
				return JSON.parse(r.stdout) as Suggestion;
			};
			expect((await run()).models_source).toBe("user");
			await Bun.write(
				project,
				JSON.stringify({ jev: false, models: "claude-sonnet-5-5:medium" }),
			);
			expect((await run()).models_source).toBe("project");
			const env = { CLAUDECODE: "1", SPATZ_MODELS: "gpt-6-astra:high" };
			expect((await run([], env)).models_source).toBe("env");
			const explicit = await run(
				["--models", "claude-opus-5-5:high,gpt-6-luna:low", "--family", "gpt"],
				env,
			);
			expect(explicit.models_source).toBe("flag");
			expect(explicit.ranking.map((c) => c.model)).toEqual([
				"openai/gpt-6-luna",
			]);
			await Bun.write(project, JSON.stringify({ models: [] }));
			const invalid = await spatz([TASK]);
			expect(invalid.code).toBe(2);
			expect(invalid.stderr).toContain("models must be a string");
			expect((await run(["--models", "gpt-6-luna"])).models_source).toBe(
				"flag",
			);
		} finally {
			await rm(user, { force: true });
			await rm(project, { force: true });
		}
	});

	test.each(["claude", "anthropic", "gpt", "openai"])(
		"--family %s filters explicit models",
		async (family) => {
			const r = await spatz([
				TASK,
				"--models",
				"claude-opus-5-5,gpt-6-luna",
				"--family",
				family,
				"--dry-run",
				"--json",
			]);
			expect(r.code).toBe(0);
			const s: Suggestion = JSON.parse(r.stdout);
			const prefix =
				family === "claude" || family === "anthropic"
					? "anthropic/"
					: "openai/";
			expect(s.ranking.every((c) => c.model.startsWith(prefix))).toBe(true);
			expect(s.models_source).toBe("flag");
		},
	);

	test.each([
		[["--family", "gpt"], { CLAUDECODE: "1" }, 2, "no matching candidates"],
		[
			["--models", "gpt-6-luna", "--family", "unknown"],
			{},
			2,
			"--family must be",
		],
		[[], { CODEX_COMPANION_SESSION_ID: "plugin" }, 2, "--models"],
		[[], { SPATZ_MODELS: "" }, 2, "No candidate models found"],
		[
			[],
			{ SPATZ_MODELS: "gpt-6-luna:turbo" },
			1,
			"SPATZ_MODELS: unknown effort",
		],
		[["--models", " "], {}, 2, "No candidate models found"],
	] as [string[], Record<string, string>, number, string][])(
		"rejects %j with %j",
		async (args, env, code, message) => {
			const r = await spatz([TASK, ...args], undefined, env);
			expect(r.code).toBe(code);
			expect(r.stdout).toBe("");
			expect(r.stderr).toContain(message);
			if (code === 2) expect(r.stderr).toContain("usage:");
		},
	);
});

test("none and ultra survive CLI validation, storage, reports and stats", async () => {
	for (const [model, effort] of [
		["claude-haiku-4-5-20251001", "none"],
		["gpt-6-sol", "ultra"],
	] as const) {
		const suggested = await spatz([
			TASK,
			"--models",
			`${model}:${effort}`,
			"--json",
		]);
		expect(suggested.code).toBe(0);
		const suggestion: Suggestion = JSON.parse(suggested.stdout);
		expect(suggestion.ranking[0]?.effort).toBe(effort);
		const reported = await spatz([
			"report",
			suggestion.suggestion_id,
			"--model",
			model,
			"--effort",
			effort,
			"--result",
			"pass",
			"--json",
		]);
		expect(reported.code).toBe(0);
		expect(JSON.parse(reported.stdout).effort).toBe(effort);
		const stats = await spatz(["stats", "--json"]);
		expect(stats.code).toBe(0);
		const pairs = (JSON.parse(stats.stdout) as StatsReport).by_type.flatMap(
			(t) => t.pairs,
		);
		expect(
			pairs.some(
				(p) =>
					p.model === suggestion.ranking[0]?.model &&
					p.effort === effort &&
					p.n === 1,
			),
		).toBe(true);
		expect((await spatz(["stats"])).stdout).toContain(
			`${suggestion.ranking[0]?.model}:${effort}  n=1`,
		);
	}
});

test("stats exposes stored fallback reasons and failures from real hook processes", async () => {
	const before = JSON.parse(
		(await spatz(["stats", "--json"])).stdout,
	) as StatsReport;
	const suggestion = JSON.parse(
		(await spatz([TASK, "--models", MODELS, "--json"])).stdout,
	) as Suggestion;
	const db = new Database(dbPath, { readonly: true });
	try {
		expect(
			db
				.query("SELECT fallback_reason FROM suggestions WHERE id = ?")
				.get(suggestion.suggestion_id),
		).toEqual({ fallback_reason: "opt_out" });
	} finally {
		db.close();
	}
	const path = join(home, "unknown-format.jsonl");
	await Bun.write(path, '{"type":"future_format"}');
	const stop = JSON.stringify({
		session_id: "diagnostic-session",
		prompt_id: "diagnostic-turn",
		transcript_path: path,
		hook_event_name: "Stop",
	});
	for (let i = 0; i < 2; i++)
		expect((await spatz(["hook", "Stop"], stop)).code).toBe(0);
	expect((await spatz(["hook", "Stop"], "not json")).code).toBe(0);
	await Bun.write(join(home, ".spatz/launcher-failures"), "1\n1\n");
	const result = await spatz(["stats", "--json"]);
	expect(result.code).toBe(0);
	const report = JSON.parse(result.stdout) as StatsReport;
	expect(report.fallbacks.opt_out).toBe((before.fallbacks.opt_out ?? 0) + 1);
	expect(report.failures).toEqual({
		parse: before.failures.parse + 1,
		hook: before.failures.hook + 1,
		launcher: 2,
	});
	const text = await spatz(["stats", "--by", "scope"]);
	expect(text.code).toBe(0);
	expect(text.stdout).toContain(
		`fallbacks: opt_out=${report.fallbacks.opt_out}`,
	);
	expect(text.stdout).toContain(
		`failures: parse=${report.failures.parse}  hook=${report.failures.hook}  launcher=2`,
	);
});

test("Codex environment link and fallback import persist the same run", async () => {
	const suggested = await spatz([
		TASK,
		"--models",
		"gpt-6-luna:low",
		"--dry-run",
		"--json",
	]);
	expect(suggested.code).toBe(0);
	const id = JSON.parse(suggested.stdout).suggestion_id;
	const file = join(SIGNAL_FIXTURES, "codex-command-events.jsonl");
	const stopped = await spatz(
		["hook", "Stop", "--agent", "codex"],
		JSON.stringify({
			hook_event_name: "Stop",
			session_id: "exec-child",
			turn_id: "todo-turn",
			transcript_path: file,
		}),
		{ SPATZ_SUGGESTION_ID: id },
	);
	expect(stopped).toEqual({ code: 0, stdout: "", stderr: "" });
	const imported = await spatz([
		"import-rollout",
		file,
		"--suggestion",
		id,
		"--json",
	]);
	expect(imported.code).toBe(0);
	expect(JSON.parse(imported.stdout)).toEqual({ suggestion_id: id, turns: 3 });
	const conn = db();
	try {
		expect(
			conn
				.query(
					"SELECT source, output_tokens, tokens_schema FROM latest_attempt_events WHERE suggestion_id = ? AND kind = 'usage'",
				)
				.all(id),
		).toEqual([{ source: "transcript", output_tokens: 674, tokens_schema: 2 }]);
		expect(
			conn
				.query(
					"SELECT COUNT(*) AS n FROM attempt_events WHERE kind IN ('test', 'build', 'report') AND suggestion_id = ?",
				)
				.get(id),
		).toEqual({ n: 4 });
	} finally {
		conn.close();
	}
});

test("concurrent hook processes allocate attempts, replay starts, and retain late signals and usage", async () => {
	const grown = new Database(dbPath);
	try {
		grown.run(
			`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<22000)
   INSERT INTO attempt_events(harness,session_key,agent_key,event_id,revision,binding,kind,source,received_at)
   SELECT 'claude-code','grown-' || i,'','pending',0,'pending','test','hook',? FROM n`,
			[Date.now()],
		);
	} finally {
		grown.close();
	}
	const suggested = await spatz([
		TASK,
		"--models",
		"gpt-6-sol:low",
		"--dry-run",
		"--json",
	]);
	expect(suggested.code).toBe(0);
	const id = JSON.parse(suggested.stdout).suggestion_id as string;
	const at = Date.now() + 1000;
	const runs = await Promise.all(
		Array.from({ length: 6 }, async (_, i) => {
			const session = `attempt-race-${i}`;
			const turn = `turn-${i}`;
			const file = join(home, `race-${i}.jsonl`);
			await Bun.write(
				file,
				[
					{ type: "session_meta", payload: { id: session } },
					{
						timestamp: new Date(at).toISOString(),
						type: "turn_context",
						payload: {
							turn_id: turn,
							model: "gpt-6-sol",
							effort: i % 2 ? "high" : "low",
						},
					},
					{
						timestamp: new Date(at + 1).toISOString(),
						type: "event_msg",
						payload: {
							type: "item_completed",
							turn_id: turn,
							item: {
								type: "CommandExecution",
								id: `exec-${i}`,
								command: ["bash", "-lc", "bun test"],
								exit_code: 0,
							},
						},
					},
					{
						timestamp: new Date(at + 2).toISOString(),
						type: "token_usage_record",
						ordinal: 4,
						payload: {
							turn_id: turn,
							turn_token_usage: {
								input_tokens: 100,
								cached_input_tokens: 20,
								cache_write_input_tokens: 0,
								output_tokens: i + 1,
							},
						},
					},
				]
					.map((row) => JSON.stringify(row))
					.join("\n"),
			);
			return JSON.stringify({
				hook_event_name: "Stop",
				session_id: session,
				turn_id: turn,
				transcript_path: file,
			});
		}),
	);
	const replies = await Promise.all(
		[...runs, ...runs].map((stdin) =>
			spatz(["hook", "Stop", "--agent", "codex"], stdin, {
				SPATZ_SUGGESTION_ID: id,
			}),
		),
	);
	for (const reply of replies)
		expect(reply).toEqual({ code: 0, stdout: "", stderr: "" });
	const conn = db();
	try {
		expect(
			conn
				.query(
					"SELECT ordinal FROM attempts WHERE suggestion_id = ? ORDER BY ordinal",
				)
				.all(id),
		).toEqual(Array.from({ length: 6 }, (_, i) => ({ ordinal: i + 1 })));
		expect(
			conn
				.query(
					"SELECT COUNT(*) AS n, SUM(output_tokens) AS output FROM usage_totals WHERE suggestion_id = ?",
				)
				.get(id),
		).toEqual({ n: 6, output: 21 });
		expect(
			conn
				.query(
					"SELECT COUNT(*) AS n FROM attempt_events WHERE suggestion_id = ? AND kind = 'test'",
				)
				.get(id),
		).toEqual({ n: 6 });
	} finally {
		conn.close();
	}

	const late = await spatz([
		TASK,
		"--models",
		"claude-sonnet-5-5:low",
		"--dry-run",
		"--json",
	]);
	const lateId = JSON.parse(late.stdout).suggestion_id as string;
	const file = join(home, "late-race.jsonl");
	const lateAt = Date.now() + 1000;
	await Bun.write(
		file,
		[
			{
				type: "user",
				uuid: "p-race",
				promptId: "p-race",
				timestamp: new Date(lateAt).toISOString(),
			},
			{
				type: "assistant",
				uuid: "entry",
				timestamp: new Date(lateAt + 2).toISOString(),
				message: {
					id: "message-race",
					model: "claude-sonnet-5-5",
					usage: {
						input_tokens: 1,
						output_tokens: 2,
						cache_read_input_tokens: 3,
						cache_creation_input_tokens: 4,
					},
					content: [
						{
							type: "tool_use",
							id: "call-race",
							name: "Bash",
							input: { command: "bun test" },
						},
					],
				},
			},
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	const context = {
		session_id: "late-race",
		prompt_id: "p-race",
		transcript_path: file,
		effort: { level: "low" },
	};
	const signal = {
		...context,
		hook_event_name: "PostToolUse",
		tool_name: "Bash",
		tool_use_id: "call-race",
		tool_input: { command: "bun test" },
		tool_response: { stdout: "" },
	};
	const stop = { ...context, hook_event_name: "Stop" };
	await Promise.all(
		[signal, stop].map((e) =>
			spatz(["hook", e.hook_event_name], JSON.stringify(e)),
		),
	);
	const link = {
		...context,
		hook_event_name: "PostToolUse",
		tool_name: "Bash",
		tool_use_id: "link-race",
		tool_input: { command: 'spatz "task" --json' },
		tool_response: { stdout: late.stdout },
	};
	for (const result of await Promise.all(
		[link, stop, signal, link, stop].map((e) =>
			spatz(["hook", e.hook_event_name], JSON.stringify(e)),
		),
	))
		expect(result.code).toBe(0);
	const final = db();
	try {
		expect(
			final
				.query(
					"SELECT SUM(output_tokens) AS output FROM usage_totals WHERE suggestion_id = ?",
				)
				.get(lateId),
		).toEqual({ output: 2 });
		expect(
			final
				.query(
					"SELECT COUNT(*) AS n FROM attempt_events WHERE suggestion_id = ? AND kind = 'test' AND binding <> 'pending'",
				)
				.get(lateId),
		).toEqual({ n: 1 });
		expect(
			final
				.query(
					"SELECT COUNT(*) AS n FROM failures WHERE event = 'codex:Stop' AND session_id LIKE 'attempt-race-%'",
				)
				.get(),
		).toEqual({ n: 0 });
	} finally {
		final.close();
	}
}, 30_000);
