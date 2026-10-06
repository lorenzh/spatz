// report: DuckDB read-only evaluation over the SQLite file (only loaded by spatz stats).
// Spec: "Storage", "Success criteria and measurement".
import { DuckDBInstance } from "@duckdb/node-api";
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
	/** DuckDB extension_directory holding the sqlite extension; INSTALL sqlite only if missing. */
	extensionDir: string;
	type?: TaskType;
	by?: "scope";
	/** Success means quality >= this (0.8). */
	successQuality: number;
	/** Catalog-confirmed models whose only effort is `none`. */
	noneOnlyModels?: string[];
	/** Called with each SQL statement before it runs; may throw to abort (tests block INSTALL). */
	onSql?: (sql: string) => void;
}

// Non-test suggestions and their outcomes. The sqlite scanner reads the view's
// CAST(... AS REAL) column as FLOAT (0.79999999 -> 0.800000011920929), so the
// success test runs inside SQLite at double precision.
const base = (q: number, noneOnlyModels: string[]) => `
WITH s AS (SELECT * FROM db.suggestions WHERE is_test = 0),
oq AS (FROM sqlite_query('db', 'SELECT suggestion_id, model, CASE WHEN model IN (${noneOnlyModels.map((id) => `''${id.replaceAll("'", "''''")}''`).join(",") || "NULL"}) THEN ''none'' ELSE effort END AS effort, quality >= ${q} AS success, attempt_id, root_id FROM (
 SELECT suggestion_id, model, effort, quality, NULL AS attempt_id, NULL AS root_id FROM legacy_outcomes
 UNION ALL SELECT suggestion_id, model, effort, quality, attempt_id, root_id FROM attempt_outcomes
 ) WHERE quality IS NOT NULL')),
o AS (
	SELECT s.task_type, ${difficultySql("s.difficulty")} AS difficulty, s.control, s.strategy, s.explored, o.model, o.effort,
		o.success::INTEGER AS success,
		(o.attempt_id IS NULL OR o.attempt_id = o.root_id) AS first_attempt,
		COALESCE(o.model = json_extract_string(s.ranking, '$[0].model')
			AND o.effort = json_extract_string(s.ranking, '$[0].effort'), false)::INTEGER AS adopted
	FROM s JOIN oq o ON o.suggestion_id = s.id
)`;

/** LOAD sqlite; ATTACH dbPath (TYPE sqlite, READ_ONLY); aggregates from suggestions, usages and the outcomes view; is_test rows excluded. */
export async function runStats(options: StatsOptions): Promise<StatsReport> {
	const { dbPath, extensionDir, type, successQuality: q, onSql } = options;
	// Interpolated into SQL: String(q) of a finite number round-trips exactly.
	if (!Number.isFinite(q)) throw new Error(`invalid successQuality: ${q}`);
	const BASE = base(q, options.noneOnlyModels ?? []);
	const instance = await DuckDBInstance.create(":memory:", {
		extension_directory: extensionDir,
		// Only the explicit INSTALL below may download.
		autoinstall_known_extensions: "false",
	});
	const c = await instance.connect();
	const run = (sql: string) => {
		onSql?.(sql);
		return c.run(sql);
	};
	const rows = async <T>(sql: string): Promise<T[]> => {
		onSql?.(`${BASE} ${sql}`);
		return (await c.runAndReadAll(`${BASE} ${sql}`)).getRowObjectsJS() as T[];
	};
	try {
		try {
			await run("LOAD sqlite");
		} catch {
			await run("INSTALL sqlite");
			await run("LOAD sqlite");
		}
		await run(
			`ATTACH '${dbPath.replaceAll("'", "''")}' AS db (TYPE sqlite, READ_ONLY)`,
		);

		const types = await rows<Omit<TypeStats, "pairs">>(
			`, tok AS (
				SELECT s.task_type, COALESCE(SUM(u.input_tokens), 0)::DOUBLE AS input_tokens,
					COALESCE(SUM(u.output_tokens), 0)::DOUBLE AS output_tokens,
					COALESCE(SUM(u.cache_read_tokens), 0)::DOUBLE AS cache_read_tokens,
					COALESCE(SUM(u.cache_creation_tokens), 0)::DOUBLE AS cache_creation_tokens,
					SUM(u.cost_usd)::DOUBLE AS cost_usd,
					COUNT(*) FILTER (WHERE u.lower_bound = 1)::INTEGER AS incomplete
				FROM s LEFT JOIN db.usage_totals u ON u.suggestion_id = s.id GROUP BY ALL
			), agg AS (
				SELECT task_type, COUNT(*)::INTEGER AS n, AVG(adopted) FILTER (WHERE first_attempt) AS adoption_rate FROM o GROUP BY ALL
			)
			SELECT tok.task_type, COALESCE(agg.n, 0) AS n, COALESCE(agg.adoption_rate, 0) AS adoption_rate,
				tok.input_tokens, tok.output_tokens, tok.cache_read_tokens, tok.cache_creation_tokens, tok.cost_usd, tok.incomplete
			FROM tok LEFT JOIN agg USING (task_type) ORDER BY tok.task_type`,
		);
		const pairs = await rows<PairStats & { task_type: TaskType }>(
			`SELECT task_type, model, effort, COUNT(*)::INTEGER AS n, AVG(success) AS success_rate
			FROM o WHERE model IS NOT NULL GROUP BY ALL ORDER BY model, effort`,
		);
		const [cov] = await rows<{ coverage: number | null }>(
			`SELECT COUNT(DISTINCT o.suggestion_id) / NULLIF(COUNT(DISTINCT s.id), 0) AS coverage
			FROM s LEFT JOIN db.outcomes o ON o.suggestion_id = s.id`,
		);
		const fallbacks = await rows<{ reason: string; n: number }>(
			`SELECT COALESCE(fallback_reason, 'unknown') AS reason, COUNT(*)::INTEGER AS n
			FROM s WHERE fallback_used = 1 GROUP BY ALL ORDER BY reason`,
		);
		const failures = await rows<{ kind: "parse" | "hook"; n: number }>(
			"SELECT kind, COUNT(*)::INTEGER AS n FROM db.failures GROUP BY ALL",
		);
		const [dispatch] = await rows<{
			dispatches: number;
			routed_by_mod: number;
			swapped: number;
		}>(
			`SELECT COUNT(*)::INTEGER AS dispatches,
				COUNT(d.suggestion_id)::INTEGER AS routed_by_mod,
				COUNT(*) FILTER (WHERE d.requested_model IS NOT NULL AND d.answered_model IS NOT NULL
					AND d.requested_model <> d.answered_model)::INTEGER AS swapped
			FROM db.dispatches d LEFT JOIN db.suggestions ds ON ds.id = d.suggestion_id
			WHERE COALESCE(ds.is_test, 0) = 0`,
		);
		// Learned picks (strategy learned, no exploration) vs the control group, per cell (task_type, difficulty)
		// with both groups, weighted by the cell's count of these outcomes. Exploration, jev-choice and rules are no learned pick.
		const [cmp] = await rows<{
			learned_success: number | null;
			control_success: number | null;
		}>(
			`, cmp AS (
				SELECT task_type, difficulty, success, control = 1 AS is_control FROM o
				WHERE first_attempt AND (control = 1 OR (strategy = 'learned' AND explored = 0))
			), cells AS (
				SELECT COUNT(*) AS w,
					AVG(success) FILTER (WHERE NOT is_control) AS l,
					AVG(success) FILTER (WHERE is_control) AS k
				FROM cmp GROUP BY task_type, difficulty HAVING l IS NOT NULL AND k IS NOT NULL
			)
			SELECT SUM(w * l) / SUM(w) AS learned_success, SUM(w * k) / SUM(w) AS control_success FROM cells`,
		);

		const scopes =
			options.by === "scope"
				? await rows<ScopeStats>(`
   , scope_rows AS (
    SELECT s.id, s.scope, s.task_type, oq.success::INTEGER AS success,
     tok.input_tokens, tok.output_tokens, tok.cache_read_tokens, tok.cache_creation_tokens, tok.cost_usd, tok.incomplete
    FROM s LEFT JOIN oq ON oq.suggestion_id = s.id
    LEFT JOIN (
     SELECT suggestion_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_creation_tokens) AS cache_creation_tokens,
      SUM(cost_usd)::DOUBLE AS cost_usd,
      COUNT(*) FILTER (WHERE lower_bound = 1)::INTEGER AS incomplete
     FROM db.usage_totals GROUP BY suggestion_id
    ) tok ON tok.suggestion_id = s.id WHERE s.is_legacy = 1
    UNION ALL
    SELECT s.id, s.scope, s.task_type,
     CASE WHEN c.completed::INTEGER = 1 THEN COALESCE(c.threshold_success::INTEGER, 0) END AS success,
     c.input_tokens::DOUBLE, c.output_tokens::DOUBLE, c.cache_read_tokens::DOUBLE, c.cache_creation_tokens::DOUBLE, c.cost_usd::DOUBLE, c.incomplete::INTEGER
    FROM s JOIN sqlite_query('db', 'SELECT *, quality >= ${q} AS threshold_success FROM chain_outcomes') c ON c.suggestion_id = s.id
   ), agg AS (
    SELECT scope, COUNT(success)::INTEGER AS n, AVG(success) AS success_rate,
     COALESCE(SUM(input_tokens), 0)::DOUBLE AS input_tokens,
     COALESCE(SUM(output_tokens), 0)::DOUBLE AS output_tokens,
     COALESCE(SUM(cache_read_tokens), 0)::DOUBLE AS cache_read_tokens,
     COALESCE(SUM(cache_creation_tokens), 0)::DOUBLE AS cache_creation_tokens,
     SUM(cost_usd)::DOUBLE AS cost_usd,
     COALESCE(SUM(incomplete), 0)::INTEGER AS incomplete
    FROM scope_rows
    ${type ? `WHERE task_type = '${type.replaceAll("'", "''")}'` : ""}
    GROUP BY scope
   )
   SELECT *, COALESCE(cache_read_tokens / NULLIF(input_tokens + cache_read_tokens + cache_creation_tokens, 0), 0) AS cache_read_share
   FROM agg ORDER BY scope NULLS LAST
  `)
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
			learned_success: cmp?.learned_success ?? null,
			control_success: cmp?.control_success ?? null,
		};
	} finally {
		c.closeSync();
		instance.closeSync();
	}
}
