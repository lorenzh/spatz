// Injection seams. Unit tests pass fakes for all of these; no network, no real home dir.
import type { AttemptStore } from "./attempts.ts";
import type { DifficultyInput } from "./difficulty.ts";
import type {
	Agent,
	CellStat,
	Config,
	DispatchRecord,
	Outcome,
	ReportResult,
	RoutingScope,
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

export interface Store extends AttemptStore {
	/** One observation per session and agent; fill missing fields only. */
	upsertDispatch(record: DispatchRecord): void;
	/** Count once per kind, event, session and turn; count each call when either id is absent. */
	recordFailure(
		kind: "parse" | "hook",
		event: string,
		at: number,
		sessionId: string | null,
		turnId: string | null,
	): void;
	insertSuggestion(
		record: Omit<SuggestionRecord, "difficulty"> & {
			difficulty: DifficultyInput;
		},
	): void;
	getSuggestion(id: string): SuggestionRecord | null;
	/** First attempts of root suggestions plus legacy/eval outcomes, grouped by cell and actual pair. Non-test only. */
	/** successQuality defaults to DEFAULT_TUNING.successQuality. */
	cellStats(taskType: TaskType, successQuality?: number): CellStat[];
	/** Later attempts and --retry-of chain members, grouped by cell and actual pair. Non-test only. */
	retryStats(taskType: TaskType, successQuality?: number): CellStat[];
	/** Link session_id/prompt_id to the suggestion and touch it (never backwards). Idempotent and order-safe: in creation order, each suggestion of the session and agent is closed at the created_at of the next one. Returns the ids whose closed_at moved earlier. */
	linkSession(
		suggestionId: string,
		sessionId: string,
		promptId: string | null,
		at: number,
		agentId?: string,
		harness?: "codex" | "claude-code",
	): string[];
	/** Time windows [start, end) of the selected agent sequence that overlap [from, to]. start = created_at; end = the earlier of closed_at and last_event_at + openWindowMs (inclusive). */
	sessionWindows(
		sessionId: string,
		from: number,
		to: number,
		openWindowMs: number,
		agentId?: string | null,
	): { id: string; start: number; end: number }[];
	closeSuggestion(suggestionId: string, at: number): void;
	/** Upsert on (suggestion_id, source, scope_key, model). */
	upsertUsage(record: UsageRecord): void;
	getUsage(
		suggestionId: string,
		source: UsageRecord["source"],
		scopeKey: string,
		model: string,
	): UsageRecord | null;
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
	openStore: (dbPath: string, noneOnlyModels?: string[]) => Store;
	/** Optional preloaded config; when absent the api loads it from files and env. */
	config?: Config;
}

// ---------- Use-case API (what the CLI and a later MCP server call) ----------

export interface SuggestInput {
	retryOf?: string;
	/** Original explicit model before routing; "-" means no explicit model. */
	requested?: string;
	/** Custom Claude agent whose definition supplies the model when none is explicit. */
	requestedAgent?: string;
	task: string;
	/** Raw --models value, e.g. "claude-opus-5-5:low+medium+high,gpt-6-sol:medium". */
	models?: string;
	family?: string;
	dryRun: boolean;
	scope?: RoutingScope;
	source?: Agent;
	session?: string;
	turn?: string;
	agentId?: string;
}

export interface ReportInput {
	attempt?: string;
	correct?: boolean;
	confirm?: boolean;
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
	attempt?: string;
	key?: string;
	session?: string;
	agentId?: string;
	costUsd?: number;
	suggestionId: string;
	model: string;
	effort?: string;
	source: "claude-code-mod";
	turn: string;
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheCreation: number | null;
}

export interface LinkInput {
	suggestionId: string;
	agentId: string;
	session: string;
}

export interface StatsInput {
	by?: "scope";
	type?: TaskType;
	/** Only outcomes recorded under this model version. */
	modelVersion?: string;
}

export interface SpatzApi {
	startAttempt(input: {
		suggestionId: string;
		key: string;
		model: string;
		effort?: string;
		session: string;
		agentId?: string;
		turn?: string;
		ownsUsage?: boolean;
	}): Promise<import("./attempts.ts").AttemptRecord>;
	bindAttempt(input: {
		attempt: string;
		call: string;
		session: string;
		agentId?: string;
	}): Promise<void>;
	finalizeAttempts(input: { session: string; agentId?: string }): Promise<void>;
	/** Import each Codex turn against an explicit suggestion; the same turn replaces its prior records. */
	importRollout(input: {
		file: string;
		suggestionId: string;
	}): Promise<{ suggestion_id: string; turns: number }>;
	suggest(input: SuggestInput): Promise<Suggestion>;
	usage(input: UsageInput): Promise<UsageRecord>;
	/** Gives a suggestion made before its subagent existed the real agent id and the session. Idempotent. */
	link(input: LinkInput): Promise<void>;
	report(input: ReportInput): Promise<Outcome | null>;
	/** Never throws; swallows every error (hooks must not block the session). */
	handleHook(event: string, stdin: string): Promise<void>;
	stats(input: StatsInput): Promise<StatsReport>;
}
