import { describe, expect, test } from "bun:test";
import codexExec from "./fixtures/codex-exec-identity.json";
import main from "./fixtures/main-turn-identity.json";
import modRouted from "./fixtures/mod-routed-step-identity.json";
import subagent from "./fixtures/subagent-identity.json";
import { isIgnoredHookInput, parseHookInput } from "./index.ts";

describe("identity fixtures", () => {
	test("main hook prompt and mod turn are distinct; tool calls share tool_use_id", () => {
		const mod = main.mod as { turnId: string };
		const hook = main.hook as {
			prompt_id: string;
			tool_use_id: string;
			effort: { level: string };
		};
		expect(mod.turnId).not.toBe(hook.prompt_id);
		expect(main.modToolUses).toEqual([
			{ name: "Bash", input: { command: "[redacted]" } },
		]);
		expect(main.modToolUseId).toBe(hook.tool_use_id);
		expect(hook.effort.level).toBe("high");
	});

	test("subagent identity comes from agent_id; hooks omit effort and hand-backs are filtered", () => {
		const hook = subagent.hook as {
			agent_id: string;
			effort?: { level: string };
			tool_name: string;
			session_id: string;
			transcript_path: string;
			cwd: string;
			prompt_id: string;
			permission_mode: string;
			tool_input: { command: string };
			tool_response: { stdout: string };
			duration_ms: number;
		};
		expect(subagent.modAgentId).toBe(hook.agent_id);
		expect(Object.keys(hook)).toEqual([
			"hook_event_name",
			"session_id",
			"transcript_path",
			"cwd",
			"prompt_id",
			"permission_mode",
			"agent_id",
			"agent_type",
			"tool_name",
			"tool_input",
			"tool_response",
			"tool_use_id",
			"duration_ms",
		]);
		expect(hook).toEqual(
			expect.objectContaining({
				session_id: expect.any(String),
				transcript_path: expect.any(String),
				cwd: expect.any(String),
				prompt_id: expect.any(String),
				permission_mode: "auto",
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_input: expect.objectContaining({ command: "[redacted]" }),
				tool_response: expect.any(Object),
				tool_use_id: expect.any(String),
				duration_ms: expect.any(Number),
			}),
		);
		expect(hook.effort).toBeUndefined();
		expect(hook.tool_name).toBe("Bash");
		expect(subagent.modAgentSpawnId).toBe(
			(subagent.agentCallHook as { tool_use_id: string }).tool_use_id,
		);
		expect(Object.keys(subagent.start)).toEqual([
			"session_id",
			"transcript_path",
			"cwd",
			"prompt_id",
			"agent_id",
			"agent_type",
			"hook_event_name",
		]);
		expect(subagent.start as object).not.toHaveProperty("effort");
		expect(Object.keys(subagent.stop)).toEqual([
			"session_id",
			"transcript_path",
			"cwd",
			"prompt_id",
			"permission_mode",
			"agent_id",
			"agent_type",
			"hook_event_name",
			"stop_hook_active",
			"agent_transcript_path",
			"background_tasks",
			"session_crons",
		]);
		expect(subagent.stop as object).not.toHaveProperty("effort");
		expect(subagent.handback as { tool_name: string }).toMatchObject({
			tool_name: "SubagentHandback",
		});
		const handbackPrompt = subagent.handbackPrompt as { prompt: string };
		expect(handbackPrompt.prompt.startsWith("<agent-message from=")).toBe(true);
		const handback = parseHookInput(JSON.stringify(subagent.handback));
		const prompt = parseHookInput(JSON.stringify(subagent.handbackPrompt));
		expect(handback && isIgnoredHookInput(handback)).toBe(true);
		expect(prompt && isIgnoredHookInput(prompt)).toBe(true);
	});

	test("mod-routed subagent effort is mod-owned and tool IDs join hook calls", () => {
		const mod = modRouted.mod as {
			sent: string;
			toolUses: { name: string; input: Record<string, unknown> }[];
		};
		const hook = modRouted.hook as {
			effort?: { level: string };
			tool_use_id: string;
			tool_input: { command: string };
			tool_response: { stdout: string };
		};
		expect(mod.sent).toBe("low");
		expect(mod.toolUses[0]).not.toHaveProperty("id");
		expect(Object.keys(hook)).toEqual([
			"hook_event_name",
			"session_id",
			"transcript_path",
			"cwd",
			"prompt_id",
			"permission_mode",
			"agent_id",
			"agent_type",
			"tool_name",
			"tool_input",
			"tool_response",
			"tool_use_id",
			"duration_ms",
		]);
		expect(hook.effort).toBeUndefined();
		expect(hook.tool_input.command).toBe("[redacted]");
		expect(hook.tool_response.stdout).toBe("sub-hi");
		expect(modRouted.modToolUseId).toBe(hook.tool_use_id);
	});

	test("codex exec rollout keeps turn context and call IDs", () => {
		const turn = codexExec.turn as {
			type: string;
			payload: { turn_id: string; model: string; effort: string };
		};
		const call = codexExec.call as {
			type: string;
			payload: { call_id: string; name: string };
		};
		const output = codexExec.callOutput as { payload: { call_id: string } };
		expect(turn.type).toBe("turn_context");
		expect(turn.payload.model).toBe("gpt-6-astra");
		expect(turn.payload.effort).toBe("high");
		expect(turn.payload.turn_id).toBeTruthy();
		expect(call.type).toBe("response_item");
		expect(call.payload.name).toBe("exec");
		expect(call.payload.call_id).toMatch(/^call_/);
		expect(output.payload.call_id).toBe(call.payload.call_id);
	});
});
