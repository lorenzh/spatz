// store: bun:sqlite with schema, migrations (PRAGMA user_version), WAL and busy_timeout.
// Spec: "Storage", outcomes view per "Signals".
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PendingSuggestion, Store } from "../contracts/deps.ts";
import {
	difficultySql,
	normalizeDifficulty,
	normalizeProbabilities,
	normalizeReason,
} from "../contracts/difficulty.ts";
import {
	type CellStat,
	DEFAULT_TUNING,
	type Effort,
	type Outcome,
	type SuggestionRecord,
	type UsageRecord,
} from "../contracts/types.ts";
import { ATTEMPT_SCHEMA, USAGE_COMPLETENESS_SCHEMA } from "./attempt-schema.ts";
import { attemptStore } from "./attempts.ts";

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

const SCHEMA_V5 = [
	"ALTER TABLE suggestions ADD COLUMN fallback_reason TEXT",
	`CREATE TABLE failures (
		kind TEXT NOT NULL,
		event TEXT NOT NULL,
		observed_at INTEGER NOT NULL,
		session_id TEXT,
		turn_id TEXT,
		UNIQUE (kind, event, session_id, turn_id)
	)`,
];

const SCHEMA_V6 = [
	"ALTER TABLE suggestions ADD COLUMN price_snapshot TEXT",
	"ALTER TABLE suggestions ADD COLUMN price_date INTEGER",
	`CREATE TABLE usages_v6 (
		suggestion_id TEXT NOT NULL, model TEXT NOT NULL, effort TEXT,
		source TEXT NOT NULL, scope_key TEXT NOT NULL,
		input_tokens INTEGER CHECK (input_tokens >= 0),
		output_tokens INTEGER CHECK (output_tokens >= 0),
		cache_read_tokens INTEGER CHECK (cache_read_tokens >= 0),
		cache_creation_tokens INTEGER CHECK (cache_creation_tokens >= 0),
		is_sidechain INTEGER NOT NULL, rounds INTEGER, note TEXT, reported_at INTEGER NOT NULL,
		turn_id TEXT, agent_id TEXT,
		tokens_schema INTEGER NOT NULL DEFAULT 2 CHECK (tokens_schema IN (1, 2)),
		tokens_complete INTEGER NOT NULL DEFAULT 0 CHECK (tokens_complete IN (0, 1)),
		cost_usd REAL CHECK (cost_usd >= 0),
		cost_source TEXT NOT NULL DEFAULT 'unavailable' CHECK (cost_source IN ('reported', 'priced', 'unavailable')),
		UNIQUE (suggestion_id, source, scope_key, model)
	)`,
	// Keep rowids: outcomes use them to break ties. Old clients erased missing counters, so completeness is unknown.
	`INSERT INTO usages_v6 (rowid, suggestion_id, model, effort, source, scope_key,
		input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, is_sidechain,
		rounds, note, reported_at, turn_id, agent_id, tokens_schema)
	 SELECT rowid, *, CASE WHEN suggestion_id IN (SELECT id FROM suggestions WHERE agent = 'codex')
		OR (source = 'transcript' AND model LIKE 'openai/%') THEN 1 ELSE 2 END FROM usages`,
	"DROP VIEW outcomes",
	"DROP TABLE usages",
	"ALTER TABLE usages_v6 RENAME TO usages",
	SCHEMA_V1.slice(SCHEMA_V1.indexOf("CREATE VIEW outcomes")),
];

const SCHEMA_V7 = [
	"ALTER TABLE suggestions ADD COLUMN requested_model TEXT",
	`CREATE TABLE dispatches (
		session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
		tool_use_id TEXT, requested_model TEXT, requested_agent_type TEXT,
		answered_model TEXT, suggestion_id TEXT,
		PRIMARY KEY (session_id, agent_id)
	)`,
];

const SCHEMA_V8 = [
	...ATTEMPT_SCHEMA,
	SCHEMA_V1.slice(SCHEMA_V1.indexOf("CREATE VIEW outcomes")).replace(
		"CREATE VIEW outcomes",
		"CREATE VIEW legacy_outcomes",
	),
	"DROP VIEW outcomes",
	`CREATE VIEW outcomes AS SELECT suggestion_id,quality,model,effort FROM legacy_outcomes UNION ALL SELECT suggestion_id,quality,model,effort FROM attempt_outcomes`,
];

// v10: outcomes keyed by model version (dated revision); null when the harness did not expose one.
const SCHEMA_V10 = [
	"ALTER TABLE attempts ADD COLUMN model_version TEXT",
	"ALTER TABLE attempt_events ADD COLUMN model_version TEXT",
	"DROP VIEW outcomes",
	"DROP VIEW attempt_outcomes",
	(
		ATTEMPT_SCHEMA.find((sql) =>
			sql.startsWith("CREATE VIEW attempt_outcomes"),
		) as string
	).replace("a.model,a.effort,", "a.model,a.effort,a.model_version,"),
	`CREATE VIEW outcomes AS SELECT suggestion_id,quality,model,effort FROM legacy_outcomes UNION ALL SELECT suggestion_id,quality,model,effort FROM attempt_outcomes`,
];

// v11: suggestions whose agent ended without any evidence. Stored, never counted as success or failure.
const SCHEMA_V11 = [
	"CREATE TABLE unknown_outcomes (suggestion_id TEXT PRIMARY KEY REFERENCES suggestions(id), marked_at INTEGER NOT NULL)",
];

const MIGRATIONS = [
	SCHEMA_V1,
	SCHEMA_V2,
	SCHEMA_V3,
	SCHEMA_V4,
	SCHEMA_V5,
	SCHEMA_V6,
	SCHEMA_V7,
	SCHEMA_V8,
	USAGE_COMPLETENESS_SCHEMA,
	SCHEMA_V10,
	SCHEMA_V11,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

/** The caller holds IMMEDIATE, before any writes, so this reader sees all committed WAL data. */
function backupDatabase(dbPath: string, version: number): void {
	const backup = `${dbPath}.bak-v${version}`;
	const temporary = `${backup}.${crypto.randomUUID()}.tmp`;
	const reader = new Database(dbPath, { readonly: true });
	try {
		reader.run("VACUUM INTO ?", [temporary]);
		renameSync(temporary, backup);
	} finally {
		reader.close();
		rmSync(temporary, { force: true });
	}
	const prefix = `${basename(dbPath)}.bak-v`;
	const backups = readdirSync(dirname(dbPath))
		.filter(
			(name) =>
				name !== basename(backup) &&
				name.startsWith(prefix) &&
				/^\d+$/.test(name.slice(prefix.length)),
		)
		.sort(
			(a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)),
		);
	for (const name of backups.slice(2)) rmSync(join(dirname(dbPath), name));
}

/** Opens the db with WAL and busy_timeout 5000 and migrates to SCHEMA_VERSION. */
export function openDatabase(dbPath: string): Database {
	if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true, strict: true });
	const version = () => {
		const v =
			db.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version ?? 0;
		if (v > SCHEMA_VERSION)
			throw new Error(
				`Database schema v${v} is newer than supported v${SCHEMA_VERSION}. Upgrade the spatz CLI.`,
			);
		return v;
	};
	try {
		db.run("PRAGMA busy_timeout = 5000");
		db.run("PRAGMA foreign_keys = ON");
		version();
		db.run("PRAGMA journal_mode = WAL");
		if (version() === SCHEMA_VERSION) return db;
		// IMMEDIATE + re-check: no other writer can run between backup and migration.
		db.transaction(() => {
			const from = version();
			if (from === SCHEMA_VERSION) return;
			if (
				dbPath !== ":memory:" &&
				db.query("SELECT 1 FROM sqlite_master LIMIT 1").get()
			)
				backupDatabase(dbPath, from);
			for (let v = from; v < SCHEMA_VERSION; v++) {
				for (const sql of [MIGRATIONS[v] ?? []].flat()) db.run(sql);
				db.run(`PRAGMA user_version = ${v + 1}`);
			}
		}).immediate();
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

type SuggestionRow = Omit<
	SuggestionRecord,
	| "price_snapshot"
	| "probabilities"
	| "ranking"
	| "explored"
	| "control"
	| "fallback_used"
	| "is_test"
> & {
	price_snapshot: string | null;
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
	const historyStats = (
		taskType: CellStat["task_type"],
		retries: boolean,
		successQuality: number,
	) =>
		db
			.query<CellStat, (string | number)[]>(
				`WITH history AS (
					SELECT suggestion_id,quality,model,effort,model_version FROM attempt_outcomes
					WHERE ${retries ? "ordinal>1 OR attempt_id<>root_id" : "ordinal=1 AND attempt_id=root_id"}
					${retries ? "" : "UNION ALL SELECT suggestion_id,quality,model,effort,NULL FROM legacy_outcomes"}
				), live AS (
					-- The newest known version per model; older known versions seed nothing, null matches any.
					SELECT model, model_version FROM (
						SELECT a.model, a.model_version, ROW_NUMBER() OVER (PARTITION BY a.model ORDER BY COALESCE(a.opened_at,0) DESC, a.rowid DESC) AS rn
						FROM attempts a JOIN suggestions s ON s.id = a.suggestion_id
						WHERE a.model_version IS NOT NULL AND s.is_test = 0
					) WHERE rn = 1
				), normalized AS (
					SELECT h.*, CASE WHEN h.model IN (${noneOnlyModels.map(() => "?").join()}) THEN 'none' ELSE h.effort END AS known_effort
					FROM history h LEFT JOIN live l ON l.model = h.model
					WHERE h.model_version IS NULL OR l.model_version IS NULL OR h.model_version = l.model_version
				)
				SELECT s.task_type, ${difficultySql("s.difficulty")} AS difficulty, o.model, o.known_effort AS effort, COUNT(*) AS n, SUM(o.quality) AS sum_quality, SUM(o.quality >= ?) AS successes
				FROM suggestions s JOIN normalized o ON o.suggestion_id = s.id
				WHERE s.task_type = ? AND s.is_test = 0 AND o.quality IS NOT NULL AND o.model IS NOT NULL AND o.known_effort IS NOT NULL
				GROUP BY s.task_type, ${difficultySql("s.difficulty")}, o.model, o.known_effort`,
			)
			.all(...noneOnlyModels, successQuality, taskType);
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
	const ledger = attemptStore(db, () => store, noneOnly);
	const store: Store = {
		...ledger,
		upsertDispatch(r) {
			db.query(`INSERT INTO dispatches (session_id,agent_id,tool_use_id,requested_model,requested_agent_type,answered_model,suggestion_id) VALUES ($session_id, $agent_id, $tool_use_id,
				$requested_model, $requested_agent_type, $answered_model, $suggestion_id)
				ON CONFLICT (session_id, agent_id) DO UPDATE SET
				tool_use_id = COALESCE(dispatches.tool_use_id, excluded.tool_use_id),
				requested_model = COALESCE(dispatches.requested_model, excluded.requested_model),
				requested_agent_type = COALESCE(dispatches.requested_agent_type, excluded.requested_agent_type),
				answered_model = COALESCE(dispatches.answered_model, excluded.answered_model),
				suggestion_id = COALESCE(dispatches.suggestion_id, excluded.suggestion_id)`).run(
				{ ...r, attempt_id: r.attempt_id ?? null },
			);
			db.query(
				`UPDATE dispatches SET attempt_id=COALESCE(attempt_id,(SELECT id FROM attempts WHERE session_key=? AND agent_key=? ORDER BY ordinal LIMIT 1)) WHERE session_id=? AND agent_id=?`,
			).run(r.session_id, r.agent_id, r.session_id, r.agent_id);
			if (r.answered_model)
				db.query(
					"UPDATE attempts SET model=COALESCE(model,?) WHERE session_key=? AND agent_key=?",
				).run(r.answered_model, r.session_id, r.agent_id);
		},
		recordFailure(kind, event, at, sessionId, turnId) {
			db.query("INSERT OR IGNORE INTO failures VALUES (?, ?, ?, ?, ?)").run(
				kind,
				event,
				at,
				sessionId,
				turnId,
			);
		},
		insertSuggestion(r) {
			db.transaction(() => {
				db.query(
					`INSERT INTO suggestions VALUES ($id, $created_at, $session_id, $prompt_id, $task_type, $difficulty,
				$criticality, $probabilities, $model_ref, $strategy, $ranking, $reason, $explored, $control,
				$fallback_used, $is_test, $last_event_at, $closed_at, $scope, $agent, $turn_id, $agent_id, $fallback_reason, $price_snapshot, $price_date, $requested_model, 0)`,
				).run({
					...r,
					price_snapshot: r.price_snapshot
						? JSON.stringify(r.price_snapshot)
						: null,
					price_date: r.price_date ?? null,
					requested_model: r.requested_model ?? null,
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
				});
				ledger.initialize(r.id, r.retry_of);
			}).immediate();
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
				price_snapshot: row.price_snapshot
					? JSON.parse(row.price_snapshot)
					: {},
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
		cellStats(taskType, successQuality = DEFAULT_TUNING.successQuality) {
			return historyStats(taskType, false, successQuality);
		},
		liveModelVersions() {
			return Object.fromEntries(
				db
					.query<{ model: string; model_version: string }, []>(
						`SELECT model, model_version FROM (
							SELECT a.model, a.model_version, ROW_NUMBER() OVER (PARTITION BY a.model ORDER BY COALESCE(a.opened_at,0) DESC, a.rowid DESC) AS rn
							FROM attempts a JOIN suggestions s ON s.id = a.suggestion_id
							WHERE a.model_version IS NOT NULL AND s.is_test = 0
						) WHERE rn = 1`,
					)
					.all()
					.map((r) => [r.model, r.model_version]),
			);
		},
		retryStats(taskType, successQuality = DEFAULT_TUNING.successQuality) {
			return historyStats(taskType, true, successQuality);
		},
		linkSession(id, sessionId, promptId, at, agentId, harness) {
			if (store.getSuggestion(id)?.is_legacy) {
				console.error("spatz: dropped late legacy link");
				return [];
			}
			// Hooks run async, so links may arrive late, twice or out of order.
			// Creation order sets the boundaries within each session and agent sequence.
			// Immediate: a deferred read-then-write fails with SQLITE_BUSY_SNAPSHOT under concurrent hooks.
			const link = db.transaction(() => {
				if (harness)
					db.query(
						"UPDATE suggestions SET agent=COALESCE(agent,?) WHERE id=?",
					).run(harness, id);
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
				if (next)
					shrunk.push(
						...db
							.query<{ id: string }, [number, string]>(
								"UPDATE suggestions SET closed_at = ?1 WHERE id = ?2 AND (closed_at IS NULL OR closed_at > ?1) RETURNING id",
							)
							.all(next.created_at, id),
					);
				const suggestion = store.getSuggestion(id);
				if (suggestion?.agent === "claude-code-mod" && suggestion.agent_id) {
					store.upsertDispatch({
						session_id: sessionId,
						agent_id: suggestion.agent_id,
						requested_model: suggestion.requested_model ?? null,
						requested_agent_type: null,
						answered_model: null,
						tool_use_id: null,
						suggestion_id: id,
					});
				}
				if (!store.getSuggestion(id)?.is_legacy) ledger.link(id);
				return shrunk.map((r) => r.id);
			});
			return link.immediate();
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
		closeUnknown(by, at) {
			const params: Record<string, string | number | null> =
				"id" in by ? { id: by.id } : { session: by.session, agent: by.agentId };
			return db
				.query<{ id: string }, Record<string, string | number | null>>(
					`INSERT OR IGNORE INTO unknown_outcomes (suggestion_id, marked_at)
					SELECT s.id, $at FROM suggestions s WHERE s.is_legacy = 0 AND ${
						"id" in by
							? "s.id = $id"
							: "s.session_id = $session AND s.agent_id IS $agent"
					} AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.suggestion_id = s.id)
					RETURNING suggestion_id AS id`,
				)
				.all({ ...params, at })
				.map((r) => r.id);
		},
		pending(olderThanMs, now) {
			return db
				.query<PendingSuggestion, { cutoff: number }>(
					`SELECT id, created_at, session_id, agent_id, task_type, COALESCE(agent, 'cli') AS source
					FROM suggestions s WHERE is_test = 0 AND is_legacy = 0 AND created_at <= $cutoff
					AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.suggestion_id = s.id)
					AND NOT EXISTS (SELECT 1 FROM unknown_outcomes u WHERE u.suggestion_id = s.id)
					ORDER BY created_at, rowid`,
				)
				.all({ cutoff: now - olderThanMs });
		},
		pairOf(id) {
			const attempt = db
				.query<{ model: string | null; effort: Effort | null }, [string]>(
					"SELECT model, effort FROM attempts WHERE suggestion_id = ? AND model IS NOT NULL AND effort IS NOT NULL ORDER BY ordinal LIMIT 1",
				)
				.get(id);
			if (attempt?.model && attempt.effort)
				return { model: attempt.model, effort: attempt.effort };
			const top = store.getSuggestion(id)?.ranking[0];
			return top ? { model: top.model, effort: top.effort } : null;
		},
		closeSuggestion(id, at) {
			db.query("UPDATE suggestions SET closed_at = ? WHERE id = ?").run(at, id);
		},
		upsertUsage(r) {
			return db
				.transaction(() => {
					const suggestion = store.getSuggestion(r.suggestion_id);
					const session = suggestion?.session_id;
					const agent = r.agent_id ?? suggestion?.agent_id;
					if (!suggestion || suggestion.is_legacy) {
						console.error("spatz: dropped late legacy usage");
						return;
					}
					if (r.source === "claude-code-mod" && session && agent) {
						db.query(
							"DELETE FROM attempt_events WHERE session_key=? AND agent_key=? AND source IN ('subagent','agent_tool')",
						).run(session, agent);
						store.upsertDispatch({
							session_id: session,
							agent_id: agent,
							requested_model: suggestion?.requested_model ?? null,
							requested_agent_type: null,
							answered_model: r.model,
							tool_use_id: null,
							suggestion_id: r.suggestion_id,
						});
					}
					if (
						(r.source === "subagent" || r.source === "agent_tool") &&
						db
							.query(
								"SELECT 1 FROM latest_attempt_events WHERE session_key=? AND agent_key=? AND source='claude-code-mod' LIMIT 1",
							)
							.get(session ?? `suggestion:${r.suggestion_id}`, agent ?? "")
					)
						return;
					const current = store.outcome(r.suggestion_id);
					if (!current?.attempt_id) throw new Error("missing usage attempt");
					const context = {
						harness: suggestion.agent === "codex" ? "codex" : "claude-code",
						session_key:
							suggestion.session_id ?? `suggestion:${r.suggestion_id}`,
						agent_key: suggestion.agent_id ?? "",
					};
					let attempt = current.attempt_id;
					const effort = noneOnly.has(r.model) ? "none" : r.effort;
					if (
						current.model &&
						(current.model !== r.model ||
							(current.effort && effort && current.effort !== effort))
					)
						attempt = ledger.startAttempt({
							...context,
							suggestion_id: r.suggestion_id,
							key: `usage:${r.source}:${r.scope_key}:${r.model}:${effort}`,
							model: r.model,
							effort,
							at: r.reported_at,
						}).id;
					const eventId = `usage:${r.source}:${r.scope_key}:${r.model}`;
					const previous = db
						.query<{ revision: number }, [string, string, string, string]>(
							"SELECT MAX(revision) AS revision FROM attempt_events WHERE harness=? AND session_key=? AND agent_key=? AND event_id=?",
						)
						.get(
							context.harness,
							context.session_key,
							context.agent_key,
							eventId,
						);
					ledger.recordAttemptEvents([
						{
							...context,
							event_id: eventId,
							revision: (previous?.revision ?? -1) + 1,
							attempt_id: attempt,
							suggestion_id: r.suggestion_id,
							kind: "usage",
							turn_id: r.turn_id ?? null,
							source: r.source,
							model: r.model,
							effort,
							occurred_at: r.reported_at,
							received_at: r.reported_at,
							input_tokens: r.input_tokens,
							output_tokens: r.output_tokens,
							cache_read_tokens: r.cache_read_tokens,
							cache_creation_tokens: r.cache_creation_tokens,
							cost_usd: r.cost_usd,
							cost_source: r.cost_source,
							tokens_complete: r.tokens_complete,
							tokens_schema: r.tokens_schema,
						},
					]);
				})
				.immediate();
		},
		getUsage(suggestionId, source, scopeKey, model) {
			if (!store.getSuggestion(suggestionId)?.is_legacy) {
				const e = db
					.query<UsageRecord, [string, string]>(
						`SELECT suggestion_id,model,effort,source,${["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd", "cost_source", "tokens_complete", "tokens_schema", "turn_id"].join(",")},agent_key AS agent_id,occurred_at AS reported_at FROM latest_attempt_events WHERE suggestion_id=? AND event_id=?`,
					)
					.get(suggestionId, `usage:${source}:${scopeKey}:${model}`);
				return e
					? {
							...e,
							scope_key: scopeKey,
							is_sidechain: source === "subagent" || !!e.agent_id,
							rounds: null,
							note: null,
						}
					: null;
			}
			const row = db
				.query<
					Omit<UsageRecord, "is_sidechain"> & { is_sidechain: number },
					[string, string, string, string]
				>(
					"SELECT * FROM usages WHERE suggestion_id=? AND source=? AND scope_key=? AND model=?",
				)
				.get(suggestionId, source, scopeKey, model);
			return row ? { ...row, is_sidechain: row.is_sidechain === 1 } : null;
		},
		outcome(id) {
			if (store.getSuggestion(id)?.is_legacy)
				return db
					.query<Outcome, [string]>(
						`SELECT *,NULL AS attempt_id,NULL AS ordinal,NULL AS root_id,NULL AS input_tokens,NULL AS output_tokens,NULL AS cache_read_tokens,NULL AS cache_creation_tokens FROM legacy_outcomes WHERE suggestion_id=?`,
					)
					.get(id);
			return db
				.query<Outcome, [string]>(
					`SELECT a.suggestion_id,q.quality,a.model,a.effort,a.id AS attempt_id,a.ordinal,a.root_id,u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_creation_tokens FROM attempts a LEFT JOIN attempt_quality q ON q.attempt_id=a.id LEFT JOIN (SELECT attempt_id,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(cache_read_tokens) AS cache_read_tokens,SUM(cache_creation_tokens) AS cache_creation_tokens FROM attempt_usage GROUP BY attempt_id) u ON u.attempt_id=a.id WHERE a.suggestion_id=? ORDER BY a.ordinal DESC LIMIT 1`,
				)
				.get(id);
		},
		dispose() {
			db.close();
		},
	};
	return store;
}
