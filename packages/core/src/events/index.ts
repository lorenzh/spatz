// Harness-neutral hook events. Each harness adapter only maps its native payload to HarnessEvent;
// recording logic (suggestion linking, signals, closing without evidence) lives in core.

import type { Store } from "../contracts/deps.ts";
import type {
	AgentToolResponse,
	BashToolInput,
	BashToolResponse,
	CodexHookInput,
	HookInput,
} from "../contracts/hooks.ts";
import { type Effort, SIGNAL_WEIGHTS } from "../contracts/types.ts";
import {
	detectCommandKind,
	effortFromHook,
	extractSuggestionIds,
	isIgnoredHookInput,
} from "../signals/index.ts";

export type HarnessName = "claude-code" | "codex";

export interface HarnessEventBase {
	harness: HarnessName;
	session_id: string;
	/** Set for events from inside a subagent. */
	agent_id?: string;
	/** Claude Code prompt id or Codex turn id, when the payload carries one. */
	turn_id?: string;
	/** Only when the harness exposes them in that payload. */
	model?: string;
	effort?: Effort;
	/** The harness's own record of this agent (Claude transcript, subagent transcript or Codex rollout). */
	transcript_path?: string;
	cwd?: string;
	/** Native hook name, kept only as a label for stored signals and diagnostics. */
	source: string;
}

export type HarnessEvent = HarnessEventBase &
	(
		| { type: "session_start" }
		| { type: "turn_start" }
		/**
		 * exit_code is null when the payload does not carry one or the command never reached its program
		 * (interrupt, missing directory or binary). output is the command's stdout when the payload has it.
		 */
		| {
				type: "tool_run";
				call_id?: string;
				command: string;
				exit_code: number | null;
				output?: string;
		  }
		/** The main agent started a subagent; child_agent_id is the new agent's id. */
		| {
				type: "agent_dispatch";
				call_id: string;
				child_agent_id?: string;
				requested_model?: string;
				requested_agent_type?: string;
				answered_model?: string;
		  }
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
		agent_dispatch: true,
		subagent_start: true,
		subagent_end: true,
		session_end: true,
	},
	codex: {
		session_start: true,
		turn_start: true,
		tool_run: true,
		agent_dispatch: false,
		subagent_start: false,
		subagent_end: false,
		session_end: true,
	},
};

/** "Exit code 3" -> 3; any other failure text -> 1. */
const failureCode = (error: string) =>
	Number(/Exit code (\d+)/.exec(error)?.[1] ?? 1);
// Failure text of a run that never reached the runner (bad cd, missing or non-executable binary).
const NOT_RUN =
	/No such file or directory|[Pp]ermission denied|command not found/;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function fromClaudeHook(input: HookInput): HarnessEvent | null {
	if (isIgnoredHookInput(input)) return null;
	const effort = effortFromHook(input);
	const base = {
		harness: "claude-code" as const,
		session_id: input.session_id,
		source: input.hook_event_name,
		...(input.agent_id && { agent_id: input.agent_id }),
		...(input.prompt_id && { turn_id: input.prompt_id }),
		...(effort && { effort }),
		...(input.cwd && { cwd: input.cwd }),
		transcript_path:
			input.hook_event_name === "SubagentStop"
				? input.agent_transcript_path
				: input.transcript_path,
	};
	switch (input.hook_event_name) {
		case "SessionStart":
			return { ...base, type: "session_start" };
		case "UserPromptSubmit":
			return { ...base, type: "turn_start" };
		case "SubagentStart":
			return { ...base, type: "subagent_start" };
		case "SubagentStop":
			return { ...base, type: "subagent_end" };
		case "Stop":
			return { ...base, type: "session_end" };
		case "PostToolUse":
		case "PostToolUseFailure": {
			if (
				input.hook_event_name === "PostToolUse" &&
				input.tool_name === "Agent"
			) {
				const requested = input.tool_input as {
					model?: unknown;
					subagent_type?: unknown;
				} | null;
				const response = input.tool_response as AgentToolResponse | null;
				return {
					...base,
					type: "agent_dispatch",
					call_id: input.tool_use_id,
					...(str(response?.agentId) && { child_agent_id: response?.agentId }),
					...(str(requested?.model) && {
						requested_model: requested?.model as string,
					}),
					...(str(requested?.subagent_type) && {
						requested_agent_type: requested?.subagent_type as string,
					}),
					...(str(response?.resolvedModel) && {
						answered_model: response?.resolvedModel,
					}),
				};
			}
			const command = (input.tool_input as BashToolInput | null)?.command;
			if (input.tool_name !== "Bash" || typeof command !== "string")
				return null;
			if (input.hook_event_name === "PostToolUse")
				return {
					...base,
					type: "tool_run",
					call_id: input.tool_use_id,
					command,
					exit_code: 0,
					output:
						(input.tool_response as BashToolResponse | null)?.stdout ?? "",
				};
			return {
				...base,
				type: "tool_run",
				call_id: input.tool_use_id,
				command,
				exit_code:
					input.is_interrupt || NOT_RUN.test(input.error)
						? null
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
		source: `codex:${input.hook_event_name}`,
		transcript_path: input.transcript_path,
		...(input.turn_id && { turn_id: input.turn_id }),
		...(input.model && { model: input.model }),
		...(input.cwd && { cwd: input.cwd }),
	};
	switch (input.hook_event_name) {
		case "SessionStart":
			return { ...base, type: "session_start" };
		case "UserPromptSubmit":
			return { ...base, type: "turn_start" };
		case "Stop":
			return { ...base, type: "session_end" };
		case "PostToolUse": {
			const command = (input.tool_input as BashToolInput | undefined)?.command;
			if (input.tool_name !== "Bash" || typeof command !== "string")
				return null;
			// The Codex payload has only the output text, no exit status: declared unknown.
			return {
				...base,
				type: "tool_run",
				...(input.tool_use_id && { call_id: input.tool_use_id }),
				command,
				exit_code: null,
				...(typeof input.tool_response === "string" && {
					output: input.tool_response,
				}),
			};
		}
	}
	return null;
}

/** Every suggestion id a `spatz <task>` run printed, unless the run failed. */
export function suggestionIdsFromToolRun(event: HarnessEvent): string[] {
	if (event.type !== "tool_run" || !event.output) return [];
	if (event.exit_code !== null && event.exit_code !== 0) return [];
	if (detectCommandKind(event.command) !== "spatz-suggest") return [];
	return extractSuggestionIds(event.output);
}

/** Test or build run with a known exit status -> value 1 on exit 0, else 0. */
export function signalFromToolRun(
	event: HarnessEvent,
): { kind: "test" | "build"; value: 0 | 1; weight: number } | null {
	if (event.type !== "tool_run" || event.exit_code === null) return null;
	const kind = detectCommandKind(event.command);
	if (kind !== "test" && kind !== "build") return null;
	return {
		kind,
		value: event.exit_code === 0 ? 1 : 0,
		weight: SIGNAL_WEIGHTS[kind],
	};
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
