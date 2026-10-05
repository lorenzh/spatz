// Injection seams. Unit tests pass fakes for all of these; no network, no real home dir.
import type { DifficultyInput } from "./difficulty.ts";
import type {
	Agent,
	CellStat,
	Config,
	Outcome,
	ReportResult,
	RoutingScope,
	SignalRecord,
	StatsReport,
	Suggestion,
	SuggestionRecord,
	TaskType,
	UsageRecord,
} from "./types.ts";

// ---------- Jev ----------
// Structural subset of @typesafe-ai/sdk 0.6.0. A real TypeSafeClient satisfies JevClient.

export type JevChoiceQuestion = {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
};
export type JevScoreQuestion = {
	type: "score";
	instructions: string;
	criteria: readonly [string, string, ...string[]];
};

export interface JevRequest {
	/** Always JEV_MODEL ("jev-1.13.0"), never latest. */
	model: string;
	/** The task text. Sent only when the secret filter finds nothing and no opt-out applies. */
	state: string;
	questions: {
		task_type: JevChoiceQuestion;
		difficulty: JevScoreQuestion;
		criticality: JevChoiceQuestion;
		best_candidate: JevChoiceQuestion;
	};
}

export interface JevChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}
export interface JevScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
	/** Keys "0","1","2" in rubric order. */
	probabilities: Record<string, number>;
}

export interface JevResult {
	model: string;
	answers: {
		task_type: JevChoiceAnswer;
		difficulty: JevScoreAnswer;
		criticality: JevChoiceAnswer;
		best_candidate: JevChoiceAnswer;
	};
	usage: { input_tokens: number; output_tokens: number };
}

export interface JevClient {
	/** Real client: maxRetries 0. Errors: APITimeoutError, AuthenticationError (401), RateLimitError (429), others. */
	systemOne(
		request: JevRequest,
		options?: { timeout?: number },
	): PromiseLike<JevResult>;
}

// ---------- Generic seams ----------

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type Env = Record<string, string | undefined>;

export interface Clock {
	/** Epoch ms. */
	now(): number;
}

/** Uniform in [0, 1). */
export type RandomFn = () => number;

// ---------- Store (implemented by store module with bun:sqlite) ----------

export interface Store {
	insertSuggestion(
		record: Omit<SuggestionRecord, "difficulty"> & {
			difficulty: DifficultyInput;
		},
	): void;
	getSuggestion(id: string): SuggestionRecord | null;
	/** Non-test outcomes with a used pair, grouped by (task_type, difficulty, model, effort), for one task_type (all difficulties). */
	cellStats(taskType: TaskType): CellStat[];
	/** Link session_id/prompt_id to the suggestion and touch it (never backwards). Idempotent and order-safe: in creation order, each suggestion of the session and agent is closed at the created_at of the next one. Returns the ids whose closed_at moved earlier. */
	linkSession(
		suggestionId: string,
		sessionId: string,
		promptId: string | null,
		at: number,
		agentId?: string,
	): string[];
	/** Latest suggestion of the selected agent sequence with closed_at null and last_event_at >= now - openWindowMs; else null. */
	/** Unknown agents use the main sequence. An agent with a closed window does not fall back. */
	findOpenSuggestion(
		sessionId: string,
		now: number,
		openWindowMs: number,
		agentId?: string | null,
	): string | null;
	/** Time windows [start, end) of the selected agent sequence that overlap [from, to]. start = created_at; end = the earlier of closed_at and last_event_at + openWindowMs (inclusive). */
	sessionWindows(
		sessionId: string,
		from: number,
		to: number,
		openWindowMs: number,
		agentId?: string | null,
	): { id: string; start: number; end: number }[];
	/** Set last_event_at. */
	touch(suggestionId: string, at: number): void;
	closeSuggestion(suggestionId: string, at: number): void;
	insertSignal(record: SignalRecord): void;
	/** Upsert on (suggestion_id, source, scope_key, model). */
	upsertUsage(record: UsageRecord): void;
	/** Distinct transcript and subagent usage scopes of the suggestions, with their stored effort. */
	usageScopes(
		suggestionIds: string[],
	): Pick<UsageRecord, "source" | "scope_key" | "effort">[];
	/**
	 * Replace one (source, scope_key) of the session from a transcript snapshot, in one IMMEDIATE transaction that rolls back on error.
	 * Returns false and writes nothing when the snapshot is older than the stored watermark: an earlier last_at, or the same last_at with fewer messages.
	 * Else: windows over [from, last_at], delete the scope's rows in the session, insert rows(windows), store the watermark.
	 */
	rewriteScope(
		scope: {
			session_id: string;
			source: UsageRecord["source"];
			scope_key: string;
			agent_id?: string | null;
			message_count: number;
			from: number;
			last_at: number;
			openWindowMs: number;
		},
		rows: (
			windows: { id: string; start: number; end: number }[],
		) => UsageRecord[],
	): boolean;
	outcome(suggestionId: string): Outcome | null;
	/** Close the database handle. */
	dispose(): void;
}

// ---------- Use-case deps (api module) ----------

export interface CoreDeps {
	env: Env;
	/** Home dir; spatz files live in <homeDir>/.spatz/. */
	homeDir: string;
	/** Project dir for .spatz.json (opt-out). */
	cwd: string;
	/** Default <homeDir>/.spatz/spatz.db. */
	dbPath: string;
	/** Default <homeDir>/.spatz/openrouter-models.json. */
	openRouterCachePath: string;
	/** Default <homeDir>/.spatz/duckdb-extensions. */
	duckdbExtensionDir: string;
	fetch: FetchFn;
	/** null when TYPESAFE_AI_API_KEY is unset (-> fallback "no_key"). */
	jev: JevClient | null;
	clock: Clock;
	random: RandomFn;
	/** New suggestion id; default crypto.randomUUID. */
	newId: () => string;
	/** Opens the store; tests may return an in-memory or fake store. */
	openStore: (dbPath: string) => Store;
	/** Optional preloaded config; when absent the api loads it from files and env. */
	config?: Config;
}

// ---------- Use-case API (what the CLI and a later MCP server call) ----------

export interface SuggestInput {
	task: string;
	/** Raw --models value, e.g. "claude-opus-5-5:low+medium+high,gpt-6-sol:medium". */
	models: string;
	dryRun: boolean;
	scope?: RoutingScope;
	source?: Agent;
	session?: string;
	turn?: string;
	agentId?: string;
}

export interface ReportInput {
	suggestionId: string;
	model: string;
	effort: string;
	result: ReportResult;
	source?: "claude-code-mod";
	turn?: string;
	rounds?: number;
	note?: string;
}

export interface UsageInput {
	suggestionId: string;
	model: string;
	effort?: string;
	source: "claude-code-mod";
	turn: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
}

export interface LinkInput {
	suggestionId: string;
	agentId: string;
	session: string;
}

export interface StatsInput {
	by?: "scope";
	type?: TaskType;
}

export interface SpatzApi {
	suggest(input: SuggestInput): Promise<Suggestion>;
	usage(input: UsageInput): Promise<UsageRecord>;
	/** Gives a suggestion made before its subagent existed the real agent id and the session. Idempotent. */
	link(input: LinkInput): Promise<void>;
	report(input: ReportInput): Promise<Outcome | null>;
	/** Never throws; swallows every error (hooks must not block the session). */
	handleHook(event: string, stdin: string): Promise<void>;
	stats(input: StatsInput): Promise<StatsReport>;
}
