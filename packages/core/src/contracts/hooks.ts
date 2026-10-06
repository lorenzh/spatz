// Claude Code hook inputs and transcript entries, as observed in the hooks spike
// (spikes/hooks/hooks.parsed.json, 2026-10-04). Only fields spatz reads are typed;
// everything else is allowed but ignored. Never persist prompt, tool_input or tool_response text.

export interface HookBase {
	session_id: string;
	transcript_path: string;
	cwd: string;
	/** Present in every event of a turn except SessionStart. */
	prompt_id?: string;
	permission_mode?: string;
	/** Present in PostToolUse, PostToolUseFailure, Stop, SubagentStop. Missing in UserPromptSubmit, SubagentStart. */
	effort?: { level: string };
	/** Set when the event comes from inside a subagent. */
	agent_id?: string;
	agent_type?: string;
}

export interface SessionStartInput extends HookBase {
	hook_event_name: "SessionStart";
	source: string;
}

export interface UserPromptSubmitInput extends HookBase {
	hook_event_name: "UserPromptSubmit";
	/** A subagent handback triggers a second UserPromptSubmit whose prompt starts with "<agent-message". Ignore it. */
	prompt: string;
}

export interface BashToolInput {
	command: string;
}

export interface BashToolResponse {
	stdout: string;
	stderr: string;
	interrupted: boolean;
}

export interface AgentToolResponse {
	status?: string;
	agentId?: string;
	agentType?: string;
	/** Model the subagent ran on, e.g. "claude-sonnet-5-5" (not canonical). */
	resolvedModel?: string;
	totalTokens?: number;
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface PostToolUseInput extends HookBase {
	hook_event_name: "PostToolUse";
	/** "Bash", "Agent", "SubagentHandback" (ignore), ... */
	tool_name: string;
	tool_input: unknown;
	/** Bash: BashToolResponse (no exit code; the event itself means success). Agent: AgentToolResponse. */
	tool_response: unknown;
	tool_use_id: string;
	duration_ms?: number;
}

export interface PostToolUseFailureInput extends HookBase {
	hook_event_name: "PostToolUseFailure";
	tool_name: string;
	tool_input: unknown;
	tool_use_id: string;
	/** e.g. "Exit code 1". No tool_response. */
	error: string;
	is_interrupt?: boolean;
	duration_ms?: number;
}

export interface SubagentStartInput extends HookBase {
	hook_event_name: "SubagentStart";
	agent_id: string;
	agent_type: string;
}

export interface SubagentStopInput extends HookBase {
	hook_event_name: "SubagentStop";
	agent_id: string;
	agent_type: string;
	stop_hook_active: boolean;
	/** <session>/subagents/agent-<agent_id>.jsonl; the main transcript does not contain these entries. */
	agent_transcript_path: string;
}

export interface StopInput extends HookBase {
	hook_event_name: "Stop";
	stop_hook_active: boolean;
	last_assistant_message?: string;
}

export type HookInput =
	| SessionStartInput
	| UserPromptSubmitInput
	| PostToolUseInput
	| PostToolUseFailureInput
	| SubagentStartInput
	| SubagentStopInput
	| StopInput;

export interface CodexHookInput {
	session_id: string;
	transcript_path: string;
	cwd?: string;
	turn_id?: string;
	model?: string;
	hook_event_name: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_response?: unknown;
	tool_use_id?: string;
}

export type HookEventName = HookInput["hook_event_name"];

// ---------- Transcript JSONL (one JSON object per line) ----------
// Observed facts that matter for parsing:
// - Assistant entries have NO promptId (main and subagent). The main-session turn is found by
//   the "user" entries that carry promptId: assistant entries belong to the promptId of the
//   closest preceding user entry that has a promptId.
// - One API message is split into several assistant entries (one per content block) that share
//   message.id and repeat the same usage. Count usage once per message.id.
// - Subagent entries have isSidechain: true and agentId. Subagent user entries carry the parent
//   turn's promptId; only assistant entries lack it. parseSubagentTranscript takes all assistant entries.

export interface TranscriptUsage {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
}

export interface TranscriptAssistantEntry {
	type: "assistant";
	uuid: string;
	parentUuid: string | null;
	timestamp: string;
	sessionId: string;
	isSidechain: boolean;
	agentId?: string;
	requestId?: string;
	message: {
		id: string;
		/** e.g. "claude-sonnet-5-5" (not canonical). */
		model: string;
		usage?: TranscriptUsage;
	};
}

export interface TranscriptUserEntry {
	type: "user";
	uuid: string;
	parentUuid: string | null;
	timestamp: string;
	isSidechain: boolean;
	promptId?: string;
	agentId?: string;
}

/** Other entry types (attachment, queue-operation, system, last-prompt, cost-state, ...) are skipped. */
export type TranscriptEntry =
	| TranscriptAssistantEntry
	| TranscriptUserEntry
	| { type: string };
