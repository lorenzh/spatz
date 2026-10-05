// store: bun:sqlite with schema, migrations (PRAGMA user_version), WAL and busy_timeout.
// Spec: "Storage", outcomes view per "Signals".
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "../contracts/deps.ts";
import {
	difficultySql,
	normalizeDifficulty,
	normalizeProbabilities,
	normalizeReason,
} from "../contracts/difficulty.ts";
import type {
	CellStat,
	Outcome,
	SuggestionRecord,
	UsageRecord,
} from "../contracts/types.ts";
import { EFFORTS } from "../contracts/types.ts";

// No column holds task text (spec "Storage", "Privacy").
const SCHEMA_V1 = `
CREATE TABLE suggestions (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	session_id TEXT,
	prompt_id TEXT,
	task_type TEXT NOT NULL,
	difficulty TEXT NOT NULL,
	criticality TEXT NOT NULL,
	probabilities TEXT,
	model_ref TEXT,
	strategy TEXT NOT NULL,
	ranking TEXT NOT NULL,
	reason TEXT NOT NULL,
	explored INTEGER NOT NULL,
	control INTEGER NOT NULL,
	fallback_used INTEGER NOT NULL,
	is_test INTEGER NOT NULL,
	last_event_at INTEGER NOT NULL,
	closed_at INTEGER
);
CREATE INDEX suggestions_session ON suggestions (session_id, created_at);
CREATE TABLE usages (
	suggestion_id TEXT NOT NULL,
	model TEXT NOT NULL,
	effort TEXT,
	source TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	cache_read_tokens INTEGER NOT NULL,
	cache_creation_tokens INTEGER NOT NULL,
	is_sidechain INTEGER NOT NULL,
	rounds INTEGER,
	note TEXT,
	reported_at INTEGER NOT NULL,
	UNIQUE (suggestion_id, source, scope_key, model)
);
CREATE TABLE signals (
	suggestion_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	value REAL NOT NULL,
	weight REAL NOT NULL,
	source TEXT NOT NULL,
	observed_at INTEGER NOT NULL
);
CREATE INDEX signals_suggestion ON signals (suggestion_id);
-- quality: the latest report wins; else the latest value per hook kind, weighted mean over kinds.
-- Used pair: the latest report usage; else the model with most output tokens, effort = its latest non-null effort.
CREATE VIEW outcomes AS
WITH latest AS (
	SELECT suggestion_id, kind, value, weight FROM (
		SELECT *, ROW_NUMBER() OVER (
			PARTITION BY suggestion_id, kind ORDER BY observed_at DESC, rowid DESC
		) AS rn FROM signals
	) WHERE rn = 1
),
quality AS (
	SELECT suggestion_id, COALESCE(
		MAX(CASE WHEN kind = 'report' THEN value END),
		SUM(CASE WHEN kind <> 'report' THEN weight * value END)
			/ SUM(CASE WHEN kind <> 'report' THEN weight END)
	) AS quality
	FROM latest GROUP BY suggestion_id
),
candidates AS (
	SELECT suggestion_id, model, effort, 0 AS prio, reported_at AS rank_key
	FROM usages WHERE source = 'report'
	UNION ALL
	SELECT suggestion_id, model, (
		SELECT effort FROM usages e
		WHERE e.suggestion_id = u.suggestion_id AND e.model = u.model AND e.effort IS NOT NULL
		ORDER BY e.reported_at DESC, e.rowid DESC LIMIT 1
	), 1, SUM(output_tokens)
	FROM usages u GROUP BY suggestion_id, model
),
pair AS (
	SELECT suggestion_id, model, effort FROM (
		SELECT *, ROW_NUMBER() OVER (
			PARTITION BY suggestion_id ORDER BY prio, rank_key DESC, model
		) AS rn FROM candidates
	) WHERE rn = 1
)
SELECT q.suggestion_id AS suggestion_id, CAST(q.quality AS REAL) AS quality,
	p.model AS model, p.effort AS effort
FROM quality q LEFT JOIN pair p ON p.suggestion_id = q.suggestion_id;
`;

// Watermark per usage scope: the transcript snapshot last written, ordered by last_at; message_count breaks ties.
const SCHEMA_V2 = `
CREATE TABLE usage_scopes (
	session_id TEXT NOT NULL,
	source TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	message_count INTEGER NOT NULL,
	last_at INTEGER NOT NULL,
	PRIMARY KEY (session_id, source, scope_key)
);
`;

const SCHEMA_V3 = `
ALTER TABLE suggestions ADD COLUMN scope TEXT CHECK (scope IN ('step', 'turn', 'subagent', 'session', 'escalate'));
ALTER TABLE suggestions ADD COLUMN agent TEXT CHECK (agent IN ('claude-code', 'claude-code-mod', 'codex'));
ALTER TABLE suggestions ADD COLUMN turn_id TEXT;
ALTER TABLE suggestions ADD COLUMN agent_id TEXT;
ALTER TABLE usages ADD COLUMN turn_id TEXT;
ALTER TABLE usages ADD COLUMN agent_id TEXT;
ALTER TABLE signals ADD COLUMN turn_id TEXT;
ALTER TABLE signals ADD COLUMN agent_id TEXT;
CREATE UNIQUE INDEX signals_turn ON signals (suggestion_id, source, turn_id, kind) WHERE turn_id IS NOT NULL;
`;

// One statement per entry: bun:sqlite run() ignores step errors after the first statement of a multi-statement string.
const SCHEMA_V4 = [
	`UPDATE suggestions SET difficulty = ${difficultySql("difficulty")}`,
	`UPDATE suggestions SET probabilities = json_set(probabilities, '$.difficulty', json((
	SELECT json_group_object(${difficultySql("key")}, value)
	FROM json_each(suggestions.probabilities, '$.difficulty')
	WHERE key NOT IN ('leicht', 'mittel', 'schwer')
		OR json_type(suggestions.probabilities, '$.difficulty.' || ${difficultySql("key")}) IS NULL
))) WHERE json_type(probabilities, '$.difficulty') = 'object'`,
	`UPDATE suggestions SET reason = replace(replace(reason,
	'leicht+mittel+schwer level', 'easy+medium+hard level'),
	'mittel+schwer level', 'medium+hard level')`,
];

// Attempts: each signal counts for the pair that produced it, so a stronger retry is not credited to the
// failed pair. Signals without a model (all rows before v5) use the suggestion's used pair, as in v1.
// Per attempt: the latest report wins, else the latest value per hook kind, weighted mean over kinds.
const SCHEMA_V5 = [
	"ALTER TABLE suggestions ADD COLUMN fallback_reason TEXT CHECK (fallback_reason IN ('opt_out', 'secret', 'no_key', 'timeout', 'auth', 'rate_limit', 'error'))",
	"ALTER TABLE signals ADD COLUMN model TEXT",
	"ALTER TABLE signals ADD COLUMN effort TEXT",
	"CREATE TABLE failures (kind TEXT NOT NULL CHECK (kind IN ('parse', 'hook')), source TEXT NOT NULL, observed_at INTEGER NOT NULL)",
	"DROP VIEW outcomes",
	`CREATE VIEW attempts AS
WITH usage_effort AS (
	SELECT suggestion_id, model, effort FROM (
		SELECT suggestion_id, model, effort, ROW_NUMBER() OVER (
			PARTITION BY suggestion_id, model ORDER BY reported_at DESC, rowid DESC
		) AS rn FROM usages WHERE effort IS NOT NULL
	) WHERE rn = 1
),
candidates AS (
	SELECT suggestion_id, model, effort, 0 AS prio, reported_at AS rank_key
	FROM usages WHERE source = 'report'
	UNION ALL
	SELECT u.suggestion_id, u.model, e.effort, 1, SUM(u.output_tokens)
	FROM usages u LEFT JOIN usage_effort e ON e.suggestion_id = u.suggestion_id AND e.model = u.model
	GROUP BY u.suggestion_id, u.model
),
pair AS (
	SELECT suggestion_id, model, effort FROM (
		SELECT *, ROW_NUMBER() OVER (
			PARTITION BY suggestion_id ORDER BY prio, rank_key DESC, model
		) AS rn FROM candidates
	) WHERE rn = 1
),
credited AS (
	SELECT s.suggestion_id, s.kind, s.value, s.weight, s.observed_at, s.rowid AS rid,
		COALESCE(s.model, p.model) AS model,
		CASE WHEN s.model IS NULL THEN p.effort ELSE COALESCE(s.effort, e.effort) END AS effort
	FROM signals s
	LEFT JOIN pair p ON p.suggestion_id = s.suggestion_id
	LEFT JOIN usage_effort e ON e.suggestion_id = s.suggestion_id AND e.model = s.model
),
latest AS (
	SELECT * FROM (
		SELECT *, ROW_NUMBER() OVER (
			PARTITION BY suggestion_id, model, effort, kind ORDER BY observed_at DESC, rid DESC
		) AS rn,
		MIN(observed_at) OVER (PARTITION BY suggestion_id, model, effort) AS first_at,
		MAX(observed_at) OVER (PARTITION BY suggestion_id, model, effort) AS last_at
		FROM credited
	) WHERE rn = 1
),
graded AS (
	SELECT suggestion_id, model, effort, MIN(first_at) AS first_at, MAX(last_at) AS last_at, COALESCE(
		MAX(CASE WHEN kind = 'report' THEN value END),
		SUM(CASE WHEN kind <> 'report' THEN weight * value END)
			/ SUM(CASE WHEN kind <> 'report' THEN weight END)
	) AS quality
	FROM latest GROUP BY suggestion_id, model, effort
)
SELECT suggestion_id, ROW_NUMBER() OVER (
		PARTITION BY suggestion_id ORDER BY first_at, model, effort
	) AS attempt,
	model, effort, CAST(quality AS REAL) AS quality, first_at, last_at
FROM graded`,
	"CREATE VIEW outcomes AS SELECT suggestion_id, quality, model, effort FROM attempts",
];

const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5];
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Opens the db with WAL and busy_timeout 5000 and migrates to SCHEMA_VERSION. */
export function openDatabase(dbPath: string): Database {
	if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true, strict: true });
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");
	const version = () =>
		db.query<{ user_version: number }, []>("PRAGMA user_version").get()
			?.user_version ?? 0;
	for (let v = version(); v < SCHEMA_VERSION; v = version()) {
		// IMMEDIATE + re-check: two processes opening the same file must not both migrate.
		db.transaction(() => {
			if (version() !== v) return;
			for (const sql of [MIGRATIONS[v] ?? []].flat()) db.run(sql);
			db.run(`PRAGMA user_version = ${v + 1}`);
		}).immediate();
	}
	return db;
}

type SuggestionRow = Omit<
	SuggestionRecord,
	| "probabilities"
	| "ranking"
	| "explored"
	| "control"
	| "fallback_used"
	| "is_test"
> & {
	probabilities: string | null;
	ranking: string;
	explored: number;
	control: number;
	fallback_used: number;
	is_test: number;
};

/** Creates the parent dir, opens the db, sets journal_mode=WAL and busy_timeout=5000, migrates, returns the Store. ":memory:" allowed. */
export function openStore(
	dbPath: string,
	noneOnlyModels: string[] = [],
): Store {
	const db = openDatabase(dbPath);
	const noneOnly = new Set(noneOnlyModels);
	// Legacy agents share the main sequence until they have an explicit link.
	const windowAgent = (session: string, agent: string | null) =>
		agent !== null &&
		db
			.query(
				"SELECT 1 FROM suggestions WHERE session_id = ? AND agent_id = ? LIMIT 1",
			)
			.get(session, agent)
			? agent
			: null;
	const store: Store = {
		insertSuggestion(r) {
			db.query(
				`INSERT INTO suggestions VALUES ($id, $created_at, $session_id, $prompt_id, $task_type, $difficulty,
				$criticality, $probabilities, $model_ref, $strategy, $ranking, $reason, $explored, $control,
				$fallback_used, $is_test, $last_event_at, $closed_at, $scope, $agent, $turn_id, $agent_id, $fallback_reason)`,
			).run({
				...r,
				difficulty: normalizeDifficulty(r.difficulty),
				reason: normalizeReason(r.reason),
				probabilities:
					r.probabilities &&
					JSON.stringify(normalizeProbabilities(r.probabilities)),
				ranking: JSON.stringify(r.ranking),
				explored: Number(r.explored),
				control: Number(r.control),
				fallback_used: Number(r.fallback_used),
				is_test: Number(r.is_test),
				fallback_reason: r.fallback_reason ?? null,
			});
		},
		getSuggestion(id) {
			const row = db
				.query<SuggestionRow, [string]>(
					"SELECT * FROM suggestions WHERE id = ?",
				)
				.get(id);
			if (!row) return null;
			return {
				...row,
				difficulty: normalizeDifficulty(row.difficulty),
				reason: normalizeReason(row.reason),
				probabilities: normalizeProbabilities(
					row.probabilities ? JSON.parse(row.probabilities) : null,
				),
				ranking: JSON.parse(row.ranking),
				explored: row.explored === 1,
				control: row.control === 1,
				fallback_used: row.fallback_used === 1,
				is_test: row.is_test === 1,
			};
		},
		cellStats(taskType) {
			// Old rows keep their stored effort; for catalog-confirmed none-only models any effort counts as none.
			return db
				.query<CellStat, string[]>(
					`WITH normalized AS (
						SELECT *, CASE WHEN model IN (${noneOnlyModels.map(() => "?").join()}) THEN 'none' ELSE effort END AS known_effort FROM outcomes
					)
					SELECT s.task_type, ${difficultySql("s.difficulty")} AS difficulty, o.model, o.known_effort AS effort, COUNT(*) AS n, SUM(o.quality) AS sum_quality
					FROM suggestions s JOIN normalized o ON o.suggestion_id = s.id
					WHERE s.task_type = ? AND s.is_test = 0 AND o.model IS NOT NULL AND o.known_effort IS NOT NULL
					GROUP BY s.task_type, ${difficultySql("s.difficulty")}, o.model, o.known_effort`,
				)
				.all(...noneOnlyModels, taskType);
		},
		linkSession(id, sessionId, promptId, at, agentId) {
			// Hooks run async, so links may arrive late, twice or out of order.
			// Creation order sets the boundaries within each session and agent sequence.
			return db.transaction(() => {
				if (agentId !== undefined)
					db.query(
						"UPDATE suggestions SET agent_id = COALESCE(agent_id, ?) WHERE id = ?",
					).run(agentId, id);
				const me = db
					.query<
						{ created_at: number; rowid: number; agent_id: string | null },
						[string]
					>("SELECT created_at, rowid, agent_id FROM suggestions WHERE id = ?")
					.get(id);
				if (!me) return [];
				db.query(
					"UPDATE suggestions SET session_id = ?, prompt_id = ?, last_event_at = MAX(last_event_at, ?) WHERE id = ?",
				).run(sessionId, promptId, at, id);
				const shrunk = db
					.query<
						{ id: string },
						{
							start: number;
							rowid: number;
							session: string;
							agent: string | null;
						}
					>(
						`UPDATE suggestions SET closed_at = $start
						WHERE session_id = $session AND agent_id IS $agent AND (created_at, rowid) < ($start, $rowid)
						AND (closed_at IS NULL OR closed_at > $start) RETURNING id`,
					)
					.all({
						start: me.created_at,
						rowid: me.rowid,
						session: sessionId,
						agent: me.agent_id,
					});
				const next = db
					.query<
						{ created_at: number },
						[string, string | null, number, number]
					>(
						`SELECT created_at FROM suggestions WHERE session_id = ? AND agent_id IS ? AND (created_at, rowid) > (?, ?)
						ORDER BY created_at, rowid LIMIT 1`,
					)
					.get(sessionId, me.agent_id, me.created_at, me.rowid);
				// Hook signals that landed on an earlier window before this link arrived belong here.
				const end = next?.created_at ?? null;
				for (const { id: from } of shrunk)
					db.query(
						`UPDATE OR IGNORE signals SET suggestion_id = $id WHERE suggestion_id = $from AND kind <> 'report'
						AND observed_at >= $start AND ($end IS NULL OR observed_at < $end)`,
					).run({ id, from, start: me.created_at, end });
				if (next)
					shrunk.push(
						...db
							.query<{ id: string }, [number, string]>(
								"UPDATE suggestions SET closed_at = ?1 WHERE id = ?2 AND (closed_at IS NULL OR closed_at > ?1) RETURNING id",
							)
							.all(next.created_at, id),
					);
				return shrunk.map((r) => r.id);
			})();
		},
		sessionWindows(sessionId, from, to, openWindowMs, agentId = null) {
			// A window ends at the earliest of closure (report or next recommendation) and idle expiry.
			return db
				.query<
					{ id: string; start: number; end: number },
					{
						session: string;
						from: number;
						to: number;
						idle: number;
						agent: string | null;
					}
				>(
					`SELECT id, start, "end" FROM (
						SELECT id, rowid, created_at AS start,
							MIN(COALESCE(closed_at, last_event_at + $idle + 1), last_event_at + $idle + 1) AS "end"
						FROM suggestions WHERE session_id = $session AND agent_id IS $agent
					) WHERE start <= $to AND "end" > $from ORDER BY start, rowid`,
				)
				.all({
					session: sessionId,
					from,
					to,
					idle: openWindowMs,
					agent: windowAgent(sessionId, agentId),
				});
		},
		findOpenSuggestion(sessionId, now, openWindowMs, agentId = null) {
			const row = db
				.query<{ id: string }, [string, string | null, number]>(
					`SELECT id FROM suggestions
					WHERE session_id = ? AND agent_id IS ? AND closed_at IS NULL AND last_event_at >= ?
					ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				)
				.get(sessionId, windowAgent(sessionId, agentId), now - openWindowMs);
			return row?.id ?? null;
		},
		suggestionAt(sessionId, at, openWindowMs, agentId = null) {
			return (
				store.sessionWindows(sessionId, at, at, openWindowMs, agentId).at(-1)
					?.id ?? null
			);
		},
		recordFailure(kind, source, at) {
			db.query("INSERT INTO failures VALUES (?, ?, ?)").run(kind, source, at);
		},
		touch(id, at) {
			db.query("UPDATE suggestions SET last_event_at = ? WHERE id = ?").run(
				at,
				id,
			);
		},
		closeSuggestion(id, at) {
			db.query("UPDATE suggestions SET closed_at = ? WHERE id = ?").run(at, id);
		},
		insertSignal(r) {
			db.query(
				`INSERT OR REPLACE INTO signals VALUES ($suggestion_id, $kind, $value, $weight, $source, $observed_at, $turn_id, $agent_id, $model, $effort)`,
			).run({
				...r,
				turn_id: r.turn_id ?? null,
				agent_id: r.agent_id ?? null,
				model: r.model ?? null,
				effort: r.model && noneOnly.has(r.model) ? "none" : (r.effort ?? null),
			});
		},
		upsertUsage(r) {
			db.query(
				`INSERT OR REPLACE INTO usages VALUES ($suggestion_id, $model, $effort, $source, $scope_key,
				$input_tokens, $output_tokens, $cache_read_tokens, $cache_creation_tokens, $is_sidechain,
				$rounds, $note, $reported_at, $turn_id, $agent_id)`,
			).run({
				...r,
				effort: noneOnly.has(r.model) ? "none" : (r.effort ?? null),
				turn_id: r.turn_id ?? null,
				agent_id: r.agent_id ?? null,
				is_sidechain: Number(r.is_sidechain),
			});
		},
		getUsage(suggestionId, source, scopeKey, model) {
			const row = db
				.query<
					Omit<UsageRecord, "is_sidechain"> & { is_sidechain: number },
					[string, string, string, string]
				>(
					"SELECT * FROM usages WHERE suggestion_id = ? AND source = ? AND scope_key = ? AND model = ?",
				)
				.get(suggestionId, source, scopeKey, model);
			// SQLite stores the flag as 0/1; the record type and CLI JSON use a boolean.
			return row ? { ...row, is_sidechain: row.is_sidechain === 1 } : null;
		},
		usageScopes(ids) {
			return db
				.query<Pick<UsageRecord, "source" | "scope_key" | "effort">, string[]>(
					`SELECT source, scope_key, effort FROM (
					SELECT source, scope_key, effort, ROW_NUMBER() OVER (
						PARTITION BY source, scope_key ORDER BY CASE effort ${EFFORTS.map((e, i) => `WHEN '${e}' THEN ${i}`).join(" ")} ELSE -1 END DESC
					) AS rank FROM usages
					WHERE source IN ('transcript', 'subagent') AND suggestion_id IN (${ids.map(() => "?").join()})
					) WHERE rank = 1`,
				)
				.all(...ids);
		},
		rewriteScope(scope, rows) {
			const key = {
				session: scope.session_id,
				source: scope.source,
				scope_key: scope.scope_key,
			};
			return db
				.transaction(() => {
					const mark = db
						.query<{ message_count: number; last_at: number }, typeof key>(
							`SELECT message_count, last_at FROM usage_scopes
							WHERE session_id = $session AND source = $source AND scope_key = $scope_key`,
						)
						.get(key);
					// The last message decides (a compacted transcript has fewer messages); the count breaks ties.
					if (
						mark &&
						(scope.last_at < mark.last_at ||
							(scope.last_at === mark.last_at &&
								scope.message_count < mark.message_count))
					)
						return false;
					const replacement = rows(
						store.sessionWindows(
							scope.session_id,
							scope.from,
							scope.last_at,
							scope.openWindowMs,
							scope.agent_id,
						),
					);
					db.query(
						`DELETE FROM usages WHERE source = $source AND scope_key = $scope_key
						AND suggestion_id IN (SELECT id FROM suggestions WHERE session_id = $session)`,
					).run(key);
					for (const r of replacement) store.upsertUsage(r);
					db.query(
						`INSERT OR REPLACE INTO usage_scopes
						VALUES ($session, $source, $scope_key, $message_count, $last_at)`,
					).run({
						...key,
						message_count: scope.message_count,
						last_at: scope.last_at,
					});
					return true;
				})
				.immediate();
		},
		outcome(id, model) {
			return db
				.query<Outcome, [string, string | null]>(
					`SELECT suggestion_id, quality, model, effort FROM attempts
					WHERE suggestion_id = ?1 AND (?2 IS NULL OR model = ?2) ORDER BY last_at DESC, attempt DESC LIMIT 1`,
				)
				.get(id, model ?? null);
		},
		dispose() {
			db.close();
		},
	};
	return store;
}
