// Shared data contracts for spatz. Owned by nobody: change only by agreement.
// Spec: scratchpad/spatz-spec.md. Field names follow the spec (snake_case where the spec uses it).

// ---------- Taxonomy (spec "Klassifikation mit Jev") ----------

export const TASK_TYPES = [
	"code.bugfix",
	"code.feature",
	"code.refactor",
	"code.explain",
	"review",
	"spec",
	"planning",
	"other",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Rubric order matters: Jev score key "0" = leicht, "1" = mittel, "2" = schwer. */
export const DIFFICULTIES = ["leicht", "mittel", "schwer"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const CRITICALITIES = [
	"none",
	"business_logic",
	"security",
	"data_integrity",
] as const;
export type Criticality = (typeof CRITICALITIES)[number];

/** Cost order of efforts: low < medium < high < xhigh < max. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
/** Efforts used when --models gives no effort for a model (xhigh/max only when explicit). */
export const DEFAULT_EFFORTS: readonly Effort[] = ["low", "medium", "high"];

export const JEV_MODEL = "jev-1.13.0";

// ---------- Startwerte (spec: all are tunable start values) ----------

export interface Tuning {
	/** Learned choice: minimum n per candidate in the cell. Default 5. */
	minN: number;
	/** Learned choice: minimum estimate. Default 0.8. */
	minEstimate: number;
	/** Critical tasks: a cheaper pair needs n >= 10 ... */
	criticalMinN: number;
	/** ... and estimate >= 0.9. */
	criticalMinEstimate: number;
	/** Random draw u in [0,1): u < controlRate -> control. Default 0.1. */
	controlRate: number;
	/** controlRate <= u < controlRate + exploreRate -> exploration. Default 0.1. */
	exploreRate: number;
	/** Jev timeout per request in ms. Default 1000. */
	jevTimeoutMs: number;
	/** If the top difficulty probability is below this, round up one level (ends at schwer). Default 0.5. */
	difficultyMinProbability: number;
	/** A suggestion stays open for hook events until this much idle time. Default 2 h. */
	openWindowMs: number;
	/** OpenRouter model list cache TTL. Default 24 h. */
	openRouterCacheMs: number;
	/** Bound for the OpenRouter request (headers and body); on timeout the stale cache is used. Default 3 s (not in the spec; keeps a suggestion from hanging). */
	openRouterTimeoutMs: number;
	/** Success means quality >= this. Default 0.8. */
	successQuality: number;
}

export const DEFAULT_TUNING: Tuning = {
	minN: 5,
	minEstimate: 0.8,
	criticalMinN: 10,
	criticalMinEstimate: 0.9,
	controlRate: 0.1,
	exploreRate: 0.1,
	jevTimeoutMs: 1000,
	difficultyMinProbability: 0.5,
	openWindowMs: 2 * 60 * 60 * 1000,
	openRouterCacheMs: 24 * 60 * 60 * 1000,
	openRouterTimeoutMs: 3000,
	successQuality: 0.8,
};

// ---------- Candidates and catalog (spec "Kandidaten und Metadaten") ----------

/** One entry of --models after parsing, before OpenRouter lookup. */
export interface RequestedModel {
	/** As passed by the caller, e.g. "claude-opus-5-5". */
	requested_id: string;
	/** Explicit efforts, or null when the caller gave none. */
	efforts: Effort[] | null;
}

/** Trimmed OpenRouter /api/v1/models entry. Prices are USD per token (parsed from strings). */
export interface OpenRouterModel {
	id: string;
	name: string;
	price_prompt: number;
	price_completion: number;
	context_length: number | null;
	/** null = all efforts accepted (field null) or no effort info. Values as listed (may include "none"). */
	supported_efforts: string[] | null;
}

/** A candidate is one (model, effort) pair. */
export interface Candidate {
	/** Canonical OpenRouter id, e.g. "anthropic/claude-opus-5.5". */
	model: string;
	effort: Effort;
	requested_id: string;
	/** false when OpenRouter does not list the model; it then ranks as most expensive. */
	known: boolean;
	price_prompt: number | null;
	price_completion: number | null;
	context_length: number | null;
	/** Local description, or fallback "model name and price class" text for Jev. */
	description: string;
}

/** Candidates sorted by cost order, cheapest first (output price, input price, effort, id; unknown last). */
export type Catalog = Candidate[];

/** "model:effort", e.g. "anthropic/claude-opus-5.5:high". Used as Jev best_candidate label. */
export type CandidateKey = string;

// ---------- Classification ----------

export type FallbackReason =
	| "opt_out"
	| "secret"
	| "no_key"
	| "timeout"
	| "auth"
	| "rate_limit"
	| "error";

export interface JevProbabilities {
	task_type: Record<string, number>;
	/** Keyed by Difficulty (mapped from Jev score keys "0","1","2"). */
	difficulty: Record<string, number>;
	criticality: Record<string, number>;
	/** Keyed by CandidateKey. */
	best_candidate: Record<string, number>;
}

export interface Classification {
	task_type: TaskType;
	/** After round-up rule. */
	difficulty: Difficulty;
	criticality: Criticality;
	/** Jev's best candidate (CandidateKey) or null in the fallback. */
	best_candidate: CandidateKey | null;
	/** null in the fallback. */
	probabilities: JevProbabilities | null;
	/** "jev-1.13.0" or null in the fallback. */
	model_ref: string | null;
	fallback_used: boolean;
	fallback_reason: FallbackReason | null;
}

// ---------- Learning history and estimate ----------

/** Aggregated outcomes for one candidate in one (task_type, difficulty) cell. Non-test only. */
export interface CellStat {
	task_type: TaskType;
	difficulty: Difficulty;
	model: string;
	effort: Effort;
	n: number;
	sum_quality: number;
}

// ---------- Suggestion (spec "Ausgabe") ----------

export type StrategyName = "learned" | "jev-choice" | "rules" | "strongest";

export interface RankingEntry {
	model: string;
	effort: Effort;
	/** Beta mean (1 + sum quality) / (2 + n). */
	estimate: number;
	n: number;
}

/** Pure result of recommend; no id, no persistence. */
export interface Decision {
	strategy: StrategyName;
	/** 1 to 3 entries; [0] is the recommendation. */
	ranking: RankingEntry[];
	reason: string;
	explored: boolean;
	control: boolean;
}

export interface Suggestion {
	suggestion_id: string;
	ranking: RankingEntry[];
	reason: string;
	classification: {
		task_type: TaskType;
		difficulty: Difficulty;
		criticality: Criticality;
	};
	fallback_used: boolean;
	explored: boolean;
	control: boolean;
	strategy: StrategyName;
	is_test: boolean;
}

// ---------- Usage, signal, outcome ----------

export type ReportResult = "pass" | "partial" | "fail";
export const REPORT_VALUES: Record<ReportResult, number> = {
	pass: 1,
	partial: 0.5,
	fail: 0,
};

export type SignalKind = "report" | "test" | "build";
export const SIGNAL_WEIGHTS: Record<SignalKind, number> = {
	report: 1.0,
	test: 1.0,
	build: 0.8,
};

export type SignalSource = "report" | "PostToolUse" | "PostToolUseFailure";

export interface SignalRecord {
	suggestion_id: string;
	kind: SignalKind;
	value: number;
	weight: number;
	source: SignalSource;
	/** Epoch ms. */
	observed_at: number;
}

/** report = spatz report; transcript = Stop (main session); subagent = SubagentStop; agent_tool = PostToolUse on Agent (resolvedModel, 0 tokens). */
export type UsageSource = "report" | "transcript" | "subagent" | "agent_tool";

export interface UsageRecord {
	suggestion_id: string;
	/** Canonical OpenRouter id. */
	model: string;
	/** null when effort.level was missing. */
	effort: Effort | null;
	source: UsageSource;
	/** Dedup key: prompt_id (transcript), agent_id (subagent/agent_tool), "" (report). Upsert on (suggestion_id, source, scope_key, model). */
	scope_key: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	is_sidechain: boolean;
	/** Only for source "report". */
	rounds: number | null;
	note: string | null;
	/** Epoch ms. */
	reported_at: number;
}

/** One row of the SQL view `outcomes`. */
export interface Outcome {
	suggestion_id: string;
	quality: number;
	/** Used pair: report usage, else model with most output tokens. */
	model: string | null;
	effort: Effort | null;
}

/** Row of table `suggestions`. No task text is ever stored. */
export interface SuggestionRecord {
	id: string;
	/** Epoch ms. */
	created_at: number;
	session_id: string | null;
	prompt_id: string | null;
	task_type: TaskType;
	difficulty: Difficulty;
	criticality: Criticality;
	probabilities: JevProbabilities | null;
	model_ref: string | null;
	strategy: StrategyName;
	ranking: RankingEntry[];
	reason: string;
	explored: boolean;
	control: boolean;
	fallback_used: boolean;
	is_test: boolean;
	/** Epoch ms of the last linked event; drives the 2 h open window. */
	last_event_at: number;
	/** Epoch ms when closed (next spatz call in the session, or spatz report), else null. */
	closed_at: number | null;
}

// ---------- Stats (spec "spatz stats") ----------

export interface PairStats {
	model: string;
	effort: Effort | null;
	n: number;
	/** Share of outcomes with quality >= 0.8. */
	success_rate: number;
}

export interface TypeStats {
	task_type: TaskType;
	/** Outcomes of non-test suggestions. */
	n: number;
	pairs: PairStats[];
	/** Share of outcomes whose used pair equals ranking[0]. */
	adoption_rate: number;
	input_tokens: number;
	output_tokens: number;
}

export interface StatsReport {
	by_type: TypeStats[];
	/** Share of non-test suggestions with an outcome. */
	coverage: number;
	/** Success rate of learned vs control, compared per cell, weighted by count per cell. null without data. */
	learned_success: number | null;
	control_success: number | null;
}

// ---------- Config ----------

export interface Config {
	/** false when opted out via env SPATZ_NO_JEV=1 or project file .spatz.json {"jev": false}. */
	jevEnabled: boolean;
	tuning: Tuning;
	/** Alias file ~/.spatz/aliases.json: passed id -> canonical OpenRouter id. Overrides the id rule. */
	aliases: Record<string, string>;
	/** Description file ~/.spatz/descriptions.json: canonical id -> short description for Jev. */
	descriptions: Record<string, string>;
}
