// Bench rows (spatz-eval-row/1) in their own table: never live outcomes, a weak prior only on request.
import type { Database } from "bun:sqlite";
import type { PriorCell } from "../catalog/snapshot.ts";
import type { Store } from "../contracts/deps.ts";

// v12: one row per bench run, keyed by run_id.
export const BENCH_SCHEMA = [
	`CREATE TABLE bench_attempts (
 run_id TEXT PRIMARY KEY, imported_at INTEGER NOT NULL,
 bench_version TEXT NOT NULL, task_id TEXT NOT NULL, task_version INTEGER NOT NULL, task_hash TEXT,
 task_type TEXT NOT NULL, difficulty TEXT NOT NULL, criticality TEXT NOT NULL,
 harness TEXT NOT NULL, agent_version TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
 answered_model TEXT, model_version TEXT, attempt INTEGER NOT NULL,
 result TEXT NOT NULL CHECK (result IN ('pass','partial','fail')), check_kind TEXT NOT NULL, judge TEXT,
 duration_s REAL NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, reasoning_tokens INTEGER,
 tokens_complete INTEGER NOT NULL CHECK (tokens_complete IN (0,1)),
 cost_usd REAL CHECK (cost_usd >= 0),
 cost_source TEXT NOT NULL CHECK (cost_source IN ('reported','priced','unavailable')),
 estimated_cost_usd REAL CHECK (estimated_cost_usd >= 0),
 started_at TEXT NOT NULL, contributor TEXT NOT NULL, verified INTEGER NOT NULL)`,
];

export function benchStore(
	db: Database,
	liveModelVersions: () => Record<string, string>,
): Pick<Store, "importEvalRows" | "benchPriors"> {
	return {
		importEvalRows(rows, at, dryRun) {
			const insert = db.query(
				`INSERT OR IGNORE INTO bench_attempts VALUES ($run_id,$at,$bench_version,$task_id,$task_version,$task_hash,
				$task_type,$difficulty,$criticality,$harness,$agent_version,$model,$effort,$answered_model,$model_version,$attempt,
				$result,$check,$judge,$duration_s,$input,$output,$cache_read,$cache_write,$reasoning,$tokens_complete,
				$cost_usd,$cost_source,$estimated_cost_usd,$started_at,$contributor,$verified)`,
			);
			let added: boolean[] = [];
			const rollback = new Error("dry run");
			try {
				db.transaction(() => {
					added = rows.map(({ row: r, task_hash }) => {
						const t = r.tokens;
						// The harness bill first, else the bench's list-price estimate; never priced without usage.
						const cost = r.cost_usd ?? r.estimated_cost_usd;
						return (
							insert.run({
								run_id: r.run_id,
								at,
								bench_version: r.bench_version,
								task_id: r.task_id,
								task_version: r.task_version,
								task_hash,
								task_type: r.task_type,
								difficulty: r.difficulty,
								criticality: r.criticality,
								harness: r.harness,
								agent_version: r.agent_version,
								model: r.model,
								effort: r.effort,
								answered_model: r.answered_model,
								model_version: r.model_version,
								attempt: r.attempt,
								result: r.result,
								check: r.check,
								judge: r.judge,
								duration_s: r.duration_s,
								...t,
								tokens_complete: Number(
									t.input !== null &&
										t.cache_read !== null &&
										t.cache_write !== null,
								),
								cost_usd: cost,
								cost_source:
									r.cost_usd !== null
										? "reported"
										: cost !== null
											? "priced"
											: "unavailable",
								estimated_cost_usd: r.estimated_cost_usd,
								started_at: r.started_at,
								contributor: r.contributor,
								verified: Number(r.verified),
							}).changes > 0
						);
					});
					if (dryRun) throw rollback;
				}).immediate();
			} catch (error) {
				if (error !== rollback) throw error;
			}
			return added;
		},
		benchPriors() {
			const live = liveModelVersions();
			return db
				.query<
					Omit<PriorCell, "version_match"> & { model_version: string | null },
					[]
				>(
					// Rubric rows weigh 0.5: no local judge is validated.
					`SELECT task_type, difficulty, model, effort, model_version,
					SUM(CASE WHEN check_kind='rubric' THEN 0.5 ELSE 1 END) AS n_eff,
					SUM(CASE WHEN result='pass' THEN CASE WHEN check_kind='rubric' THEN 0.5 ELSE 1 END ELSE 0 END) AS s_eff,
					COUNT(*) AS n_bench
					FROM bench_attempts GROUP BY task_type, difficulty, model, effort, model_version
					ORDER BY task_type, difficulty, model, effort, model_version`,
				)
				.all()
				.flatMap(({ model_version, ...cell }): PriorCell[] => {
					const current = live[cell.model] ?? null;
					if (model_version === null || current === null)
						return [{ ...cell, version_match: "unknown" }];
					return model_version === current
						? [{ ...cell, version_match: "exact" }]
						: [];
				});
		},
	};
}
