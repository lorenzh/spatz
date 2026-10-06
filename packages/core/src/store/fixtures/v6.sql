-- Frozen v6 fixture, captured before dispatch tracking.
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
, scope TEXT CHECK (scope IN ('step', 'turn', 'subagent', 'session', 'escalate')), agent TEXT CHECK (agent IN ('claude-code', 'claude-code-mod', 'codex')), turn_id TEXT, agent_id TEXT, fallback_reason TEXT, price_snapshot TEXT, price_date INTEGER);
CREATE INDEX suggestions_session ON suggestions (session_id, created_at);
CREATE TABLE signals (
	suggestion_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	value REAL NOT NULL,
	weight REAL NOT NULL,
	source TEXT NOT NULL,
	observed_at INTEGER NOT NULL
, turn_id TEXT, agent_id TEXT);
CREATE INDEX signals_suggestion ON signals (suggestion_id);
CREATE TABLE usage_scopes (
	session_id TEXT NOT NULL,
	source TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	message_count INTEGER NOT NULL,
	last_at INTEGER NOT NULL,
	PRIMARY KEY (session_id, source, scope_key)
);
CREATE UNIQUE INDEX signals_turn ON signals (suggestion_id, source, turn_id, kind) WHERE turn_id IS NOT NULL;
CREATE TABLE failures (
    kind TEXT NOT NULL,
    event TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    session_id TEXT,
    turn_id TEXT,
    UNIQUE (kind, event, session_id, turn_id)
);
CREATE TABLE "usages" (
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
	);
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
INSERT INTO suggestions (rowid, id, created_at, session_id, prompt_id, task_type, difficulty, criticality, probabilities, model_ref, strategy, ranking, reason, explored, control, fallback_used, is_test, last_event_at, closed_at, scope, agent, turn_id, agent_id, fallback_reason, price_snapshot, price_date) VALUES (1, 'r', 1, 'session', 'p1', 'review', 'easy', 'none', NULL, NULL, 'rules', '[{"model":"m/a","effort":"low","estimate":0.5,"n":0}]', 'legacy', 0, 0, 1, 0, 2, 3, 'turn', 'claude-code', 't1', NULL, 'timeout', NULL, NULL);
INSERT INTO suggestions (rowid, id, created_at, session_id, prompt_id, task_type, difficulty, criticality, probabilities, model_ref, strategy, ranking, reason, explored, control, fallback_used, is_test, last_event_at, closed_at, scope, agent, turn_id, agent_id, fallback_reason, price_snapshot, price_date) VALUES (2, 'h', 4, 'session', 'p2', 'code.bugfix', 'medium', 'none', NULL, NULL, 'learned', '[]', 'legacy', 0, 0, 0, 0, 5, NULL, NULL, 'codex', NULL, NULL, NULL, NULL, NULL);
INSERT INTO suggestions (rowid, id, created_at, session_id, prompt_id, task_type, difficulty, criticality, probabilities, model_ref, strategy, ranking, reason, explored, control, fallback_used, is_test, last_event_at, closed_at, scope, agent, turn_id, agent_id, fallback_reason, price_snapshot, price_date) VALUES (3, 'n', 6, NULL, NULL, 'other', 'hard', 'none', NULL, NULL, 'rules', '[]', 'legacy', 0, 0, 1, 1, 6, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO signals (rowid, suggestion_id, kind, value, weight, source, observed_at, turn_id, agent_id) VALUES (1, 'r', 'test', 0, 1, 'PostToolUseFailure', 2, NULL, NULL);
INSERT INTO signals (rowid, suggestion_id, kind, value, weight, source, observed_at, turn_id, agent_id) VALUES (2, 'r', 'report', 1, 1, 'report', 3, NULL, NULL);
INSERT INTO signals (rowid, suggestion_id, kind, value, weight, source, observed_at, turn_id, agent_id) VALUES (3, 'h', 'test', 0, 1, 'PostToolUseFailure', 4, NULL, NULL);
INSERT INTO signals (rowid, suggestion_id, kind, value, weight, source, observed_at, turn_id, agent_id) VALUES (4, 'h', 'test', 1, 1, 'PostToolUse', 5, NULL, NULL);
INSERT INTO signals (rowid, suggestion_id, kind, value, weight, source, observed_at, turn_id, agent_id) VALUES (5, 'h', 'build', 0, 0.8, 'Stop', 5, 'turn', NULL);
INSERT INTO usage_scopes (rowid, session_id, source, scope_key, message_count, last_at) VALUES (1, 'session', 'transcript', 'p1', 1, 2);
INSERT INTO failures (rowid, kind, event, observed_at, session_id, turn_id) VALUES (1, 'parse', 'Stop', 7, 'session', 't1');
INSERT INTO usages (rowid, suggestion_id, model, effort, source, scope_key, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, is_sidechain, rounds, note, reported_at, turn_id, agent_id, tokens_schema, tokens_complete, cost_usd, cost_source) VALUES (1, 'r', 'm/a', 'low', 'report', '', 0, 0, 0, 0, 0, 2, 'note', 3, NULL, NULL, 2, 0, NULL, 'unavailable');
INSERT INTO usages (rowid, suggestion_id, model, effort, source, scope_key, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, is_sidechain, rounds, note, reported_at, turn_id, agent_id, tokens_schema, tokens_complete, cost_usd, cost_source) VALUES (2, 'r', 'm/b', 'high', 'transcript', 'p1', 10, 20, 30, 40, 0, NULL, NULL, 2, NULL, NULL, 2, 0, NULL, 'unavailable');
INSERT INTO usages (rowid, suggestion_id, model, effort, source, scope_key, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, is_sidechain, rounds, note, reported_at, turn_id, agent_id, tokens_schema, tokens_complete, cost_usd, cost_source) VALUES (3, 'h', 'm/a', 'low', 'transcript', 'p2', 1, 5, 0, 0, 0, NULL, NULL, 5, NULL, NULL, 1, 0, NULL, 'unavailable');
INSERT INTO usages (rowid, suggestion_id, model, effort, source, scope_key, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, is_sidechain, rounds, note, reported_at, turn_id, agent_id, tokens_schema, tokens_complete, cost_usd, cost_source) VALUES (4, 'h', 'm/b', NULL, 'subagent', 'a1', 1, 50, 0, 0, 1, NULL, NULL, 5, NULL, NULL, 1, 0, NULL, 'unavailable');
INSERT INTO usages (rowid, suggestion_id, model, effort, source, scope_key, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, is_sidechain, rounds, note, reported_at, turn_id, agent_id, tokens_schema, tokens_complete, cost_usd, cost_source) VALUES (5, 'h', 'm/b', 'medium', 'transcript', 'p3', 1, 1, 0, 0, 0, NULL, NULL, 4, NULL, NULL, 1, 0, NULL, 'unavailable');
INSERT INTO usages (rowid, suggestion_id, model, effort, source, scope_key, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, is_sidechain, rounds, note, reported_at, turn_id, agent_id, tokens_schema, tokens_complete, cost_usd, cost_source) VALUES (6, 'n', 'openai/gpt-6-sol', 'high', 'transcript', 'old-turn', 100, 20, 80, 0, 0, NULL, NULL, 6, NULL, NULL, 1, 0, NULL, 'unavailable');
PRAGMA user_version = 6;

-- Native v6 values must survive the next migration, including nullable counters and prices.
UPDATE suggestions SET price_snapshot = '{"m/b":{"price_prompt":0.001,"price_completion":0.002,"price_cache_read":0.0001,"price_cache_write":0.001}}', price_date = 10 WHERE id = 'r';
UPDATE usages SET cost_usd = 0.093, cost_source = 'priced', tokens_complete = 1 WHERE suggestion_id = 'r' AND model = 'm/b';
UPDATE usages SET cache_creation_tokens = NULL, cost_usd = 0.5, cost_source = 'reported' WHERE suggestion_id = 'n';
