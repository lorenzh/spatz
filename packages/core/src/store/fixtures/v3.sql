-- Frozen v3 schema for migration tests.

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


CREATE TABLE usage_scopes (
	session_id TEXT NOT NULL,
	source TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	message_count INTEGER NOT NULL,
	last_at INTEGER NOT NULL,
	PRIMARY KEY (session_id, source, scope_key)
);


ALTER TABLE suggestions ADD COLUMN scope TEXT CHECK (scope IN ('step', 'turn', 'subagent', 'session', 'escalate'));
ALTER TABLE suggestions ADD COLUMN agent TEXT CHECK (agent IN ('claude-code', 'claude-code-mod', 'codex'));
ALTER TABLE suggestions ADD COLUMN turn_id TEXT;
ALTER TABLE suggestions ADD COLUMN agent_id TEXT;
ALTER TABLE usages ADD COLUMN turn_id TEXT;
ALTER TABLE usages ADD COLUMN agent_id TEXT;
ALTER TABLE signals ADD COLUMN turn_id TEXT;
ALTER TABLE signals ADD COLUMN agent_id TEXT;
CREATE UNIQUE INDEX signals_turn ON signals (suggestion_id, source, turn_id, kind) WHERE turn_id IS NOT NULL;

PRAGMA user_version = 3;

