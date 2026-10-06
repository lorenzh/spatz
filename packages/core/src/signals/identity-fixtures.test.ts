import { describe, expect, test } from "bun:test";
import codexExec from "./fixtures/codex-exec-identity.json";
import main from "./fixtures/main-turn-identity.json";
import modRouted from "./fixtures/mod-routed-step-identity.json";
import subagent from "./fixtures/subagent-identity.json";
import { isIgnoredHookInput, parseHookInput } from "./index.ts";
import {
	mainTurnMessages,
	parseCodexRollout,
	parseMainTranscript,
	parseSubagentTranscript,
	subagentMessages,
} from "./transcript.ts";

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

	test.each([
		{
			variant: "main",
			hook: main.hook,
			usage: {
				model: "claude-sonnet-5-5",
				input_tokens: 2,
				output_tokens: 163,
				cache_read_tokens: 11547,
				cache_creation_tokens: 29466,
			},
		},
		{
			variant: "subagent",
			hook: subagent.hook,
			usage: {
				model: "claude-haiku-4-5-20251001",
				input_tokens: 10,
				// #86: stale streaming count; the mod reports 156 for this message.
				output_tokens: 3,
				cache_read_tokens: 0,
				cache_creation_tokens: 21334,
			},
		},
	])(
		"Claude $variant transcript deduplicates message.id and joins tool_use_id",
		async ({ variant, hook, usage }) => {
			const jsonl = await Bun.file(
				`${import.meta.dir}/fixtures/${variant}-identity-transcript.jsonl`,
			).text();
			const rows = jsonl
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const assistants = rows.filter((row) => row.type === "assistant");
			expect(assistants).toHaveLength(2);
			expect(assistants[0].uuid).not.toBe(assistants[1].uuid);
			expect(assistants[0].message.id).toBe(assistants[1].message.id);
			const tool = assistants
				.flatMap((row) => row.message.content)
				.find((block) => block.type === "tool_use");
			expect(tool.id).toBe(hook.tool_use_id);
			if (variant === "subagent") {
				expect(
					assistants.every((row) => row.agentId === subagent.modAgentId),
				).toBe(true);
			}
			expect(
				variant === "main"
					? parseMainTranscript(jsonl, hook.prompt_id)
					: parseSubagentTranscript(jsonl),
			).toEqual([usage]);
		},
	);

	test("codex exec parses both formats; completed item ID differs from legacy call_id", () => {
		const { turn, call, callOutput, completed, tokenUsage } = codexExec;
		expect(callOutput.payload.call_id).toBe(call.payload.call_id);
		expect(completed.payload.item.id).not.toBe(call.payload.call_id);
		expect(completed.payload.item).not.toHaveProperty("call_id");
		expect(completed.payload.turn_id).toBe(turn.payload.turn_id);
		const legacy = [turn, call, callOutput];
		const expected = {
			model: "gpt-6-astra",
			effort: "high",
		};
		// This exec wrapper returns JSON with exit_code, not the legacy exit_code=N text.
		expect(
			parseCodexRollout(
				legacy.map((row) => JSON.stringify(row)).join("\n"),
				turn.payload.turn_id,
			),
		).toMatchObject({
			...expected,
			calls: [{ command: "[redacted]", exit_code: 0 }],
			usage: null,
		});
		const rows = [turn, call, tokenUsage, completed, callOutput, completed];
		expect(
			parseCodexRollout(
				rows.map((row) => JSON.stringify(row)).join("\n"),
				turn.payload.turn_id,
			),
		).toMatchObject({
			...expected,
			calls: [{ command: "[redacted]", exit_code: 0 }],
			usage: {
				// Codex input includes cached tokens; normalized input excludes them.
				input_tokens: 10102,
				cache_read_input_tokens: 12288,
				cache_creation_input_tokens: 0,
				output_tokens: 96,
			},
		});
	});
});

test.each(["main", "subagent"])(
	"%s parser preserves stable message and tool identities",
	async (variant) => {
		const text = await Bun.file(
			`${import.meta.dir}/fixtures/${variant}-identity-transcript.jsonl`,
		).text();
		const messages =
			variant === "main"
				? mainTurnMessages(text, main.hook.prompt_id)
				: subagentMessages(text);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			id: expect.stringMatching(/^msg_/),
			source_seq: 1,
			calls: [{ id: expect.stringMatching(/^toolu_/), name: "Bash" }],
		});
	},
);

test("Codex preserves separate completed and legacy identities and snapshot source order", () => {
	const parse = (records: unknown[]) =>
		parseCodexRollout(
			records.map((row) => JSON.stringify(row)).join("\n"),
			codexExec.turn.payload.turn_id,
		);
	const legacy = parse([
		codexExec.turn,
		codexExec.call,
		codexExec.callOutput,
		codexExec.tokenUsage,
	]);
	const completed = parse([
		codexExec.turn,
		codexExec.call,
		codexExec.callOutput,
		codexExec.tokenUsage,
		codexExec.completed,
	]);
	expect(legacy?.calls[0]).toMatchObject({
		id: `legacy:${codexExec.call.payload.call_id}`,
		source_seq: 1,
	});
	expect(completed?.calls[0]).toMatchObject({
		id: `completed:${codexExec.completed.payload.item.id}`,
		source_seq: 4,
		at: Date.parse(codexExec.completed.timestamp),
	});
	expect(completed).toMatchObject({
		usage_revision: 3,
		usage_at: Date.parse(codexExec.tokenUsage.timestamp),
		mixed_pair: false,
	});
	const changed = {
		...codexExec.turn,
		payload: { ...codexExec.turn.payload, effort: "low" },
	};
	expect(
		parse([codexExec.turn, changed, codexExec.tokenUsage])?.mixed_pair,
	).toBe(true);
});
