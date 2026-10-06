const tokens = [
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_creation_tokens",
];
export const ATTEMPT_SCHEMA = [
	`ALTER TABLE suggestions ADD COLUMN is_legacy INTEGER NOT NULL DEFAULT 0`,
	`UPDATE suggestions SET is_legacy = 1, closed_at = COALESCE(closed_at, unixepoch() * 1000)`,
	`CREATE TABLE attempts (
 id TEXT PRIMARY KEY, suggestion_id TEXT NOT NULL REFERENCES suggestions(id),
 ordinal INTEGER NOT NULL CHECK (ordinal > 0), execution_key TEXT NOT NULL,
 model TEXT, effort TEXT, root_id TEXT NOT NULL REFERENCES attempts(id),
 opened_at INTEGER, closed_at INTEGER, chain_closed_at INTEGER, finalized_at INTEGER,
 harness TEXT NOT NULL, session_key TEXT NOT NULL, agent_key TEXT NOT NULL,
 owns_usage INTEGER NOT NULL DEFAULT 0, success_quality REAL NOT NULL DEFAULT 0.8,
 UNIQUE(suggestion_id,ordinal), UNIQUE(suggestion_id,execution_key))`,
	`ALTER TABLE dispatches ADD COLUMN attempt_id TEXT REFERENCES attempts(id)`,
	`CREATE TABLE attempt_bindings (
 harness TEXT NOT NULL, session_key TEXT NOT NULL, agent_key TEXT NOT NULL,
 id_kind TEXT NOT NULL, external_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(id),
 provisional INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(harness,session_key,agent_key,id_kind,external_id,attempt_id))`,
	`CREATE UNIQUE INDEX attempt_exact_binding ON attempt_bindings(harness,session_key,agent_key,id_kind,external_id)
 WHERE id_kind IN ('call','message','start')`,
	`CREATE TABLE attempt_events (
 harness TEXT NOT NULL, session_key TEXT NOT NULL, agent_key TEXT NOT NULL,
 event_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0),
 suggestion_id TEXT REFERENCES suggestions(id), attempt_id TEXT REFERENCES attempts(id),
 binding TEXT NOT NULL CHECK(binding IN ('bound','window','pending')),
 prompt_id TEXT, turn_id TEXT, call_id TEXT, message_id TEXT, source_seq INTEGER,
 occurred_at INTEGER, received_at INTEGER NOT NULL, model TEXT, effort TEXT,
 kind TEXT NOT NULL, source TEXT NOT NULL, value REAL, weight REAL,
 ${tokens.map((t) => `${t} INTEGER CHECK(${t} >= 0)`).join(",")},
 cost_usd REAL CHECK(cost_usd >= 0), cost_source TEXT NOT NULL DEFAULT 'unavailable',
 tokens_complete INTEGER NOT NULL DEFAULT 0, tokens_schema INTEGER NOT NULL DEFAULT 2,
 suggestion_only INTEGER NOT NULL DEFAULT 0,
 requested_attempt_id TEXT, requested_suggestion_id TEXT,
 PRIMARY KEY(harness,session_key,agent_key,event_id,revision))`,
	`CREATE VIEW latest_attempt_events AS SELECT * FROM (
 SELECT *, ROW_NUMBER() OVER(PARTITION BY harness,session_key,agent_key,event_id ORDER BY revision DESC) AS event_rank
 FROM attempt_events) WHERE event_rank = 1`,
	`CREATE VIEW attempt_usage AS SELECT suggestion_id,attempt_id,model,effort,
 ${tokens.map((t) => `SUM(${t}) AS ${t}`).join(",")},
 CASE WHEN COUNT(cost_usd)=COUNT(*) AND MIN(tokens_schema)=2 THEN SUM(cost_usd) END AS cost_usd,
 CASE WHEN COUNT(cost_usd)<COUNT(*) THEN 'unavailable' WHEN MIN(cost_source)=MAX(cost_source) THEN MIN(cost_source) ELSE 'priced' END AS cost_source,
 MIN(tokens_complete) AS tokens_complete, MIN(tokens_schema) AS tokens_schema
 FROM latest_attempt_events e WHERE kind='usage' AND binding <> 'pending' AND suggestion_id IS NOT NULL
 AND NOT (e.source IN ('transcript','subagent','agent_tool') AND EXISTS(
 SELECT 1 FROM attempts a WHERE a.session_key=e.session_key AND a.agent_key=e.agent_key AND a.owns_usage=1))
 GROUP BY suggestion_id,attempt_id,model,effort`,
	`CREATE VIEW usage_totals AS SELECT suggestion_id,NULL AS attempt_id,model,effort,${tokens.join(",")},cost_usd,cost_source,tokens_complete,tokens_schema FROM usages
 UNION ALL SELECT suggestion_id,attempt_id,model,effort,${tokens.join(",")},cost_usd,cost_source,tokens_complete,tokens_schema FROM attempt_usage`,
	`CREATE VIEW attempt_quality AS WITH ordered AS (
 SELECT *, DENSE_RANK() OVER(PARTITION BY attempt_id,kind ORDER BY COALESCE(source_seq,occurred_at) DESC) AS evidence_rank
 FROM latest_attempt_events WHERE attempt_id IS NOT NULL AND binding<>'pending' AND kind IN ('test','build','report')
 ), latest AS (SELECT attempt_id,kind,CASE WHEN MIN(value)=MAX(value) THEN MAX(value) END AS value,
 CASE kind WHEN 'build' THEN 0.8 ELSE 1.0 END AS weight FROM ordered WHERE evidence_rank=1 GROUP BY attempt_id,kind)
 SELECT attempt_id, COALESCE(MAX(CASE WHEN kind='report' THEN value END),
 SUM(CASE WHEN kind<>'report' THEN value*weight END)/SUM(CASE WHEN kind<>'report' AND value IS NOT NULL THEN weight END)) AS quality
 FROM latest GROUP BY attempt_id`,
	`CREATE VIEW attempt_outcomes AS SELECT a.suggestion_id,q.quality,a.model,a.effort,a.id AS attempt_id,a.ordinal,a.root_id,
 ${tokens.map((t) => `u.${t}`).join(",")}
 FROM attempts a JOIN attempt_quality q ON q.attempt_id=a.id
 LEFT JOIN (SELECT attempt_id,${tokens.map((t) => `SUM(${t}) AS ${t}`).join(",")} FROM attempt_usage GROUP BY attempt_id) u ON u.attempt_id=a.id
 WHERE q.quality IS NOT NULL`,
	`CREATE VIEW chain_outcomes AS WITH verdict AS (
 SELECT a.root_id,MAX(CASE WHEN a.finalized_at IS NOT NULL THEN q.quality END) AS quality,
 MAX(CASE WHEN a.finalized_at IS NOT NULL AND q.quality>=r.success_quality THEN 1 ELSE 0 END) AS success
 FROM attempts a JOIN attempts r ON r.id=a.root_id LEFT JOIN attempt_quality q ON q.attempt_id=a.id GROUP BY a.root_id
 ), members AS (SELECT DISTINCT root_id,suggestion_id FROM attempts), usage AS (
 SELECT m.root_id,${tokens.map((t) => `SUM(u.${t}) AS ${t}`).join(",")},
 CASE WHEN COUNT(u.cost_usd)=COUNT(u.suggestion_id) AND MIN(u.tokens_schema)=2 THEN SUM(u.cost_usd) END AS cost_usd,
 ${tokens.map((t) => `SUM(CASE WHEN u.attempt_id IS NULL THEN u.${t} ELSE 0 END) AS orchestration_${t}`).join(",")},
 SUM(CASE WHEN u.attempt_id IS NULL AND u.tokens_schema=2 THEN u.cost_usd ELSE 0 END) AS orchestration_cost_usd
 FROM members m LEFT JOIN usage_totals u ON u.suggestion_id=m.suggestion_id GROUP BY m.root_id
 ) SELECT r.id AS root_id,r.suggestion_id,r.model,r.effort,COALESCE(v.quality,0) AS quality,v.success,
 CASE WHEN r.chain_closed_at IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM members m JOIN suggestions s ON s.id=m.suggestion_id WHERE m.root_id=r.id AND s.last_event_at+7200000>unixepoch()*1000) THEN 1 ELSE 0 END AS completed,
 r.chain_closed_at AS closed_at,${tokens.map((t) => `u.${t}`).join(",")},u.cost_usd,
 ${tokens.map((t) => `u.orchestration_${t}`).join(",")},u.orchestration_cost_usd
 FROM attempts r JOIN verdict v ON v.root_id=r.id LEFT JOIN usage u ON u.root_id=r.id WHERE r.id=r.root_id`,
];
