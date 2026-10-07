// Shared data contracts for spatz. Owned by nobody: change only by agreement.
// Spec: scratchpad/spatz-spec.md. Field names follow the spec (snake_case where the spec uses it).

// ---------- Taxonomy (spec "Classification with Jev") ----------

/** Taxonomy v2 (GitHub issue #72): a superset of v1, so old rows stay valid. Learning stays per type. */
export const TASK_TYPES = [
	"code.bugfix",
	"code.feature",
	"code.refactor",
	"code.test",
	"code.explain",
	"investigation",
	"review",
	"spec",
	"planning",
	"ops",
	"design.ui",
	"design.visual",
	"design.3d",
	"writing",
	"research",
	"data",
	"other",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Family per type; it only drives pooling (Tuning.familyPooling). */
export const TASK_FAMILY: Record<TaskType, string> = {
	"code.bugfix": "code",
	"code.feature": "code",
	"code.refactor": "code",
	"code.test": "code",
	"code.explain": "code",
	investigation: "code",
	review: "review",
	spec: "planning",
	planning: "planning",
	ops: "ops",
	"design.ui": "design",
	"design.visual": "design",
	"design.3d": "design",
	writing: "prose",
	research: "prose",
	data: "data",
	other: "other",
};

/** Rubric order matters: Jev score key "0" = easy, "1" = medium, "2" = hard. */
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const CRITICALITIES = [
	"none",
	"business_logic",
	"security",
	"data_integrity",
] as const;
export type Criticality = (typeof CRITICALITIES)[number];

/** Cost order of efforts: none < low < medium < high < xhigh < max < ultra. */
export const EFFORTS = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const;
export type Effort = (typeof EFFORTS)[number];
/** Efforts used when --models gives no effort for a model (none/xhigh/max/ultra only when explicit). */
export const DEFAULT_EFFORTS: readonly Effort[] = ["low", "medium", "high"];

export const JEV_MODEL = "jev-1.13.0";

// ---------- Initial values (spec: all are tunable start values) ----------

export interface Tuning {
	/** Learned choice: minimum n per candidate in the cell. Default 5. */
	minN: number;
	/** Learned choice: minimum estimate. Default 0.8. */
	minEstimate: number;
	/** Critical tasks: a cheaper pair needs n >= 10 ... */
	criticalMinN: number;
	/** ... and 5 % lower Beta bound of success >= 0.9. */
	criticalMinEstimate: number;
	/** Random draw u in [0,1): u < controlRate -> control. Default 0.1. */
	controlRate: number;
	/** controlRate <= u < controlRate + exploreRate -> exploration. Default 0.1. */
	exploreRate: number;
	/** Jev timeout per request in ms. Default 1000. */
	jevTimeoutMs: number;
	/** If the top difficulty probability is below this, round up one level (ends at hard). Default 0.5. */
	difficultyMinProbability: number;
	/** A suggestion stays open for hook events until this much idle time. Default 2 h. */
	openWindowMs: number;
	/** OpenRouter model list cache TTL. Default 24 h. */
	openRouterCacheMs: number;
	/** Bound for the OpenRouter request (headers and body); on timeout the stale cache is used. Default 3 s (not in the spec; keeps a suggestion from hanging). */
	openRouterTimeoutMs: number;
	/** Success means quality >= this. Default 0.8. */
	successQuality: number;
	/** Thin cells pool over the same family at the same level after the type levels. Default false until the offline replay shows no harm; env SPATZ_FAMILY_POOLING=1. */
	familyPooling: boolean;
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
	familyPooling: false,
};

// ---------- Candidates and catalog (spec "Candidates and metadata") ----------

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
	price_cache_read: number | null;
	price_cache_write: number | null;
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
	/** Outcomes with quality >= successQuality; learning uses these, not sum_quality. */
	successes: number;
}

// ---------- Suggestion (spec "Output") ----------

export type StrategyName =
	| "learned"
	| "learned-fallback"
	| "jev-choice"
	| "rules"
	| "strongest";

export interface RankingEntry {
	model: string;
	effort: Effort;
	/** Beta mean of success (1 + successes) / (2 + n). */
	estimate: number;
	/** Live first attempts; the only count gates use. */
	n: number;
	/** Prior weight from the bench snapshot (min(2, n_eff)); absent without a prior. */
	n_prior?: number;
	/** Raw bench runs behind the prior; absent without a prior. */
	n_bench?: number;
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

export type ModelsSource =
	| "flag"
	| "env"
	| "project"
	| "user"
	| "preset:claude-code"
	| "preset:codex";

export interface Suggestion {
	/** Resolved cost-ordered ladder for the Claude mod. */
	candidates?: { model: string; effort: Effort }[];
	models_source: ModelsSource;
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

export type SignalSource =
	| "report"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "Stop"
	| "claude-code-mod";

export interface SignalRecord {
	turn_id?: string | null;
	agent_id?: string | null;
	suggestion_id: string;
	kind: SignalKind;
	value: number;
	weight: number;
	source: SignalSource;
	/** Epoch ms. */
	observed_at: number;
}

/** report = spatz report; transcript = Stop (main session); subagent = SubagentStop; agent_tool = PostToolUse on Agent (resolvedModel, unknown tokens); claude-code-mod = direct turn usage. */
export type UsageSource =
	| "report"
	| "transcript"
	| "subagent"
	| "agent_tool"
	| "claude-code-mod";

export type PriceSnapshot = Pick<
	OpenRouterModel,
	"price_prompt" | "price_completion" | "price_cache_read" | "price_cache_write"
>;
export type CostSource = "reported" | "priced" | "unavailable";

export interface UsageRecord {
	/** Populated by the store. Only reported costs may be supplied by callers. */
	cost_usd?: number | null;
	cost_source?: CostSource;
	tokens_complete?: 0 | 1;
	tokens_schema?: 1 | 2;
	turn_id?: string | null;
	agent_id?: string | null;
	suggestion_id: string;
	/** Canonical OpenRouter id. */
	model: string;
	/** null when effort.level was missing. */
	effort: Effort | null;
	source: UsageSource;
	/** Dedup key: prompt_id (transcript), agent_id (subagent/agent_tool), turn_id (claude-code-mod or direct report), "" (legacy report). Upsert on (suggestion_id, source, scope_key, model). */
	scope_key: string;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_creation_tokens: number | null;
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
	quality: number | null;
	attempt_id: string | null;
	ordinal: number | null;
	root_id: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_creation_tokens: number | null;
	/** Used pair: report usage, else model with most output tokens. */
	model: string | null;
	effort: Effort | null;
}

export const SCOPES = [
	"step",
	"turn",
	"subagent",
	"session",
	"escalate",
] as const;
export type RoutingScope = (typeof SCOPES)[number];
export const AGENTS = ["claude-code", "claude-code-mod", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

/** One dispatch, joined by the session and child agent identity. */
export interface DispatchRecord {
	attempt_id?: string | null;
	session_id: string;
	agent_id: string;
	tool_use_id: string | null;
	requested_model: string | null;
	requested_agent_type: string | null;
	answered_model: string | null;
	suggestion_id: string | null;
}

/** Row of table `suggestions`. No task text is ever stored. */
export interface SuggestionRecord {
	retry_of?: string;
	is_legacy?: number;
	/** Original model before mod routing; null when absent or unknown. */
	requested_model?: string | null;
	/** Candidate model IDs mapped to four USD-per-token rates captured at creation. */
	price_snapshot?: Record<string, PriceSnapshot>;
	/** Capture time in epoch milliseconds, null for pre-v6 suggestions. */
	price_date?: number | null;
	scope: RoutingScope | null;
	agent: Agent | null;
	turn_id: string | null;
	agent_id: string | null;
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
	/** Null without fallback and for rows older than schema v5. */
	fallback_reason: FallbackReason | null;
	is_test: boolean;
	/** Epoch ms of the last linked event; drives the 2 h open window. */
	last_event_at: number;
	/** Epoch ms when closed (next spatz call in the same session and agent, or spatz report), else null. */
	closed_at: number | null;
}

// ---------- Stats (spec "spatz stats") ----------

export interface PairStats {
	model: string;
	effort: Effort | null;
	n: number;
	/** Share of outcomes with quality >= 0.8. */
	success_rate: number;
	/** Chain spend (attempts only) of completed chains rooted at this pair with known cost / their successes. null without a success or cost. */
	cost_usd_per_success: number | null;
	/** Same for tokens (input + output + cache read + cache creation). */
	tokens_per_success: number | null;
	/** Mean cost of one attempt of this pair. null without priced attempts. */
	cost_usd_per_attempt: number | null;
	/** Orchestration spend of the counted chains, listed apart from attempt spend. */
	orchestration_cost_usd: number | null;
	/** Share of completed chains in `n` with incomplete cost evidence; excluded from the spend. */
	cost_incomplete_share: number;
}

export interface TypeStats {
	cache_read_tokens: number;
	cache_creation_tokens: number;
	cost_usd: number | null;
	/** Known Claude subagent lower-bound usage estimates excluded from cost. */
	incomplete: number;
	task_type: TaskType;
	/** Outcomes of non-test suggestions. */
	n: number;
	pairs: PairStats[];
	/** Share of outcomes whose used pair equals ranking[0]. */
	adoption_rate: number;
	input_tokens: number;
	output_tokens: number;
}

export interface ScopeStats {
	cost_usd: number | null;
	/** Known Claude subagent lower-bound usage estimates excluded from cost. */
	incomplete: number;
	scope: RoutingScope | null;
	/** Number of outcomes, as in TypeStats. */
	n: number;
	/** null without outcomes. */
	success_rate: number | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	/** cache_read / (input + cache_read + cache_creation), or 0 with no input. */
	cache_read_share: number;
}

export interface StatsReport {
	/** Global dispatch counts, excluding linked dry-run suggestions. */
	dispatches: number;
	routed_by_mod: number;
	swapped: number;
	/** Global non-test fallback counts; unknown means a legacy row without a reason. */
	fallbacks: Record<string, number>;
	/** Global failure counts, independent of suggestion filters. */
	failures: { parse: number; hook: number; launcher: number };
	by_scope?: ScopeStats[];
	by_type: TypeStats[];
	/** Share of non-test suggestions with an outcome. */
	coverage: number;
	/** Per source (claude-code-mod, claude-code, codex, cli): non-test suggestions and how many have an outcome or an explicit unknown. */
	coverage_by_source: { source: string; n: number; covered: number }[];
	/** Success rate of learned vs control, compared per cell, weighted by count per cell. null without data. */
	learned_success: number | null;
	/** Success rate of learned-fallback picks (best estimate, no pair met the limits) vs control in the same cells. null without data. */
	fallback_success: number | null;
	control_success: number | null;
	learned_vs_control: LearnedVsControl;
}

/** First-attempt success of an arm against control, weighted per (task_type, difficulty) cell by the arm's outcomes. */
export interface ArmComparison {
	/** Routed non-control decisions of the arm, with and without outcome. */
	decisions: number;
	outcomes: number;
	/** outcomes / decisions. null without decisions. */
	coverage: number | null;
	rate: number | null;
	control_rate: number | null;
	/** rate - control_rate. null when no cell has both. */
	diff: number | null;
	/** Bootstrap 95 % interval of diff. null without diff. */
	ci95: [number, number] | null;
}

export interface LearnedVsControl {
	/** All routed non-control decisions by assigned arm: qualified and fallback together. */
	itt: ArmComparison;
	/** strategy learned, not explored. */
	qualified: ArmComparison;
	/** strategy learned-fallback, not explored. */
	fallback: ArmComparison;
	control: { decisions: number; outcomes: number };
	/** Cell mix: outcomes per cell, learned arms together vs control. */
	cells: {
		task_type: TaskType;
		difficulty: string;
		learned: number;
		control: number;
	}[];
}

// ---------- Config ----------

export interface Config {
	/** Selected file default. Validate only when suggestions use it. */
	models?: { value: unknown; source: "project" | "user" };
	/** false when opted out via env SPATZ_NO_JEV=1 or project file .spatz.json {"jev": false}. */
	jevEnabled: boolean;
	tuning: Tuning;
	/** Alias file ~/.spatz/aliases.json: passed id -> canonical OpenRouter id. Overrides the id rule. */
	aliases: Record<string, string>;
	/** Description file ~/.spatz/descriptions.json: canonical id -> short description for Jev. */
	descriptions: Record<string, string>;
}
