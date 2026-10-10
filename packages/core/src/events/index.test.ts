import { describe, expect, test } from "bun:test";
import type {
	CodexHookInput,
	HookInput,
	PostToolUseFailureInput,
	PostToolUseInput,
} from "../contracts/hooks.ts";
import codex from "../signals/fixtures/codex-hook-inputs.json";
import claude from "../signals/fixtures/hook-inputs.json";
import { openStore } from "../store/index.ts";
import {
	CAPABILITIES,
	closeOnEnd,
	fromClaudeHook,
	fromCodexHook,
	type HarnessEvent,
	type HarnessEventType,
	signalFromToolRun,
	suggestionFromToolRun,
} from "./index.ts";

const claudeInputs = (claude as { input: HookInput }[]).map((c) => c.input);

test("Claude adapter maps every recorded payload and only declared event types", () => {
	const types = new Set<HarnessEventType>();
	for (const input of claudeInputs) {
		const event = fromClaudeHook(input);
		if (!event) {
			continue;
		}
		expect(event.session_id).toBe(input.session_id);
		expect(CAPABILITIES["claude-code"][event.type]).toBe(true);
		types.add(event.type);
	}
	for (const t of [
		"session_start",
		"turn_start",
		"tool_run",
		"subagent_end",
		"session_end",
	] as const)
		expect(types.has(t)).toBe(true);
});

const ID = "0b9f4c7e-5d2a-4e8b-9c3f-1a2b3c4d5e6f";
const hook = { session_id: "s", transcript_path: "/t.jsonl", cwd: "/w" };
const ok = (command: string, stdout = ""): PostToolUseInput => ({
	...hook,
	hook_event_name: "PostToolUse",
	tool_name: "Bash",
	tool_use_id: "t1",
	tool_input: { command },
	tool_response: { stdout, stderr: "", interrupted: false },
});
const fail = (
	command: string,
	error = "Exit code 1",
	is_interrupt = false,
): PostToolUseFailureInput => ({
	...hook,
	hook_event_name: "PostToolUseFailure",
	tool_name: "Bash",
	tool_use_id: "t1",
	tool_input: { command },
	error,
	is_interrupt,
});
const claudeEvent = (input: HookInput) => {
	const event = fromClaudeHook(input);
	if (!event) throw new Error("no event");
	return event;
};

describe("Claude adapter: one test per event kind", () => {
	test("session_start, turn_start, subagent_start carry the session identity", () => {
		expect(
			claudeEvent({ ...hook, hook_event_name: "SessionStart", source: "x" }),
		).toEqual({
			harness: "claude-code",
			type: "session_start",
			session_id: "s",
			source: "SessionStart",
			transcript_path: "/t.jsonl",
			cwd: "/w",
		});
		expect(
			claudeEvent({
				...hook,
				hook_event_name: "UserPromptSubmit",
				prompt: "work",
				prompt_id: "p1",
			}),
		).toMatchObject({ type: "turn_start", turn_id: "p1" });
		expect(
			claudeEvent({
				...hook,
				hook_event_name: "SubagentStart",
				agent_id: "a1",
				agent_type: "x",
			}),
		).toMatchObject({ type: "subagent_start", agent_id: "a1" });
	});
	test("tool_run carries call id, stdout and a valid effort only", () => {
		expect(
			claudeEvent({
				...ok("bun test", "out"),
				prompt_id: "p1",
				effort: { level: "high" },
			}),
		).toMatchObject({
			type: "tool_run",
			call_id: "t1",
			command: "bun test",
			exit_code: 0,
			output: "out",
			turn_id: "p1",
			effort: "high",
		});
		expect(
			claudeEvent({ ...ok("x"), effort: { level: "turbo" } }).effort,
		).toBeUndefined();
		expect(fromClaudeHook({ ...ok("x"), tool_name: "Read" })).toBeNull();
		expect(fromClaudeHook({ ...ok("x"), tool_input: null })).toBeNull();
	});
	test("agent_dispatch carries the child agent and the requested and answered models", () => {
		const agent = (tool_response: unknown): PostToolUseInput => ({
			...hook,
			hook_event_name: "PostToolUse",
			tool_name: "Agent",
			tool_use_id: "t2",
			tool_input: { model: "sonnet", subagent_type: "gp-x" },
			tool_response,
		});
		expect(
			claudeEvent(agent({ agentId: "a1", resolvedModel: "claude-sonnet-5-5" })),
		).toMatchObject({
			type: "agent_dispatch",
			call_id: "t2",
			child_agent_id: "a1",
			requested_model: "sonnet",
			requested_agent_type: "gp-x",
			answered_model: "claude-sonnet-5-5",
			cwd: "/w",
		});
		expect(claudeEvent(agent(null))).not.toHaveProperty("child_agent_id");
	});
	test("subagent_end reads the subagent transcript; session_end the main one", () => {
		expect(
			claudeEvent({
				...hook,
				hook_event_name: "SubagentStop",
				agent_id: "a1",
				agent_type: "x",
				stop_hook_active: false,
				agent_transcript_path: "/sub.jsonl",
			}),
		).toMatchObject({
			type: "subagent_end",
			agent_id: "a1",
			transcript_path: "/sub.jsonl",
			source: "SubagentStop",
		});
		expect(
			claudeEvent({
				...hook,
				hook_event_name: "Stop",
				stop_hook_active: false,
			}),
		).toMatchObject({ type: "session_end", transcript_path: "/t.jsonl" });
	});
	test("handbacks are no events", () => {
		expect(fromClaudeHook({ ...ok("x"), tool_name: "SubagentHandback" })).toBe(
			null,
		);
		expect(
			fromClaudeHook({
				...hook,
				hook_event_name: "UserPromptSubmit",
				prompt: "<agent-message from=w>done",
			}),
		).toBeNull();
	});
});

describe("Codex adapter: one test per event kind", () => {
	const codex = (input: Partial<CodexHookInput>) =>
		fromCodexHook({
			session_id: "c",
			transcript_path: "/r.jsonl",
			hook_event_name: "Stop",
			turn_id: "turn1",
			...input,
		});
	test("session_start, turn_start and session_end carry the turn and rollout", () => {
		expect(codex({ hook_event_name: "SessionStart" })).toMatchObject({
			harness: "codex",
			type: "session_start",
		});
		expect(codex({ hook_event_name: "UserPromptSubmit" })).toMatchObject({
			type: "turn_start",
			turn_id: "turn1",
		});
		expect(codex({})).toMatchObject({
			type: "session_end",
			turn_id: "turn1",
			transcript_path: "/r.jsonl",
			source: "codex:Stop",
		});
	});
	test("tool_run has the output text and no exit code", () => {
		expect(
			codex({
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "call1",
				tool_input: { command: "spatz x" },
				tool_response: `suggestion_id: ${ID}`,
			}),
		).toMatchObject({
			type: "tool_run",
			call_id: "call1",
			exit_code: null,
			output: `suggestion_id: ${ID}`,
		});
		expect(
			codex({ hook_event_name: "PostToolUse", tool_name: "apply_patch" }),
		).toBeNull();
	});
});

describe("signalFromToolRun", () => {
	const signal = (input: HookInput) => signalFromToolRun(claudeEvent(input));
	test("failures that never reached the runner have no exit code and give no signal", () => {
		for (const input of [
			fail(
				"cd /missing && bun test",
				"Exit code 1\ncd: /missing: No such file or directory",
			),
			fail("bun test", "Exit code 126\nbash: permission denied"),
			fail("bun test", "Exit code 127\nbun: command not found"),
			fail("bun test", "Exit code 130", true),
		]) {
			expect(claudeEvent(input)).toMatchObject({ exit_code: null });
			expect(signal(input)).toBeNull();
		}
		expect(signal(fail("cd pkg && bun test"))?.value).toBe(0);
	});
	test("test pass -> test 1; build failure -> build 0", () => {
		expect(signal(ok("bun test"))).toEqual({
			kind: "test",
			value: 1,
			weight: 1,
		});
		expect(signal(fail("tsc"))).toEqual({
			kind: "build",
			value: 0,
			weight: 0.8,
		});
	});
	test("non-test command, spatz call, unknown exit code -> null", () => {
		expect(signal(ok("echo ok"))).toBeNull();
		expect(signal(ok('spatz "x" --models m'))).toBeNull();
		const codexRun = fromCodexHook({
			session_id: "c",
			transcript_path: "",
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "bun test" },
		}) as HarnessEvent;
		expect(signalFromToolRun(codexRun)).toBeNull();
	});
	test("recorded fixture commands give no signal", () => {
		for (const input of claudeInputs) {
			const event = fromClaudeHook(input);
			if (event?.type === "tool_run")
				expect(signalFromToolRun(event)).toBeNull();
		}
	});
});

test("suggestionFromToolRun reads the id of a spatz run unless it failed", () => {
	expect(
		suggestionFromToolRun(
			claudeEvent(ok('spatz "fix it"', `suggestion_id: ${ID}`)),
		),
	).toBe(ID);
	expect(
		suggestionFromToolRun(claudeEvent(ok("echo", `suggestion_id: ${ID}`))),
	).toBe(null);
	expect(suggestionFromToolRun(claudeEvent(fail('spatz "fix it"')))).toBeNull();
});

test("Claude failure events carry the exit code; success carries 0", () => {
	const base = {
		session_id: "s",
		transcript_path: "",
		cwd: "/",
		tool_use_id: "t",
		tool_input: { command: "bun test" },
	};
	expect(
		fromClaudeHook({
			...base,
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_response: {},
		}),
	).toMatchObject({ type: "tool_run", exit_code: 0 });
	expect(
		fromClaudeHook({
			...base,
			hook_event_name: "PostToolUseFailure",
			tool_name: "Bash",
			error: "Exit code 2",
		}),
	).toMatchObject({ exit_code: 2 });
});

test("Codex adapter maps recorded payloads; exit code is declared unknown; no subagent events", () => {
	const events = (codex.calls as CodexHookInput[]).map(fromCodexHook);
	expect(events.map((e) => e?.type)).toEqual([
		"tool_run",
		"tool_run",
		"tool_run",
		"session_end",
	]);
	expect(events[0]).toMatchObject({ exit_code: null, model: "gpt-6-luna" });
	expect(CAPABILITIES.codex.subagent_end).toBe(false);
});

test("closeOnEnd marks open suggestions of the ended agent as unknown, once", () => {
	const store = openStore(":memory:");
	const ranking = [{ model: "m", effort: "low" as const, estimate: 0.5, n: 0 }];
	const mk = (id: string, agent_id: string | null) =>
		store.insertSuggestion({
			id,
			created_at: 1,
			scope: null,
			agent: null,
			turn_id: null,
			agent_id,
			session_id: "S",
			prompt_id: null,
			task_type: "code.bugfix",
			difficulty: "medium",
			criticality: "none",
			probabilities: null,
			model_ref: null,
			strategy: "rules",
			ranking,
			reason: "r",
			explored: false,
			control: false,
			fallback_used: true,
			fallback_reason: null,
			is_test: false,
			last_event_at: 1,
			closed_at: null,
		});
	mk("a", "agent1");
	mk("main", null);
	mk("cli", null);
	const sub = fromClaudeHook({
		hook_event_name: "SubagentStop",
		session_id: "S",
		agent_id: "agent1",
		agent_type: "x",
		transcript_path: "",
		cwd: "/",
		stop_hook_active: false,
		agent_transcript_path: "",
	});
	if (!sub) throw new Error("no event");
	expect(closeOnEnd(store, sub, 5)).toEqual(["a"]);
	expect(closeOnEnd(store, sub, 5)).toEqual([]);
	const stop = fromCodexHook({
		hook_event_name: "Stop",
		session_id: "OTHER",
		transcript_path: "",
	});
	if (!stop) throw new Error("no event");
	expect(closeOnEnd(store, stop, 6, "cli")).toEqual(["cli"]);
	store.dispose();
});
