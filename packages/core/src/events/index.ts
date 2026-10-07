// Harness-neutral hook events. Each harness adapter only maps its native payload to HarnessEvent;
// recording logic (suggestion linking, signals, closing without evidence) lives in core.

import type { Store } from "../contracts/deps.ts";
import type {
	BashToolInput,
	CodexHookInput,
	HookInput,
} from "../contracts/hooks.ts";

export type HarnessName = "claude-code" | "codex";

export interface HarnessEventBase {
	harness: HarnessName;
	session_id: string;
	/** Set for events from inside a subagent. */
	agent_id?: string;
	/** Only when the harness exposes them in that payload. */
	model?: string;
	effort?: string;
}

export type HarnessEvent = HarnessEventBase &
	(
		| { type: "session_start" }
		| { type: "turn_start"; turn_id?: string }
		/** exit_code is null when the harness payload does not carry one. */
		| { type: "tool_run"; command: string; exit_code: number | null }
		| { type: "subagent_start" }
		| { type: "subagent_end" }
		/** End of the main agent's turn (Claude Code Stop, Codex Stop, the end of a `codex exec` turn). */
		| { type: "session_end" }
	);

export type HarnessEventType = HarnessEvent["type"];

/** A false entry means the harness has no such hook; adapters never invent the event. */
export const CAPABILITIES: Record<
	HarnessName,
	Record<HarnessEventType, boolean>
> = {
	"claude-code": {
		session_start: true,
		turn_start: true,
		tool_run: true,
		subagent_start: true,
		subagent_end: true,
		session_end: true,
	},
	codex: {
		session_start: true,
		turn_start: true,
		tool_run: true,
		subagent_start: false,
		subagent_end: false,
		session_end: true,
	},
};

/** "Exit code 3" -> 3; any other failure text -> 1. */
const failureCode = (error: string) =>
	Number(/Exit code (\d+)/.exec(error)?.[1] ?? 1);

export function fromClaudeHook(input: HookInput): HarnessEvent | null {
	const base = {
		harness: "claude-code" as const,
		session_id: input.session_id,
		...(input.agent_id && { agent_id: input.agent_id }),
		...(input.effort?.level && { effort: input.effort.level }),
	};
	switch (input.hook_event_name) {
		case "SessionStart":
			return { ...base, type: "session_start" };
		case "UserPromptSubmit":
			return {
				...base,
				type: "turn_start",
				...(input.prompt_id && { turn_id: input.prompt_id }),
			};
		case "SubagentStart":
			return { ...base, type: "subagent_start" };
		case "SubagentStop":
			return { ...base, type: "subagent_end" };
		case "Stop":
			return { ...base, type: "session_end" };
		case "PostToolUse":
		case "PostToolUseFailure": {
			const command = (input.tool_input as BashToolInput | null)?.command;
			if (input.tool_name !== "Bash" || typeof command !== "string")
				return null;
			return {
				...base,
				type: "tool_run",
				command,
				exit_code:
					input.hook_event_name === "PostToolUse"
						? 0
						: failureCode(input.error),
			};
		}
	}
	return null;
}

export function fromCodexHook(input: CodexHookInput): HarnessEvent | null {
	const base = {
		harness: "codex" as const,
		session_id: input.session_id,
		...(input.model && { model: input.model }),
	};
	switch (input.hook_event_name) {
		case "SessionStart":
			return { ...base, type: "session_start" };
		case "UserPromptSubmit":
			return {
				...base,
				type: "turn_start",
				...(input.turn_id && { turn_id: input.turn_id }),
			};
		case "Stop":
			return { ...base, type: "session_end" };
		case "PostToolUse": {
			const command = (input.tool_input as BashToolInput | undefined)?.command;
			if (input.tool_name !== "Bash" || typeof command !== "string")
				return null;
			// The Codex payload has only the output text, no exit status: declared unknown.
			return { ...base, type: "tool_run", command, exit_code: null };
		}
	}
	return null;
}

/**
 * Agent end without evidence: every suggestion of that session and agent that still has no outcome is stored as `unknown`.
 * `suggestionId` (the Codex `SPATZ_SUGGESTION_ID` of a CLI-routed run) closes that suggestion as well.
 * Returns the ids newly marked.
 */
export function closeOnEnd(
	store: Store,
	event: HarnessEvent,
	at: number,
	suggestionId?: string,
): string[] {
	if (event.type === "subagent_end" && event.agent_id)
		return store.closeUnknown(
			{ session: event.session_id, agentId: event.agent_id },
			at,
		);
	if (event.type !== "session_end") return [];
	return [
		...store.closeUnknown({ session: event.session_id, agentId: null }, at),
		...(suggestionId ? store.closeUnknown({ id: suggestionId }, at) : []),
	];
}
