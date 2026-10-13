// Subagent effort requested by an Agent dispatch call. One row per call in `dispatch_calls`; a call
// belongs to at most one attempt (attempt_id) and an attempt to at most one call (unique index).
// Only the delegation that names the call (the delegating transcript's Agent tool_use) claims it.
// The requested effort is never written into `attempts`: `attempt_efforts` resolves it at read time.
import type { Database } from "bun:sqlite";
import type { Effort } from "../contracts/types.ts";

export const DISPATCH_CALLS_SCHEMA = [
	"CREATE TABLE dispatch_calls (session_id TEXT NOT NULL, agent_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, requested_effort TEXT, answered_model TEXT, attempt_id TEXT, PRIMARY KEY (session_id, tool_use_id))",
	// Calls recorded before v15 keep their delegate attempt; an attempt shared by two agents stays with the first.
	"INSERT OR IGNORE INTO dispatch_calls (session_id,agent_id,tool_use_id,answered_model,attempt_id) SELECT session_id,agent_id,tool_use_id,answered_model,CASE WHEN rowid=(SELECT MIN(d.rowid) FROM dispatches d WHERE d.attempt_id=dispatches.attempt_id) THEN attempt_id END FROM dispatches WHERE tool_use_id IS NOT NULL",
	"CREATE UNIQUE INDEX dispatch_calls_attempt ON dispatch_calls (attempt_id) WHERE attempt_id IS NOT NULL",
];

/** Attempts some dispatch made: the per-agent first attempt or an attempt that holds a call. */
export const DELEGATE_ATTEMPTS =
	"(SELECT attempt_id FROM dispatches WHERE attempt_id IS NOT NULL UNION SELECT attempt_id FROM dispatch_calls WHERE attempt_id IS NOT NULL)";

/**
 * Per connection: `attempt_efforts(attempt_id, effort)` is the effort learning and stats read.
 * Explicit attempt effort wins. Else the requested effort of the attempt's own call, only when the
 * attempt's answering model offers it in the Claude Code catalog (a none-only model gives `none`).
 * An unknown model gives no effort, so the outcome does not count.
 */
export function attemptEfforts(
	db: Database,
	claudeEfforts: Record<string, readonly Effort[]>,
): void {
	db.run(
		"CREATE TEMP TABLE claude_efforts (model TEXT NOT NULL, effort TEXT NOT NULL)",
	);
	const insert = db.query("INSERT INTO temp.claude_efforts VALUES (?, ?)");
	for (const [model, efforts] of Object.entries(claudeEfforts))
		for (const effort of efforts) insert.run(model, effort);
	db.run(`CREATE TEMP VIEW attempt_efforts AS
		SELECT a.id AS attempt_id, COALESCE(a.effort, (
			SELECT CASE WHEN MAX(o.effort <> 'none') = 0 THEN 'none' WHEN MAX(o.effort = c.requested_effort) = 1 THEN c.requested_effort END
			FROM dispatch_calls c JOIN temp.claude_efforts o ON o.model = a.model
			WHERE c.attempt_id = a.id AND c.session_id = a.session_key AND c.agent_id = a.agent_key
				AND c.requested_effort IS NOT NULL AND a.harness = 'claude-code'
		)) AS effort
		FROM main.attempts a`);
}

/** Record one call with its own requested effort and answering model. */
export function recordDispatchCall(
	db: Database,
	r: {
		session_id: string;
		agent_id: string;
		tool_use_id: string;
		requested_effort: Effort | null;
		answered_model: string | null;
	},
): void {
	db.query(
		"INSERT INTO dispatch_calls (session_id,agent_id,tool_use_id,requested_effort,answered_model) VALUES (?,?,?,?,?) ON CONFLICT (session_id,tool_use_id) DO UPDATE SET answered_model=COALESCE(answered_model,excluded.answered_model)",
	).run(
		r.session_id,
		r.agent_id,
		r.tool_use_id,
		r.requested_effort,
		r.answered_model,
	);
}

/** Claims an unclaimed call for an attempt without a call. False when either is taken. */
export function claimDispatchCall(
	db: Database,
	session: string,
	toolUseId: string,
	attempt: string,
): boolean {
	return (
		db
			.query(
				"UPDATE dispatch_calls SET attempt_id=?3 WHERE session_id=?1 AND tool_use_id=?2 AND attempt_id IS NULL AND NOT EXISTS (SELECT 1 FROM dispatch_calls WHERE attempt_id=?3)",
			)
			.run(session, toolUseId, attempt).changes > 0
	);
}
