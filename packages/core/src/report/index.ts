// report: read-only bun:sqlite evaluation over the store file (only loaded by spatz stats).
// Spec: "Storage", "Success criteria and measurement".
import { Database } from "bun:sqlite";
import { difficultySql } from "../contracts/difficulty.ts";
import type {
	PairStats,
	ScopeStats,
	StatsReport,
	TaskType,
	TypeStats,
} from "../contracts/types.ts";

export interface StatsOptions {
	dbPath: string;
	type?: TaskType;
	by?: "scope";
	/** Only outcomes of attempts with this model_version. */
	modelVersion?: string;
	/** Success means quality >= this (0.8). */
	successQuality: number;
	/** Catalog-confirmed models whose only effort is `none`. */
	noneOnlyModels?: string[];
}

// Non-test suggestions and their outcomes. Parameters: $q (success quality), $none (JSON array of none-only models), $mv (model version or NULL).
const BASE = `
WITH s AS (SELECT * FROM suggestions WHERE is_test = 0),
oq AS (
	SELECT suggestion_id, model,
		CASE WHEN model IN (SELECT value FROM json_each($none)) THEN 'none' ELSE effort END AS effort,
		quality >= $q AS success, attempt_id, root_id
	FROM (
		SELECT suggestion_id, model, effort, quality, NULL AS attempt_id, NULL AS root_id, NULL AS model_version FROM legacy_outcomes
		UNION ALL SELECT suggestion_id, model, effort, quality, attempt_id, root_id, model_version FROM attempt_outcomes
	) WHERE quality IS NOT NULL AND ($mv IS NULL OR model_version = $mv)
),
o AS (
	SELECT s.id AS suggestion_id, s.task_type, ${difficultySql("s.difficulty")} AS difficulty, s.control, s.strategy, s.explored, o.model, o.effort,
		o.success,
		(o.attempt_id IS NULL OR o.attempt_id = o.root_id) AS first_attempt,
		COALESCE(o.model = json_extract(s.ranking, '$[0].model')
			AND o.effort = json_extract(s.ranking, '$[0].effort'), 0) AS adopted
	FROM s JOIN oq o ON o.suggestion_id = s.id
)`;

/** Opens dbPath read-only; aggregates from suggestions, usages and the outcomes views; is_test rows excluded. */
export async function runStats(options: StatsOptions): Promise<StatsReport> {
	const { dbPath, type, successQuality: q } = options;
	if (!Number.isFinite(q)) throw new Error(`invalid successQuality: ${q}`);
	const db = new Database(dbPath, { readonly: true, strict: true });
	const params = {
		q,
		none: JSON.stringify(options.noneOnlyModels ?? []),
		mv: options.modelVersion ?? null,
		type: type ?? null,
	};
	const rows = <T>(sql: string): T[] =>
		db.query(`${BASE} ${sql}`).all(params) as T[];
	try {
		const types = rows<Omit<TypeStats, "pairs">>(
			`, tok AS (
				SELECT s.task_type, COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
					COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
					COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
					COALESCE(SUM(u.cache_creation_tokens), 0) AS cache_creation_tokens,
					SUM(u.cost_usd) AS cost_usd,
					COUNT(*) FILTER (WHERE u.lower_bound = 1) AS incomplete
				FROM s LEFT JOIN usage_totals u ON u.suggestion_id = s.id GROUP BY s.task_type
			), agg AS (
				SELECT task_type, COUNT(*) AS n, AVG(adopted) FILTER (WHERE first_attempt) AS adoption_rate FROM o GROUP BY task_type
			)
			SELECT tok.task_type, COALESCE(agg.n, 0) AS n, COALESCE(agg.adoption_rate, 0) AS adoption_rate,
				tok.input_tokens, tok.output_tokens, tok.cache_read_tokens, tok.cache_creation_tokens, tok.cost_usd, tok.incomplete
			FROM tok LEFT JOIN agg USING (task_type) ORDER BY tok.task_type`,
		);
		const pairs = rows<PairStats & { task_type: TaskType }>(
			`SELECT task_type, model, effort, COUNT(*) AS n, AVG(success) AS success_rate
			FROM o WHERE model IS NOT NULL GROUP BY task_type, model, effort ORDER BY model, effort`,
		);
		const [cov] = rows<{ coverage: number | null }>(
			`SELECT 1.0 * COUNT(DISTINCT o.suggestion_id) / NULLIF(COUNT(DISTINCT s.id), 0) AS coverage
			FROM s LEFT JOIN outcomes o ON o.suggestion_id = s.id`,
		);
		// An unknown mark (agent ended without evidence) counts as covered: it is explicit, never a silent gap.
		const bySource = rows<{ source: string; n: number; covered: number }>(
			`SELECT COALESCE(s.agent, 'cli') AS source, COUNT(*) AS n,
				COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM outcomes o WHERE o.suggestion_id = s.id)
					OR EXISTS (SELECT 1 FROM unknown_outcomes u WHERE u.suggestion_id = s.id)) AS covered
			FROM s GROUP BY 1 ORDER BY 1`,
		);
		const fallbacks = rows<{ reason: string; n: number }>(
			`SELECT COALESCE(fallback_reason, 'unknown') AS reason, COUNT(*) AS n
			FROM s WHERE fallback_used = 1 GROUP BY 1 ORDER BY 1`,
		);
		const failures = rows<{ kind: "parse" | "hook"; n: number }>(
			"SELECT kind, COUNT(*) AS n FROM failures GROUP BY kind",
		);
		const [dispatch] = rows<{
			dispatches: number;
			routed_by_mod: number;
			swapped: number;
		}>(
			`SELECT COUNT(*) AS dispatches,
				COUNT(d.suggestion_id) AS routed_by_mod,
				COUNT(*) FILTER (WHERE d.requested_model IS NOT NULL AND d.answered_model IS NOT NULL
					AND d.requested_model <> d.answered_model) AS swapped
			FROM dispatches d LEFT JOIN suggestions ds ON ds.id = d.suggestion_id
			WHERE COALESCE(ds.is_test, 0) = 0`,
		);
		// Learned picks (strategy learned, no exploration) vs the control group, per cell (task_type, difficulty)
		// with both groups, weighted by the cell's count of these outcomes. Exploration, jev-choice and rules are no learned pick.
		// learned-fallback picks get their own row against control, never dropped.
		const [cmp] = rows<{
			learned_success: number | null;
			fallback_success: number | null;
			control_success: number | null;
		}>(
			`, cmp AS (
				SELECT task_type, difficulty, success, control = 1 AS is_control, strategy FROM o
				WHERE first_attempt AND (control = 1 OR (strategy IN ('learned', 'learned-fallback') AND explored = 0))
			), cells AS (
				SELECT
					COUNT(*) FILTER (WHERE is_control OR strategy = 'learned') AS w,
					COUNT(*) FILTER (WHERE is_control OR strategy = 'learned-fallback') AS wf,
					AVG(success) FILTER (WHERE NOT is_control AND strategy = 'learned') AS l,
					AVG(success) FILTER (WHERE NOT is_control AND strategy = 'learned-fallback') AS f,
					AVG(success) FILTER (WHERE is_control) AS k
				FROM cmp GROUP BY task_type, difficulty HAVING k IS NOT NULL
			)
			SELECT SUM(w * l) / SUM(w) FILTER (WHERE l IS NOT NULL) AS learned_success,
				SUM(wf * f) / SUM(wf) FILTER (WHERE f IS NOT NULL) AS fallback_success,
				SUM(w * k) FILTER (WHERE l IS NOT NULL) / SUM(w) FILTER (WHERE l IS NOT NULL) AS control_success FROM cells`,
		);

		const scopes =
			options.by === "scope"
				? rows<ScopeStats>(`
			, scope_rows AS (
				SELECT s.id, s.scope, s.task_type, oq.success,
					tok.input_tokens, tok.output_tokens, tok.cache_read_tokens, tok.cache_creation_tokens, tok.cost_usd, tok.incomplete
				FROM s LEFT JOIN oq ON oq.suggestion_id = s.id
				LEFT JOIN (
					SELECT suggestion_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
						SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_creation_tokens) AS cache_creation_tokens,
						SUM(cost_usd) AS cost_usd,
						COUNT(*) FILTER (WHERE lower_bound = 1) AS incomplete
					FROM usage_totals GROUP BY suggestion_id
				) tok ON tok.suggestion_id = s.id WHERE s.is_legacy = 1
				UNION ALL
				SELECT s.id, s.scope, s.task_type,
					CASE WHEN c.completed = 1 THEN COALESCE(c.quality >= $q, 0) END AS success,
					c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_creation_tokens, c.cost_usd, c.incomplete
				FROM s JOIN chain_outcomes c ON c.suggestion_id = s.id
			), agg AS (
				SELECT scope, COUNT(success) AS n, AVG(success) AS success_rate,
					COALESCE(SUM(input_tokens), 0) AS input_tokens,
					COALESCE(SUM(output_tokens), 0) AS output_tokens,
					COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
					COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
					SUM(cost_usd) AS cost_usd,
					COALESCE(SUM(incomplete), 0) AS incomplete
				FROM scope_rows
				WHERE $type IS NULL OR task_type = $type
				GROUP BY scope
			)
			SELECT *, COALESCE(1.0 * cache_read_tokens / NULLIF(input_tokens + cache_read_tokens + cache_creation_tokens, 0), 0) AS cache_read_share
			FROM agg ORDER BY scope NULLS LAST`)
				: undefined;

		return {
			dispatches: dispatch?.dispatches ?? 0,
			routed_by_mod: dispatch?.routed_by_mod ?? 0,
			swapped: dispatch?.swapped ?? 0,
			fallbacks: Object.fromEntries(fallbacks.map((f) => [f.reason, f.n])),
			failures: {
				parse: failures.find((f) => f.kind === "parse")?.n ?? 0,
				hook: failures.find((f) => f.kind === "hook")?.n ?? 0,
				launcher: 0, // Filled by the API from the launcher's marker file.
			},
			...(scopes && { by_scope: scopes }),
			by_type: types
				.filter((t) => !type || t.task_type === type)
				.map((t) => ({
					task_type: t.task_type,
					n: t.n,
					pairs: pairs
						.filter((p) => p.task_type === t.task_type)
						.map(({ task_type: _, ...p }) => p),
					adoption_rate: t.adoption_rate,
					input_tokens: t.input_tokens,
					output_tokens: t.output_tokens,
					cache_read_tokens: t.cache_read_tokens,
					cache_creation_tokens: t.cache_creation_tokens,
					cost_usd: t.cost_usd,
					incomplete: t.incomplete,
				})),
			coverage: cov?.coverage ?? 0,
			coverage_by_source: bySource,
			learned_success: cmp?.learned_success ?? null,
			fallback_success: cmp?.fallback_success ?? null,
			control_success: cmp?.control_success ?? null,
		};
	} finally {
		db.close();
	}
}
