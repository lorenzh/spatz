import type { Effort, Outcome, ReportResult, UsageRecord } from "./types.ts";

export interface AttemptContext {
	harness: string;
	session_key: string;
	agent_key: string;
}
export interface AttemptRecord {
	id: string;
	suggestion_id: string;
	ordinal: number;
	execution_key: string;
	model: string | null;
	effort: Effort | null;
	/** Dated model revision when the harness exposed one. */
	model_version?: string | null;
	root_id: string;
	opened_at: number | null;
	closed_at: number | null;
	chain_closed_at: number | null;
}
export interface AttemptStart extends AttemptContext {
	suggestion_id: string;
	key: string;
	model: string | null;
	effort: Effort | null;
	at: number;
	prompt_id?: string | null;
	turn_id?: string | null;
	call_id?: string | null;
	owns_usage?: boolean;
}
export interface AttemptBinding extends AttemptContext {
	attempt_id: string;
	id_kind: "prompt" | "turn" | "call" | "message" | "start";
	external_id: string;
}
export interface AttemptEvent extends AttemptContext {
	event_id: string;
	revision: number;
	suggestion_id?: string | null;
	attempt_id?: string | null;
	prompt_id?: string | null;
	turn_id?: string | null;
	call_id?: string | null;
	message_id?: string | null;
	source_seq?: number | null;
	occurred_at?: number | null;
	received_at: number;
	rounds?: number | null;
	note?: string | null;
	model?: string | null;
	model_version?: string | null;
	effort?: Effort | null;
	kind: "report" | "test" | "build" | "usage" | "delegate";
	source?: string;
	value?: number | null;
	weight?: number | null;
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_tokens?: number | null;
	cache_creation_tokens?: number | null;
	cost_usd?: number | null;
	cost_source?: UsageRecord["cost_source"];
	tokens_complete?: 0 | 1;
	tokens_schema?: 1 | 2;
	/** Measured suggestion total cannot be split across actual pairs. */
	suggestion_only?: boolean;
}
export interface AttemptReport {
	suggestion_id: string;
	model: string;
	effort: Effort;
	result: ReportResult;
	at: number;
	model_version?: string | null;
	attempt_id?: string;
	correct?: boolean;
	/** Correct a prior report, else record the first one. */
	revise?: boolean;
	confirm?: boolean;
	rounds?: number;
	note?: string;
	turn_id?: string;
}
export interface AttemptStore {
	startAttempt(input: AttemptStart): AttemptRecord;
	bindAttempt(input: AttemptBinding): void;
	recordAttemptEvents(events: AttemptEvent[], openWindowMs?: number): void;
	reconcileAttempts(context: AttemptContext, openWindowMs?: number): void;
	reportAttempt(input: AttemptReport): Outcome;
	finalizeAttempts(
		context: AttemptContext,
		at: number,
		successQuality?: number,
	): void;
	attemptOwnsUsage(context: AttemptContext): boolean;
}
