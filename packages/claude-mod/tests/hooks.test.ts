import type {
	AgentSpawnInput,
	AgentSpawnResult,
	EngineInterface,
	On,
	ToolCallInput,
	ToolCallResult,
	TurnCompleteInput,
	TurnStartInput,
	TurnStepChunk,
	TurnStepInput,
	TurnStepResult,
} from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import { register } from "../hooks/register.ts";

type Options = Record<string, string | number | boolean>;
type Out = { exitCode: number; stdout: string; stderr: string };
const PLUGIN_ROOT = "/plugins/spatz-mod";

/** One Claude Code process: the hooks a mod registered plus a `$` that logs every call. */
function session(
	options: Options,
	over: {
		suggestion?: (n: number) => Out | Promise<Out>;
		plugins?: Out;
		link?: Out;
		sessionIdThrows?: boolean;
	} = {},
) {
	const registered = new Map<string, unknown>();
	register(
		((name: string, ...rest: unknown[]) => {
			registered.set(name, rest.at(-1));
		}) as unknown as On,
		options,
	);
	const argvs: string[][] = [];
	const timeouts: number[] = [];
	const toasts: string[] = [];
	const logs: string[] = [];
	const statuses: (string | undefined)[] = [];
	const commands: string[] = [];
	let n = 0;
	const $ = {
		plugin: { root: PLUGIN_ROOT },
		session: {
			id: () => {
				if (over.sessionIdThrows) throw new Error("no session");
				return Promise.resolve("sess1");
			},
		},
		process: {
			run: async (argv: string[], init: { timeoutMs: number }) => {
				argvs.push(argv);
				timeouts.push(init.timeoutMs);
				if (argv[0] === "claude")
					return over.plugins ?? { exitCode: 0, stdout: "[]", stderr: "" };
				const args = argv[0] === "sh" ? argv.slice(2) : argv.slice(1);
				if (args[0] === "usage")
					return { exitCode: 0, stdout: "{}", stderr: "" };
				if (args[0] === "link")
					return over.link ?? { exitCode: 0, stdout: "{}", stderr: "" };
				n++;
				if (over.suggestion) return over.suggestion(n);
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						suggestion_id: `s${n}`,
						ranking: [
							{ model: "anthropic/claude-sonnet-5.5", effort: "medium" },
						],
					}),
					stderr: "",
				};
			},
		},
		ui: {
			toast: (text: string) => toasts.push(text),
			status: (text: string | undefined) => statuses.push(text),
			log: (text: string) => logs.push(text),
		},
		command: {
			register: async (c: { name: string }) => {
				commands.push(c.name);
				return { command: c.name };
			},
		},
	} as unknown as EngineInterface;
	const hook = <T>(name: string) => registered.get(name) as T;
	const cliArgs = (argv: string[]) =>
		argv[0] === "sh" ? argv.slice(2) : argv.slice(1);
	const suggests = () =>
		argvs.filter(
			(a) =>
				!["usage", "link"].includes(cliArgs(a)[0] ?? "") && a[0] !== "claude",
		);
	const links = () => argvs.filter((a) => cliArgs(a)[0] === "link");
	const usages = () =>
		argvs
			.filter((a) => cliArgs(a)[0] === "usage")
			.map((a) => ["spatz", ...cliArgs(a)]);
	const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

	const spawn = (
		e: Partial<AgentSpawnInput>,
		reply: { agentId?: string; deny?: string } = { agentId: "a1" },
	) => {
		let passed: AgentSpawnInput | undefined;
		return hook<
			(
				$: EngineInterface,
				e: AgentSpawnInput,
				next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>,
			) => Promise<AgentSpawnResult>
		>("agent.spawn")(
			$,
			{
				tool_use_id: "tu1",
				prompt: "build the feature",
				fork: false,
				...e,
			} as AgentSpawnInput,
			async (input) => {
				passed = input;
				return reply.deny
					? { deny: reply.deny }
					: {
							model: input.model ?? "inherited",
							...(reply.agentId && { agentId: reply.agentId }),
						};
			},
		).then((result) => ({ result, passed: passed as AgentSpawnInput }));
	};

	const start = (turnId: string, text: string) => {
		let called = 0;
		return hook<
			(
				$: EngineInterface,
				e: TurnStartInput,
				next: (e: TurnStartInput) => Promise<{ turnId: string }>,
			) => Promise<{ turnId: string }>
		>("turn.start")($, { turnId, text }, async (e) => {
			called++;
			return { turnId: e.turnId };
		}).then(() => called);
	};

	const usage = {
		model: "claude-sonnet-5-5-20260101",
		input_tokens: 10,
		output_tokens: 20,
		cache_read_input_tokens: 30,
		cache_creation_input_tokens: 40,
	};
	/** Runs one model request through the step hook; resolves with the input the engine would send and the order of events. */
	const step = async (e: Partial<TurnStepInput> & { turnId: string }) => {
		const events: string[] = [];
		let seen: TurnStepInput | undefined;
		const stream = hook<
			(
				$: EngineInterface,
				e: TurnStepInput,
				next: (
					e: TurnStepInput,
				) => AsyncGenerator<TurnStepChunk, TurnStepResult>,
			) => AsyncGenerator<TurnStepChunk, TurnStepResult>
		>("turn.step")(
			$,
			{ index: 0, model: "inherited", messageCount: 1, ...e } as TurnStepInput,
			async function* (input) {
				seen = input;
				events.push(`yield after ${suggests().length} suggests`);
				yield { kind: "text", index: 0, text: "x" };
				return {
					turnId: input.turnId,
					index: input.index,
					answer: "",
					toolUses: [],
					stopReason: "end_turn",
					usage,
				} as TurnStepResult;
			},
		);
		let r = await stream.next();
		while (!r.done) r = await stream.next();
		return { seen: seen as TurnStepInput, events };
	};

	const bash = (
		command: string,
		agentId: string | undefined,
		isError: boolean,
	) =>
		hook<
			(
				$: EngineInterface,
				e: ToolCallInput,
				next: (e: ToolCallInput) => Promise<ToolCallResult>,
			) => Promise<ToolCallResult>
		>("tool.call")(
			$,
			{ tool: "Bash", command, tool_use_id: "t", agentId } as ToolCallInput,
			async () =>
				(isError
					? { isError: true, result: "failed" }
					: { result: { stdout: "" } }) as ToolCallResult,
		);

	const complete = (e: Partial<TurnCompleteInput> & { turnId: string }) =>
		hook<
			(
				$: EngineInterface,
				e: TurnCompleteInput,
				next: (e: TurnCompleteInput) => Promise<{ text: string }>,
			) => Promise<{ text: string }>
		>("turn.complete")(
			$,
			{
				answer: "",
				durationMs: 1,
				isAborted: false,
				reason: "answer",
				...e,
			} as TurnCompleteInput,
			async () => ({ text: "" }),
		);

	const command = async (args: string) => {
		const run =
			hook<
				(
					$: EngineInterface,
					e: { command: string; args: string },
				) => Promise<{ text: string }>
			>("command.run");
		return (await run($, { command: "spatz", args })).text;
	};
	const sessionStart = () =>
		hook<
			(
				$: EngineInterface,
				e: object,
				next: (e: object) => Promise<object>,
			) => Promise<object>
		>("session.start")($, {}, async (e) => e);

	return {
		spawn,
		start,
		step,
		bash,
		complete,
		command,
		sessionStart,
		argvs,
		timeouts,
		toasts,
		logs,
		links,
		statuses,
		commands,
		suggests,
		usages,
		flag,
	};
}

const LONG = "Refactor the pagination helper and add tests for it";
const apply = { mode: "apply", record: "off" } as const;
const SONNET_MEDIUM = { model: "claude-sonnet-5-5", effort: "medium" };

describe("subagent scope (default)", () => {
	test("spawn in apply mode passes the alias, keeps the full id for steps, links session and spawn", async () => {
		const s = session({ ...apply });
		const { passed } = await s.spawn({});
		expect(passed.model).toBe("sonnet");
		const [argv] = s.suggests() as [string[]];
		expect(s.flag(argv, "--scope")).toBe("subagent");
		expect(s.flag(argv, "--source")).toBe("claude-code-mod");
		// The agent id and session come with the link after the spawn resolves.
		expect(argv).not.toContain("--agent-id");
		expect(argv).not.toContain("--session");
		expect(s.links()).toEqual([
			[
				"sh",
				`${PLUGIN_ROOT}/bin/spatz`,
				"link",
				"s1",
				"--agent-id",
				"a1",
				"--session",
				"sess1",
			],
		]);
		const { seen } = await s.step({ turnId: "t1", agentId: "a1" });
		expect(seen).toMatchObject(SONNET_MEDIUM);
	});

	test("the default executable uses the plugin launcher through sh", async () => {
		const s = session({ ...apply });
		await s.spawn({});
		expect(s.suggests()[0]?.slice(0, 2)).toEqual([
			"sh",
			`${PLUGIN_ROOT}/bin/spatz`,
		]);
	});

	test("empty models omit the flag; explicit models override CLI defaults", async () => {
		for (const models of [undefined, "", " , ", "claude-opus-5-5:high"]) {
			const s = session({ ...apply, ...(models !== undefined && { models }) });
			await s.spawn({});
			const argv = s.suggests()[0] as string[];
			expect(argv.includes("--models")).toBe(models === "claude-opus-5-5:high");
			if (argv.includes("--models"))
				expect(s.flag(argv, "--models")).toBe(models);
		}
	});

	test("a custom executable passes through unchanged", async () => {
		const s = session({ ...apply, spatz: "/opt/bin/spatz-custom" });
		await s.spawn({});
		expect(s.suggests()[0]?.[0]).toBe("/opt/bin/spatz-custom");
	});

	test("failed recommendation calls log once and keep forwarding", async () => {
		const spawn = session(
			{ ...apply },
			{ suggestion: () => ({ exitCode: 127, stdout: "", stderr: "missing" }) },
		);
		const first = await spawn.spawn({});
		const second = await spawn.spawn({});
		expect(first.result.model).toBe("inherited");
		expect(second.result.model).toBe("inherited");
		expect(spawn.logs).toHaveLength(1);
		expect(spawn.toasts).toEqual([
			"spatz: CLI call failed, routing unchanged (details: claude --debug)",
		]);

		const step = session(
			{ ...apply, scope: "step", main: true },
			{ suggestion: () => ({ exitCode: 127, stdout: "", stderr: "missing" }) },
		);
		await step.start("t1", LONG);
		for (const index of [0, 1])
			expect((await step.step({ turnId: "t1", index })).seen.model).toBe(
				"inherited",
			);
		expect(step.logs).toHaveLength(1);
		expect(step.toasts).toHaveLength(1);
	});

	test("a model without an alias leaves the spawn alone and still applies it on steps", async () => {
		const s = session(
			{ ...apply },
			{
				suggestion: () => ({
					exitCode: 0,
					stdout: JSON.stringify({
						suggestion_id: "s1",
						ranking: [{ model: "anthropic/claude-sonnet-4.6", effort: "low" }],
					}),
					stderr: "",
				}),
			},
		);
		const { passed } = await s.spawn({});
		expect(passed.model).toBeUndefined();
		const { seen } = await s.step({ turnId: "t1", agentId: "a1" });
		expect(seen).toMatchObject({ model: "claude-sonnet-4-6", effort: "low" });
	});

	test("show mode never rewrites spawn or steps", async () => {
		const s = session({ mode: "show", record: "off" });
		const { passed } = await s.spawn({});
		expect(passed.model).toBeUndefined();
		const { seen } = await s.step({
			turnId: "t1",
			agentId: "a1",
			effort: "low",
		});
		expect(seen).toMatchObject({ model: "inherited", effort: "low" });
		expect(s.suggests()).toHaveLength(1);
	});

	test("off mode makes no call at all", async () => {
		const s = session({ mode: "off" });
		const { passed } = await s.spawn({});
		await s.step({ turnId: "t1", agentId: "a1" });
		await s.start("t2", LONG);
		expect(passed.model).toBeUndefined();
		expect(s.argvs).toEqual([]);
	});

	test("a failing link still associates the agent; a bad spawn result links nothing", async () => {
		const s = session(
			{ ...apply },
			{ link: { exitCode: 1, stdout: "", stderr: "x" } },
		);
		await s.spawn({});
		expect((await s.step({ turnId: "t1", agentId: "a1" })).seen).toMatchObject(
			SONNET_MEDIUM,
		);
		const none = session({ ...apply });
		await none.spawn({}, { deny: "no" });
		await none.spawn({}, {});
		expect(none.links()).toEqual([]);
	});

	test("a throwing decision leaves the step unchanged and logs once", async () => {
		const s = session(
			{ ...apply, scope: "step", main: true },
			{ sessionIdThrows: true },
		);
		await s.start("t1", LONG);
		for (const index of [0, 1]) {
			const { seen } = await s.step({ turnId: "t1", index, effort: "low" });
			expect(seen).toMatchObject({ model: "inherited", effort: "low" });
		}
		expect(s.logs).toHaveLength(1);
	});

	test("a denied spawn creates no association", async () => {
		const s = session({ ...apply });
		const { result } = await s.spawn({}, { deny: "no" });
		expect(result).toEqual({ deny: "no" });
		const { seen } = await s.step({ turnId: "t1", agentId: "a1" });
		expect(seen).toMatchObject({ model: "inherited" });
		expect(seen.effort).toBeUndefined();
	});

	test("a spawn result without agentId creates no association", async () => {
		const s = session({ ...apply });
		const { result } = await s.spawn({}, {});
		expect(result.agentId).toBeUndefined();
		const { seen } = await s.step({ turnId: "t1", agentId: "unknown" });
		expect(seen).toMatchObject({ model: "inherited" });
		expect(seen.effort).toBeUndefined();
	});

	test("forks are skipped", async () => {
		const s = session({ ...apply });
		const { passed } = await s.spawn({ fork: true, model: "inherited" });
		expect(passed.model).toBe("inherited");
		expect(s.argvs).toEqual([]);
	});

	test("a failing or malformed spatz leaves everything unchanged and calls next once", async () => {
		for (const bad of [
			{ exitCode: 1, stdout: "", stderr: "x" },
			{ exitCode: 0, stdout: "nope", stderr: "" },
		]) {
			const s = session({ ...apply }, { suggestion: () => bad });
			const { passed } = await s.spawn({});
			expect(passed.model).toBeUndefined();
			const { seen } = await s.step({ turnId: "t1", agentId: "a1" });
			expect(seen.model).toBe("inherited");
		}
		const hung = session(
			{ ...apply },
			{
				suggestion: () => {
					throw new Error("timed out");
				},
			},
		);
		expect((await hung.spawn({})).result.model).toBe("inherited");
	});

	test("no spatz call may wait longer than the 6 s bridge timeout", async () => {
		const s = session({ ...apply, record: "on", main: true });
		await s.spawn({});
		await s.step({ turnId: "t1", agentId: "a1" });
		await s.complete({
			turnId: "t1",
			agentId: "a1",
			usage: {
				model: "m",
				input_tokens: 1,
				output_tokens: 1,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		});
		expect(s.timeouts.length).toBeGreaterThan(2);
		for (const ms of s.timeouts) expect(ms).toBeLessThanOrEqual(6000);
	});

	test("turn and session scopes do not decide at spawn", async () => {
		for (const scope of ["turn", "session", "step"]) {
			const s = session({ ...apply, scope });
			await s.spawn({});
			expect(s.suggests()).toEqual([]);
		}
	});
});

describe("pinned choices and exploration", () => {
	const exploredHard = (critical = false) => ({
		suggestion: () => ({
			exitCode: 0,
			stdout: JSON.stringify({
				suggestion_id: "s1",
				ranking: [{ model: "anthropic/claude-sonnet-5.5", effort: "low" }],
				classification: {
					task_type: "review",
					difficulty: "hard",
					criticality: critical ? "high" : "none",
				},
				explored: true,
			}),
			stderr: "",
		}),
	});

	for (const scope of [
		"subagent",
		"step",
		"escalate",
		"turn",
		"session",
	] as const) {
		test(`${scope}: an explicit model or a pinned agent type is not routed, nor are its steps`, async () => {
			for (const e of [{ model: "opus" }, { subagentType: "Explore" }]) {
				const s = session({ ...apply, scope });
				const { passed } = await s.spawn(e);
				expect(passed.model).toBe(e.model);
				expect(s.suggests()).toEqual([]);
				const { seen } = await s.step({ turnId: "t1", agentId: "a1" });
				expect(seen.model).toBe("inherited");
				expect(s.suggests()).toEqual([]);
			}
		});
	}

	test("general-purpose is routed; respectPinned off routes pinned types too", async () => {
		const s = session({ ...apply });
		expect(
			(await s.spawn({ subagentType: "general-purpose" })).passed.model,
		).toBe("sonnet");
		const off = session({ ...apply, respectPinned: false });
		expect(
			(await off.spawn({ subagentType: "Explore", model: "opus" })).passed
				.model,
		).toBe("sonnet");
	});

	test("an explored pick on a hard or critical task is dropped unless exploreHard is on", async () => {
		for (const critical of [false, true]) {
			const s = session({ ...apply }, exploredHard(critical));
			expect((await s.spawn({})).passed.model).toBeUndefined();
			const on = session(
				{ ...apply, exploreHard: true },
				exploredHard(critical),
			);
			expect((await on.spawn({})).passed.model).toBe("sonnet");
		}
	});
});

describe("turn scope", () => {
	test("decides at turn.start with the turn id and rewrites every step of that turn", async () => {
		const s = session({ ...apply, scope: "turn", main: true });
		expect(await s.start("t1", LONG)).toBe(1);
		const [argv] = s.suggests() as [string[]];
		expect(s.flag(argv, "--scope")).toBe("turn");
		expect(s.flag(argv, "--turn")).toBe("t1");
		expect(s.flag(argv, "--session")).toBe("sess1");
		expect(argv).not.toContain("--agent-id");
		for (const index of [0, 1]) {
			const { seen } = await s.step({ turnId: "t1", index });
			expect(seen).toMatchObject(SONNET_MEDIUM);
		}
		expect(s.suggests()).toHaveLength(1);
	});

	test("main steps stay untouched without the main setting", async () => {
		const s = session({ ...apply, scope: "turn" });
		await s.start("t1", LONG);
		const { seen } = await s.step({ turnId: "t1" });
		expect(seen.model).toBe("inherited");
		expect(s.suggests()).toHaveLength(1);
	});

	test("show mode decides but never rewrites, and the band shows the scope", async () => {
		const s = session({
			mode: "show",
			scope: "turn",
			main: true,
			record: "off",
		});
		await s.start("t1", LONG);
		const { seen } = await s.step({ turnId: "t1" });
		expect(seen.model).toBe("inherited");
		expect(s.statuses.at(-1)).toContain("turn");
		expect(s.statuses.at(-1)).toContain("claude-sonnet-5-5");
	});

	test("short prompts skip the call and keep the last decision", async () => {
		const s = session({ ...apply, scope: "turn", main: true });
		await s.start("t0", "hi");
		expect((await s.step({ turnId: "t0" })).seen.model).toBe("inherited");
		await s.start("t1", LONG);
		await s.start("t2", "yes");
		expect(s.suggests()).toHaveLength(1);
		expect((await s.step({ turnId: "t2" })).seen).toMatchObject(SONNET_MEDIUM);
	});

	test("the length limit is configurable", async () => {
		const s = session({
			...apply,
			scope: "turn",
			main: true,
			minPromptChars: 2,
		});
		await s.start("t1", "yes");
		expect(s.suggests()).toHaveLength(1);
	});

	test("turn.start always forwards once, also when spatz fails", async () => {
		const s = session(
			{ ...apply, scope: "turn", main: true },
			{ suggestion: () => ({ exitCode: 1, stdout: "", stderr: "" }) },
		);
		expect(await s.start("t1", LONG)).toBe(1);
		expect((await s.step({ turnId: "t1" })).seen.model).toBe("inherited");
	});
});

describe("step scope", () => {
	test("decides on every step before the first yield, for main and subagents", async () => {
		const s = session({ ...apply, scope: "step", main: true });
		await s.start("t1", LONG);
		expect(s.suggests()).toEqual([]);
		const first = await s.step({ turnId: "t1", index: 0 });
		expect(first.events).toEqual(["yield after 1 suggests"]);
		expect(first.seen).toMatchObject(SONNET_MEDIUM);
		await s.step({ turnId: "t1", index: 1 });
		expect(s.suggests()).toHaveLength(2);
		const [argv] = s.suggests() as [string[]];
		expect(s.flag(argv, "--scope")).toBe("step");
		expect(s.flag(argv, "--turn")).toBe("t1");
		await s.spawn({});
		expect(s.suggests()).toHaveLength(2);
		const sub = await s.step({ turnId: "t9", agentId: "a1" });
		expect(s.suggests()).toHaveLength(3);
		expect(sub.seen).toMatchObject(SONNET_MEDIUM);
		expect(s.flag(s.suggests()[2] as string[], "--agent-id")).toBe("a1");
	});

	test("show mode decides per step without rewriting; main needs the setting", async () => {
		const shown = session({
			mode: "show",
			scope: "step",
			main: true,
			record: "off",
		});
		await shown.start("t1", LONG);
		expect((await shown.step({ turnId: "t1" })).seen.model).toBe("inherited");
		expect(shown.suggests()).toHaveLength(1);
		const gated = session({ ...apply, scope: "step" });
		await gated.start("t1", LONG);
		expect((await gated.step({ turnId: "t1" })).seen.model).toBe("inherited");
	});
});

describe("session scope", () => {
	test("decides at the first turn only and rewrites every step of the session", async () => {
		const s = session({ ...apply, scope: "session", main: true });
		await s.start("t1", "hi");
		await s.start("t2", LONG);
		expect(s.suggests()).toHaveLength(1);
		const [argv] = s.suggests() as [string[]];
		expect(s.flag(argv, "--scope")).toBe("session");
		expect(s.flag(argv, "--turn")).toBe("t1");
		for (const turnId of ["t1", "t2", "t3"])
			expect((await s.step({ turnId })).seen).toMatchObject(SONNET_MEDIUM);
	});

	test("show mode does not rewrite", async () => {
		const s = session({
			mode: "show",
			scope: "session",
			main: true,
			record: "off",
		});
		await s.start("t1", LONG);
		expect((await s.step({ turnId: "t1" })).seen.model).toBe("inherited");
	});
});

describe("escalate scope", () => {
	const sessionWith = (extra: Options = {}) =>
		session(
			{
				...apply,
				scope: "escalate",
				main: true,
				models:
					"claude-opus-5-5:low+medium+high,claude-sonnet-5-5:low+medium+high",
				...extra,
			},
			{
				suggestion: (n) => ({
					exitCode: 0,
					stdout: JSON.stringify({
						suggestion_id: `s${n}`,
						ranking: [{ model: "anthropic/claude-sonnet-5.5", effort: "high" }],
					}),
					stderr: "",
				}),
			},
		);

	test("subagent runs: decides at spawn, then moves up after two failing test results", async () => {
		const s = sessionWith();
		await s.spawn({});
		expect(s.flag(s.suggests()[0] as string[], "--scope")).toBe("escalate");
		await s.bash("bun test", "a1", true);
		expect((await s.step({ turnId: "t1", agentId: "a1" })).seen).toMatchObject({
			model: "claude-sonnet-5-5",
			effort: "high",
		});
		await s.bash("bun run build", "a1", true);
		expect((await s.step({ turnId: "t1", agentId: "a1" })).seen).toMatchObject({
			model: "claude-opus-5-5",
			effort: "low",
		});
		expect(s.toasts.at(-1)).toContain("claude-opus-5-5");
	});

	test("main turns: decides at turn.start and escalates within the turn only", async () => {
		const s = sessionWith({ escalateAfter: 2 });
		await s.start("t1", LONG);
		await s.bash("cargo test", undefined, true);
		await s.bash("cargo test", undefined, true);
		expect((await s.step({ turnId: "t1" })).seen).toMatchObject({
			model: "claude-opus-5-5",
			effort: "low",
		});
		await s.start("t2", "ok");
		expect((await s.step({ turnId: "t2" })).seen).toMatchObject({
			model: "claude-sonnet-5-5",
			effort: "high",
		});
	});

	test("passing results, other commands and show mode do not escalate", async () => {
		const s = sessionWith();
		await s.spawn({});
		await s.bash("bun test", "a1", false);
		await s.bash("bun test", "a1", false);
		await s.bash("ls missing", "a1", true);
		await s.bash("ls missing", "a1", true);
		await s.bash("bun test", "b2", true);
		expect((await s.step({ turnId: "t1", agentId: "a1" })).seen.effort).toBe(
			"high",
		);
		const shown = session({ mode: "show", scope: "escalate", record: "off" });
		await shown.spawn({});
		await shown.bash("bun test", "a1", true);
		await shown.bash("bun test", "a1", true);
		expect((await shown.step({ turnId: "t1", agentId: "a1" })).seen.model).toBe(
			"inherited",
		);
	});

	test("the threshold is configurable", async () => {
		const s = sessionWith({ escalateAfter: 1 });
		await s.spawn({});
		await s.bash("bun test", "a1", true);
		expect((await s.step({ turnId: "t1", agentId: "a1" })).seen.model).toBe(
			"claude-opus-5-5",
		);
	});
});

describe("record", () => {
	const turnUsage = {
		model: "claude-sonnet-5-5-20260101",
		input_tokens: 10,
		output_tokens: 20,
		cache_read_input_tokens: 30,
		cache_creation_input_tokens: 40,
	};

	test("on: usage after each step and at turn.complete, keyed by turn", async () => {
		const s = session({ mode: "show", scope: "turn", record: "on" });
		await s.start("t1", LONG);
		await s.step({ turnId: "t1" });
		expect(s.usages()).toHaveLength(1);
		const [argv] = s.usages() as [string[]];
		expect(argv.slice(0, 3)).toEqual(["spatz", "usage", "s1"]);
		expect(s.flag(argv, "--model")).toBe("claude-sonnet-5-5-20260101");
		expect(s.flag(argv, "--turn")).toBe("t1");
		expect(s.flag(argv, "--input")).toBe("10");
		expect(s.flag(argv, "--output")).toBe("20");
		expect(s.flag(argv, "--cache-read")).toBe("30");
		expect(s.flag(argv, "--cache-creation")).toBe("40");
		expect(s.flag(argv, "--source")).toBe("claude-code-mod");
		await s.complete({
			turnId: "t1",
			usage: { ...turnUsage, output_tokens: 25 },
		});
		expect(s.usages()).toHaveLength(2);
		expect(s.flag(s.usages()[1] as string[], "--output")).toBe("25");
	});

	test("a subagent run records under its own turn id", async () => {
		const s = session({ mode: "show", record: "on" });
		await s.spawn({});
		await s.step({ turnId: "run1", agentId: "a1" });
		await s.complete({ turnId: "run1", agentId: "a1", usage: turnUsage });
		expect(s.usages().map((u) => s.flag(u, "--turn"))).toEqual([
			"run1",
			"run1",
		]);
	});

	test("complete without usage records nothing; unknown turns record nothing", async () => {
		const s = session({ mode: "show", record: "on" });
		await s.spawn({});
		await s.complete({ turnId: "run1", agentId: "a1" });
		await s.complete({ turnId: "other", usage: turnUsage });
		expect(s.usages()).toEqual([]);
	});

	test("off records nothing", async () => {
		const s = session({ mode: "show", record: "off" });
		await s.spawn({});
		await s.step({ turnId: "run1", agentId: "a1" });
		await s.complete({ turnId: "run1", agentId: "a1", usage: turnUsage });
		expect(s.usages()).toEqual([]);
	});

	test("auto disables recording for the new hooks plugin and ignores the mod id", async () => {
		for (const id of ["spatz@spatz", "spatz-hooks@spatz"]) {
			const s = session(
				{ mode: "show", record: "auto" },
				{
					plugins: {
						exitCode: 0,
						stdout: JSON.stringify([
							{ id: "spatz-mod@spatz", enabled: true },
							{ id, enabled: true },
						]),
						stderr: "",
					},
				},
			);
			await s.spawn({});
			await s.step({ turnId: "r1", agentId: "a1" });
			await s.complete({ turnId: "r1", agentId: "a1", usage: turnUsage });
			expect(s.usages()).toEqual([]);
			expect(
				s.toasts.filter((t) => t.includes("usage recording is off")),
			).toHaveLength(1);
		}
		const mod = session(
			{ mode: "show", record: "auto" },
			{
				plugins: {
					exitCode: 0,
					stdout: JSON.stringify([{ id: "spatz-mod@spatz", enabled: true }]),
					stderr: "",
				},
			},
		);
		await mod.spawn({});
		await mod.step({ turnId: "r1", agentId: "a1" });
		expect(mod.usages()).toHaveLength(1);
	});

	test("auto records when hooks plugin is missing, disabled or the lookup fails", async () => {
		for (const plugins of [
			{ exitCode: 0, stdout: "[]", stderr: "" },
			{
				exitCode: 0,
				stdout: JSON.stringify([{ id: "spatz-mod@spatz", enabled: true }]),
				stderr: "",
			},
			{
				exitCode: 0,
				stdout: JSON.stringify([{ id: "spatz-hooks@spatz", enabled: false }]),
				stderr: "",
			},
			{ exitCode: 1, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "nope", stderr: "" },
		]) {
			const s = session({ mode: "show", record: "auto" }, { plugins });
			await s.spawn({});
			await s.step({ turnId: "r1", agentId: "a1" });
			expect(s.usages()).toHaveLength(1);
			expect(s.toasts).toEqual([]);
		}
	});

	test("step scope records each step against its own suggestion", async () => {
		const s = session({ mode: "show", scope: "step", record: "on" });
		await s.start("t1", LONG);
		await s.step({ turnId: "t1", index: 0 });
		await s.step({ turnId: "t1", index: 1 });
		await s.complete({ turnId: "t1", usage: turnUsage });
		expect(s.usages().map((u) => u[2])).toEqual(["s1", "s2"]);
	});
});

describe("/spatz command", () => {
	test("registers on session start and still starts the session when it fails", async () => {
		const s = session({});
		await s.sessionStart();
		expect(s.commands).toEqual(["spatz"]);
	});

	test("status names mode, scope, record and the last decision", async () => {
		const s = session({ mode: "show", scope: "turn", record: "on" });
		expect(await s.command("")).toContain("mode: show");
		expect(await s.command("status")).toContain("scope: turn");
		expect(await s.command("status")).toContain("record: on");
		expect(await s.command("status")).toContain("last: none yet");
		await s.start("t1", LONG);
		expect(await s.command("status")).toContain(
			"last: claude-sonnet-5-5:medium (turn)",
		);
	});

	test("mode, scope, record and main change the live behaviour", async () => {
		const s = session({ mode: "show", record: "off" });
		expect(await s.command("mode apply")).toContain("mode is now apply");
		expect(await s.command("scope turn")).toContain("scope is now turn");
		expect(await s.command("main on")).toContain("main is now on");
		expect(await s.command("record on")).toContain("record is now on");
		await s.start("t1", LONG);
		expect((await s.step({ turnId: "t1" })).seen).toMatchObject(SONNET_MEDIUM);
		expect(s.usages()).toHaveLength(1);
		await s.command("main off");
		expect((await s.step({ turnId: "t1" })).seen.model).toBe("inherited");
		await s.command("mode off");
		expect(s.statuses.at(-1)).toBeUndefined();
		const before = s.argvs.length;
		await s.start("t2", LONG);
		expect(s.argvs.length).toBe(before);
	});

	test("bad arguments answer with the usage and change nothing", async () => {
		const s = session({ mode: "show" });
		for (const args of [
			"mode loud",
			"scope",
			"main maybe",
			"nope",
			"mode apply now",
		])
			expect(await s.command(args)).toContain("usage: /spatz");
		expect(await s.command("status")).toContain("mode: show");
	});
});

test("default candidates accept and escalate through catalog xhigh and max", async () => {
	const s = session(
		{ ...apply, scope: "escalate", escalateAfter: 1 },
		{
			suggestion: () => ({
				exitCode: 0,
				stderr: "",
				stdout: JSON.stringify({
					suggestion_id: "s1",
					ranking: [{ model: "anthropic/claude-sonnet-5.5", effort: "xhigh" }],
					candidates: [
						{ model: "anthropic/claude-sonnet-5.5", effort: "xhigh" },
						{ model: "anthropic/claude-sonnet-5.5", effort: "max" },
					],
				}),
			}),
		},
	);
	await s.spawn({});
	expect((await s.step({ turnId: "t1", agentId: "a1" })).seen.effort).toBe(
		"xhigh",
	);
	await s.bash("bun test", "a1", true);
	expect((await s.step({ turnId: "t1", agentId: "a1" })).seen.effort).toBe(
		"max",
	);
	await s.bash("bun test", "a1", true);
	expect((await s.step({ turnId: "t1", agentId: "a1" })).seen.effort).toBe(
		"max",
	);
});

test("none changes only the model at spawn and step, then escalates to a reasoning model", async () => {
	for (const configured of [false, true]) {
		const s = session(
			{
				...apply,
				scope: "escalate",
				escalateAfter: 1,
				...(configured && {
					models: "claude-sonnet-5-5:ultra+max,claude-haiku-4-5-20251001:none",
				}),
			},
			{
				suggestion: () => ({
					exitCode: 0,
					stderr: "",
					stdout: JSON.stringify({
						suggestion_id: "s1",
						ranking: [{ model: "anthropic/claude-haiku-4.5", effort: "none" }],
						candidates: [
							{ model: "anthropic/claude-haiku-4.5", effort: "none" },
							{ model: "anthropic/claude-sonnet-5.5", effort: "max" },
							{ model: "anthropic/claude-sonnet-5.5", effort: "ultra" },
						],
					}),
				}),
			},
		);
		const spawned = await s.spawn({});
		expect(spawned.passed.model).toBe("haiku");
		expect(spawned.passed).not.toHaveProperty("effort");
		const inherited = await s.step({
			turnId: "t1",
			agentId: "a1",
			effort: "low",
		});
		expect(inherited.seen).toMatchObject({
			model: "claude-haiku-4-5-20251001",
			effort: "low",
		});
		expect(
			(await s.step({ turnId: "t1", agentId: "a1" })).seen.effort,
		).toBeUndefined();
		await s.bash("bun test", "a1", true);
		expect((await s.step({ turnId: "t1", agentId: "a1" })).seen).toMatchObject({
			model: "claude-sonnet-5-5",
			effort: "max",
		});
		await s.bash("bun test", "a1", true);
		expect((await s.step({ turnId: "t1", agentId: "a1" })).seen.effort).toBe(
			"max",
		);
	}
});
