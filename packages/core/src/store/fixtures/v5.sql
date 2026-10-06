-- Frozen v5 fixture. Kept independent of production migrations for restore tests.

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



-- One suggestion with a report, one with only hook signals and two models, one without signals.
INSERT INTO suggestions VALUES ('r', 1, 'session', 'p1', 'review', 'easy', 'none', NULL, NULL, 'rules', '[{"model":"m/a","effort":"low","estimate":0.5,"n":0}]', 'legacy', 0, 0, 1, 0, 2, 3, 'turn', 'claude-code', 't1', NULL);
INSERT INTO suggestions VALUES ('h', 4, 'session', 'p2', 'code.bugfix', 'medium', 'none', NULL, NULL, 'learned', '[]', 'legacy', 0, 0, 0, 0, 5, NULL, NULL, NULL, NULL, NULL);
INSERT INTO suggestions VALUES ('n', 6, NULL, NULL, 'other', 'hard', 'none', NULL, NULL, 'rules', '[]', 'legacy', 0, 0, 1, 1, 6, NULL, NULL, NULL, NULL, NULL);
INSERT INTO usages VALUES ('r', 'm/a', 'low', 'report', '', 0, 0, 0, 0, 0, 2, 'note', 3, NULL, NULL);
INSERT INTO usages VALUES ('r', 'm/b', 'high', 'transcript', 'p1', 10, 20, 30, 40, 0, NULL, NULL, 2, NULL, NULL);
INSERT INTO usages VALUES ('h', 'm/a', 'low', 'transcript', 'p2', 1, 5, 0, 0, 0, NULL, NULL, 5, NULL, NULL);
INSERT INTO usages VALUES ('h', 'm/b', NULL, 'subagent', 'a1', 1, 50, 0, 0, 1, NULL, NULL, 5, NULL, NULL);
INSERT INTO usages VALUES ('h', 'm/b', 'medium', 'transcript', 'p3', 1, 1, 0, 0, 0, NULL, NULL, 4, NULL, NULL);
INSERT INTO signals VALUES ('r', 'test', 0, 1, 'PostToolUseFailure', 2, NULL, NULL);
INSERT INTO signals VALUES ('r', 'report', 1, 1, 'report', 3, NULL, NULL);
INSERT INTO signals VALUES ('h', 'test', 0, 1, 'PostToolUseFailure', 4, NULL, NULL);
INSERT INTO signals VALUES ('h', 'test', 1, 1, 'PostToolUse', 5, NULL, NULL);
INSERT INTO signals VALUES ('h', 'build', 0, 0.8, 'Stop', 5, 'turn', NULL);
INSERT INTO usage_scopes VALUES ('session', 'transcript', 'p1', 1, 2);

PRAGMA user_version = 4;

ALTER TABLE suggestions ADD COLUMN fallback_reason TEXT;
CREATE TABLE failures (
    kind TEXT NOT NULL,
    event TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    session_id TEXT,
    turn_id TEXT,
    UNIQUE (kind, event, session_id, turn_id)
);
UPDATE suggestions SET fallback_reason = 'timeout' WHERE id = 'r';
INSERT INTO failures VALUES ('parse', 'Stop', 7, 'session', 't1');
PRAGMA user_version = 5;
