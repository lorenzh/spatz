import type {
	AgentSpawnInput,
	AgentSpawnResult,
	EngineInterface,
	On,
	TurnStepChunk,
	TurnStepInput,
	TurnStepResult,
} from "claude-code";
import { expect, test } from "claude-code/testing";
import { register } from "../hooks/register.ts";

const suggestion = JSON.stringify({
	suggestion_id: "s1",
	ranking: [{ model: "anthropic/claude-sonnet-5.5", effort: "medium" }],
});

function hooks(options: { mode: string; scope?: string }) {
	const registered = new Map<string, unknown>();
	register(
		((name: string, handler: unknown) => {
			registered.set(name, handler);
		}) as unknown as On,
		options,
	);
	return registered;
}

const api = (stdout = suggestion) =>
	({
		process: { run: async () => ({ exitCode: 0, stdout, stderr: "" }) },
	}) as unknown as EngineInterface;
type SpawnHook = (
	$: EngineInterface,
	e: AgentSpawnInput,
	next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>,
) => Promise<AgentSpawnResult>;
type StepHook = (
	$: EngineInterface,
	e: TurnStepInput,
	next: (e: TurnStepInput) => AsyncGenerator<TurnStepChunk, TurnStepResult>,
) => AsyncGenerator<TurnStepChunk, TurnStepResult>;

test("agent.spawn rewrites model in apply mode and remembers the decision", async () => {
	const on = hooks({ mode: "apply" });
	let passed: AgentSpawnInput | undefined;
	const spawn = on.get("agent.spawn") as SpawnHook;
	const result = await spawn(
		api(),
		{
			prompt: "build feature",
			model: "inherited",
			fork: false,
		} as AgentSpawnInput,
		async (e) => {
			passed = e;
			return { model: e.model ?? "inherited", agentId: "a1" };
		},
	);
	expect(passed.model).toBe("claude-sonnet-5-5");
	expect(result.agentId).toBe("a1");
	const inputs: TurnStepInput[] = [];
	const step = on.get("turn.step") as StepHook;
	const stream = step(
		api(),
		{
			turnId: "t1",
			index: 0,
			model: "inherited",
			messageCount: 1,
			agentId: "a1",
		},
		async function* (e) {
			inputs.push(e);
			yield { kind: "text", index: 0, text: "" };
			return {
				turnId: e.turnId,
				index: e.index,
				answer: "",
				toolUses: [],
				stopReason: "end_turn",
				usage: null,
			};
		},
	);
	let last = await stream.next();
	while (!last.done) last = await stream.next();
	expect(inputs[0]).toMatchObject({
		model: "claude-sonnet-5-5",
		effort: "medium",
	});
});

test("show records a decision without rewriting spawn", async () => {
	const on = hooks({ mode: "show" });
	let passed: AgentSpawnInput | undefined;
	const spawn = on.get("agent.spawn") as SpawnHook;
	await spawn(
		api(),
		{
			prompt: "build feature",
			model: "inherited",
			fork: false,
		} as AgentSpawnInput,
		async (e) => {
			passed = e;
			return { model: e.model ?? "inherited", agentId: "a2" };
		},
	);
	expect(passed.model).toBe("inherited");
});

test("unknown agents pass through and forks keep inherited model", async () => {
	const on = hooks({ mode: "apply" });
	let forkInput: AgentSpawnInput | undefined;
	const spawn = on.get("agent.spawn") as SpawnHook;
	await spawn(
		api(),
		{ prompt: "fork task", fork: true, model: "inherited" } as AgentSpawnInput,
		async (e) => {
			forkInput = e;
			return { model: e.model ?? "inherited", agentId: "fork-agent" };
		},
	);
	expect(forkInput.model).toBe("inherited");
	const step = on.get("turn.step") as StepHook;
	let passed: TurnStepInput | undefined;
	const stream = step(
		api(),
		{
			turnId: "unknown",
			index: 0,
			model: "original",
			effort: "low",
			messageCount: 1,
			agentId: "unknown",
		},
		async function* (e) {
			passed = e;
			yield { kind: "text", index: 0, text: "" };
			return {
				turnId: e.turnId,
				index: e.index,
				answer: "",
				toolUses: [],
				stopReason: "end_turn",
				usage: null,
			};
		},
	);
	let last = await stream.next();
	while (!last.done) last = await stream.next();
	expect(passed).toMatchObject({ model: "original", effort: "low" });
});

test("effort is reapplied on every step for an applied agent", async () => {
	const on = hooks({ mode: "apply" });
	const spawn = on.get("agent.spawn") as SpawnHook;
	await spawn(
		api(),
		{ prompt: "build feature", fork: false } as AgentSpawnInput,
		async () => ({ model: "claude-sonnet-5-5", agentId: "a3" }),
	);
	const inputs: TurnStepInput[] = [];
	const step = on.get("turn.step") as StepHook;
	for (let index = 0; index < 2; index++) {
		const stream = step(
			api(),
			{
				turnId: `t${index}`,
				index,
				model: "inherited",
				messageCount: 1,
				agentId: "a3",
			},
			async function* (e) {
				inputs.push(e);
				yield { kind: "text", index: 0, text: "" };
				return {
					turnId: e.turnId,
					index: e.index,
					answer: "",
					toolUses: [],
					stopReason: "end_turn",
					usage: null,
				};
			},
		);
		let last = await stream.next();
		while (!last.done) last = await stream.next();
	}
	expect(inputs.map(({ model, effort }) => ({ model, effort }))).toEqual([
		{ model: "claude-sonnet-5-5", effort: "medium" },
		{ model: "claude-sonnet-5-5", effort: "medium" },
	]);
});
