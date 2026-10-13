// Requested subagent effort: per dispatch call, resolved at read time against the answering model.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "../contracts/deps.ts";
import type { Effort, SuggestionRecord } from "../contracts/types.ts";
import { openStore } from "./index.ts";

const OFFERS = {
	"m/worker": ["low", "medium", "high", "xhigh", "max"],
	"m/small": ["none"],
} as const;
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function open() {
	const dir = mkdtempSync(join(tmpdir(), "spatz-dispatch-effort-"));
	dirs.push(dir);
	const path = join(dir, "db");
	return { path, store: openStore(path, [], OFFERS) };
}

function suggestion(over: Partial<SuggestionRecord>): SuggestionRecord {
	return {
		id: "s1",
		created_at: 1000,
		scope: null,
		agent: null,
		turn_id: null,
		agent_id: null,
		session_id: "session",
		prompt_id: null,
		task_type: "code.bugfix",
		difficulty: "medium",
		criticality: "none",
		probabilities: null,
		model_ref: null,
		strategy: "rules",
		ranking: [{ model: "m/ranked", effort: "xhigh", estimate: 0.5, n: 0 }],
		reason: "r",
		explored: false,
		control: false,
		fallback_used: true,
		fallback_reason: null,
		is_test: false,
		last_event_at: 1000,
		closed_at: null,
		...over,
	};
}
const main = { harness: "claude-code", session_key: "session", agent_key: "" };
const worker = { ...main, agent_key: "worker" };
const call = (
	id: string,
	effort: Effort | null,
	recorded_at: number,
	answered_model: string | null = "m/worker",
) => ({
	session_id: "session",
	agent_id: "worker",
	tool_use_id: id,
	requested_model: null,
	answered_model,
	requested_agent_type: null,
	requested_effort: effort,
	recorded_at,
	suggestion_id: null,
});
/** A passing test on the attempt, so it has an outcome; no effort of its own. */
const pass = (store: Store, attempt: string, model = "m/worker") =>
	store.recordAttemptEvents([
		{
			...worker,
			event_id: `pass:${attempt}`,
			revision: 0,
			attempt_id: attempt,
			kind: "test",
			value: 1,
			weight: 1,
			model,
			received_at: 9000,
		},
	]);
const learned = (store: Store) =>
	store
		.cellStats("code.bugfix", 0.8)
		.map((c) => `${c.model}:${c.effort}:${c.n}`)
		.sort();
const attemptOf = (store: Store, id: string) =>
	store.outcome(id)?.attempt_id as string;
const delegate = (callId: string, prompt: string, at: number) => ({
	...main,
	event_id: `delegate:${callId}`,
	revision: 0,
	prompt_id: prompt,
	call_id: callId,
	kind: "delegate" as const,
	occurred_at: at,
	received_at: at,
});

test("review 1, finding 1: a child converted from the parent's attempt drops the parent's effort", () => {
	const { store } = open();
	store.insertSuggestion(suggestion({ prompt_id: "p1" }));
	store.upsertDispatch(call("c1", "low", 1500));
	store.recordAttemptEvents([
		{
			...main,
			event_id: "parent-test",
			revision: 0,
			prompt_id: "p1",
			kind: "test",
			value: 0,
			weight: 1,
			model: "m/orchestrator",
			effort: "max",
			occurred_at: 1050,
			received_at: 1060,
		},
	]);
	expect(store.outcome("s1")).toMatchObject({ effort: "max" });
	store.recordAttemptEvents([delegate("c1", "p1", 1100)]);
	pass(store, attemptOf(store, "s1"));
	expect(learned(store)).toEqual(["m/worker:low:1"]);
	store.dispose();
});

test("review 1, finding 2: the effort counts only when the answering model offers it", () => {
	const { store } = open();
	const cases = [
		["a", "m/worker", "ultra", null],
		["b", "m/worker", "none", null],
		["c", "m/small", "high", "m/small:none:1"],
		["d", "m/mystery", "high", null],
		["e", "m/worker", "medium", "m/worker:medium:1"],
	] as const;
	for (const [agent, model, effort] of cases) {
		store.insertSuggestion(
			suggestion({ id: agent, agent_id: agent, created_at: 1000 }),
		);
		store.upsertDispatch({
			...call(`call-${agent}`, effort, 1500, model),
			agent_id: agent,
		});
		store.recordAttemptEvents([
			{
				...main,
				agent_key: agent,
				event_id: "pass",
				revision: 0,
				attempt_id: attemptOf(store, agent),
				kind: "test",
				value: 1,
				weight: 1,
				model,
				received_at: 9000,
			},
		]);
	}
	// Outcomes without a known effort do not count.
	expect(learned(store)).toEqual(["m/small:none:1", "m/worker:medium:1"]);
	store.dispose();
});

test("review 1, finding 3: a resumed agent's attempts take each call's own effort, in both hook orders", () => {
	const { store } = open();
	// Work first: the attempt exists when its call is recorded.
	store.insertSuggestion(suggestion({ id: "s1", agent_id: "worker" }));
	store.upsertDispatch(call("c1", "low", 1500));
	// Dispatch first: the resumed call is recorded before its suggestion is linked.
	store.insertSuggestion(
		suggestion({ id: "s2", session_id: null, created_at: 2000 }),
	);
	store.upsertDispatch(call("c2", "high", 2500));
	store.linkSession("s2", "session", null, 2000, "worker");
	for (const id of ["s1", "s2"]) pass(store, attemptOf(store, id));
	expect(learned(store)).toEqual(["m/worker:high:1", "m/worker:low:1"]);
	store.dispose();
});

test("a resumed call without its own suggestion never gives its effort to a later suggestion", () => {
	const { store } = open();
	store.insertSuggestion(suggestion({ id: "s1", agent_id: "worker" }));
	store.upsertDispatch(call("c1", "low", 1500));
	store.upsertDispatch(call("c2", "max", 2500));
	store.insertSuggestion(
		suggestion({ id: "s3", agent_id: "worker", created_at: 3000 }),
	);
	store.upsertDispatch(call("c3", "medium", 3500));
	for (const id of ["s1", "s3"]) pass(store, attemptOf(store, id));
	expect(learned(store)).toEqual(["m/worker:low:1", "m/worker:medium:1"]);
	store.dispose();
});

test("review 1, finding 4: explicit evidence replaces the requested effort without a conflict", () => {
	const { store } = open();
	store.insertSuggestion(suggestion({ agent_id: "worker" }));
	// No answered model: the explicit start converts the implicit attempt that holds the call.
	store.upsertDispatch(call("c1", "low", 1500, null));
	const start = {
		...worker,
		suggestion_id: "s1",
		key: "run-1",
		model: "m/worker",
		at: 1100,
	};
	const a = store.startAttempt({ ...start, effort: null });
	pass(store, a.id);
	expect(learned(store)).toEqual(["m/worker:low:1"]);
	expect(() => store.startAttempt({ ...start, effort: "high" })).not.toThrow();
	expect(learned(store)).toEqual(["m/worker:high:1"]);
	expect(() =>
		store.reportAttempt({
			suggestion_id: "s1",
			attempt_id: a.id,
			model: "m/worker",
			effort: "high",
			result: "pass",
			at: 1300,
		}),
	).not.toThrow();
	store.dispose();
});

test("review 2, finding 2: a resumed delegation binds its own call to its own attempt", () => {
	const { store, path } = open();
	store.insertSuggestion(suggestion({ id: "s1", prompt_id: "p1" }));
	store.upsertDispatch(call("c1", "low", 1500));
	store.recordAttemptEvents([delegate("c1", "p1", 1100)]);
	store.insertSuggestion(
		suggestion({ id: "s2", prompt_id: "p2", created_at: 2000 }),
	);
	store.upsertDispatch(call("c2", "high", 2500));
	store.recordAttemptEvents([delegate("c2", "p2", 2100)]);
	const [a1, a2] = [attemptOf(store, "s1"), attemptOf(store, "s2")];
	const db = new Database(path, { readonly: true });
	expect(
		db
			.query(
				"SELECT c.tool_use_id, c.attempt_id, a.agent_key FROM dispatch_calls c JOIN attempts a ON a.id=c.attempt_id ORDER BY 1",
			)
			.all(),
	).toEqual([
		{ tool_use_id: "c1", attempt_id: a1, agent_key: "worker" },
		{ tool_use_id: "c2", attempt_id: a2, agent_key: "worker" },
	]);
	db.close();
	pass(store, a1);
	pass(store, a2);
	expect(learned(store)).toEqual(["m/worker:high:1", "m/worker:low:1"]);
	store.dispose();
});

test("review 2, finding 3: the answering model, not the requested one, validates the effort", () => {
	const { store } = open();
	store.insertSuggestion(suggestion({ agent_id: "worker" }));
	// Requested for m/worker (offers high), no answered model; the transcript shows an unknown model.
	store.upsertDispatch(call("c1", "high", 1500, null));
	pass(store, attemptOf(store, "s1"), "m/mystery");
	expect(learned(store)).toEqual([]);
	store.dispose();
});

test("review 2, finding 4: a PR signal never turns the requested effort into explicit evidence", () => {
	const { store } = open();
	store.insertSuggestion(suggestion({ agent_id: "worker" }));
	store.upsertDispatch(call("c1", "low", 1500, null));
	const start = {
		...worker,
		suggestion_id: "s1",
		key: "run-1",
		model: "m/worker",
		at: 1100,
	};
	const a = store.startAttempt({ ...start, effort: null });
	// What signalPr sends: the attempt's own pair, else the top ranked one.
	store.reportAttempt({
		suggestion_id: "s1",
		attempt_id: a.id,
		model: "m/worker",
		effort: "xhigh",
		result: "pass",
		at: 1200,
		revise: true,
	});
	expect(learned(store)).toEqual(["m/worker:low:1"]);
	expect(() => store.startAttempt({ ...start, effort: "high" })).not.toThrow();
	expect(learned(store)).toEqual(["m/worker:high:1"]);
	store.dispose();
});

test("review 2, finding 5: a start without effort keeps the claimed call's effort", () => {
	const { store } = open();
	store.insertSuggestion(suggestion({ agent_id: "worker" }));
	store.upsertDispatch(call("c1", "low", 1500));
	const a = store.startAttempt({
		...worker,
		suggestion_id: "s1",
		key: "mod-step",
		model: "m/worker",
		effort: null,
		owns_usage: true,
		at: 1100,
	});
	expect(a.id).toBe(attemptOf(store, "s1"));
	pass(store, a.id);
	expect(learned(store)).toEqual(["m/worker:low:1"]);
	store.dispose();
});

test("a call holds one attempt and an attempt one call, whoever claims first", () => {
	const { store, path } = open();
	store.insertSuggestion(suggestion({ id: "s1", agent_id: "worker" }));
	store.insertSuggestion(
		suggestion({ id: "s2", agent_id: "worker", created_at: 1100 }),
	);
	store.upsertDispatch(call("c1", "low", 1500));
	store.upsertDispatch(call("c1", "low", 1500));
	const db = new Database(path, { readonly: true });
	expect(
		db.query("SELECT tool_use_id, attempt_id FROM dispatch_calls").all(),
	).toEqual([{ tool_use_id: "c1", attempt_id: attemptOf(store, "s1") }]);
	db.close();
	for (const id of ["s1", "s2"]) pass(store, attemptOf(store, id));
	// The second attempt has no call, so no effort: it does not count.
	expect(learned(store)).toEqual(["m/worker:low:1"]);
	store.dispose();
});

test("review 2, finding 1: a claim from another connection cannot land between reading and claiming a call", () => {
	const { store: a, path } = open();
	a.insertSuggestion(suggestion({ id: "s1", agent_id: "worker" }));
	a.insertSuggestion(
		suggestion({ id: "s2", agent_id: "worker", created_at: 1100 }),
	);
	// Connection b gives up on a lock at once, so the interleaving cannot wait for a.
	const { run, query } = Database.prototype;
	Database.prototype.run = function (this: Database, sql: string, ...rest) {
		return run.call(
			this,
			sql === "PRAGMA busy_timeout = 5000" ? "PRAGMA busy_timeout = 50" : sql,
			...rest,
		);
	} as typeof run;
	const b = openStore(path, [], OFFERS);
	Database.prototype.run = run;
	let interleaved: unknown = "not reached";
	// a has read the unclaimed calls and now reads the attempts: b claims the same call here.
	Database.prototype.query = function (this: Database, sql: string) {
		if (
			interleaved === "not reached" &&
			/id NOT IN \(SELECT attempt_id FROM dispatch_calls/.test(sql)
		) {
			interleaved = null;
			try {
				b.upsertDispatch(call("c1", "low", 1500));
			} catch (error) {
				interleaved = error;
			}
		}
		return query.call(this, sql);
	} as typeof query;
	try {
		a.upsertDispatch(call("c1", "low", 1500));
	} finally {
		Database.prototype.query = query;
	}
	b.upsertDispatch(call("c1", "low", 1500));
	for (const id of ["s1", "s2"]) pass(a, attemptOf(a, id));
	expect(learned(a)).toEqual(["m/worker:low:1"]);
	// a held its write lock from recording to claiming, so b had to wait.
	expect(String(interleaved)).toMatch(/locked|busy/i);
	b.dispose();
	a.dispose();
});
