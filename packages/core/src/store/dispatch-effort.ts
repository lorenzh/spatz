// Subagent effort requested by an Agent dispatch hook. One row per dispatch call, so a resumed
// agent keeps each call's own effort. An attempt takes it as a fallback (effort_source='requested')
// that explicit evidence (a report, a start, a mod step) replaces.
import type { Database } from "bun:sqlite";
import type { Effort } from "../contracts/types.ts";

export function recordDispatchCall(
	db: Database,
	r: {
		session_id: string;
		agent_id: string;
		tool_use_id: string;
		requested_effort: Effort | null;
	},
): void {
	db.query(
		"INSERT OR IGNORE INTO dispatch_calls (session_id,agent_id,tool_use_id,requested_effort) VALUES (?,?,?,?)",
	).run(r.session_id, r.agent_id, r.tool_use_id, r.requested_effort);
}

const give = (db: Database, attempt: string, effort: string | null) =>
	effort &&
	db
		.query(
			"UPDATE attempts SET effort=?,effort_source='requested' WHERE id=? AND effort IS NULL",
		)
		.run(effort, attempt);

/** The delegate event names the call: that call belongs to this child attempt. */
export function claimDispatchCall(
	db: Database,
	session: string,
	toolUseId: string,
	attempt: string,
): void {
	const call = db
		.query<{ requested_effort: Effort | null }, [string, string]>(
			"SELECT requested_effort FROM dispatch_calls WHERE session_id=? AND tool_use_id=? AND attempt_id IS NULL",
		)
		.get(session, toolUseId);
	if (!call) return;
	db.query(
		"UPDATE dispatch_calls SET attempt_id=? WHERE session_id=? AND tool_use_id=?",
	).run(attempt, session, toolUseId);
	give(db, attempt, call.requested_effort);
}

/**
 * Pair the agent's unclaimed calls with its unclaimed attempts in arrival order.
 * ponytail: first-come pairing; an exact call id per attempt would need the harness to carry it.
 */
export function pairDispatchCalls(
	db: Database,
	session: string,
	agent: string,
): void {
	if (!agent) return;
	const calls = db
		.query<
			{ tool_use_id: string; requested_effort: Effort | null },
			[string, string]
		>(
			"SELECT tool_use_id,requested_effort FROM dispatch_calls WHERE session_id=? AND agent_id=? AND attempt_id IS NULL ORDER BY rowid",
		)
		.all(session, agent);
	if (!calls.length) return;
	const attempts = db
		.query<{ id: string }, [string, string]>(
			"SELECT id FROM attempts WHERE session_key=? AND agent_key=? AND id NOT IN (SELECT attempt_id FROM dispatch_calls WHERE attempt_id IS NOT NULL) ORDER BY rowid",
		)
		.all(session, agent);
	for (let i = 0; i < Math.min(calls.length, attempts.length); i++) {
		const [call, attempt] = [calls[i], attempts[i]];
		if (!call || !attempt) continue;
		db.query(
			"UPDATE dispatch_calls SET attempt_id=? WHERE session_id=? AND tool_use_id=?",
		).run(attempt.id, session, call.tool_use_id);
		give(db, attempt.id, call.requested_effort);
	}
}
