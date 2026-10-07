import { expect, test } from "bun:test";
import type { CodexHookInput, HookInput } from "../contracts/hooks.ts";
import codex from "../signals/fixtures/codex-hook-inputs.json";
import claude from "../signals/fixtures/hook-inputs.json";
import { openStore } from "../store/index.ts";
import {
	CAPABILITIES,
	closeOnEnd,
	fromClaudeHook,
	fromCodexHook,
	type HarnessEventType,
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
