// Requested subagent effort: per dispatch call, claimed only by the delegation that names the call,
// resolved at read time against the attempt's answering model.
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
const rows = (path: string, sql: string) => {
	const db = new Database(path, { readonly: true });
	try {
		return db.query(sql).all();
	} finally {
		db.close();
	}
};

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
	answered_model: string | null = "m/worker",
	agent = "worker",
) => ({
	session_id: "session",
	agent_id: agent,
	tool_use_id: id,
	requested_model: null,
	answered_model,
	requested_agent_type: null,
	requested_effort: effort,
	suggestion_id: null,
});
/** The delegating transcript's Agent call, in the context that made it. */
const delegate = (callId: string, prompt: string, at: number, by = main) => ({
	...by,
	event_id: `delegate:${callId}`,
	revision: 0,
	prompt_id: prompt,
	call_id: callId,
	kind: "delegate" as const,
	occurred_at: at,
	received_at: at,
});
/** A main suggestion whose turn dispatches `callId`: the routing skill's path. */
function dispatched(
	store: Store,
	id: string,
	at: number,
	c: ReturnType<typeof call>,
) {
	store.insertSuggestion(
		suggestion({ id, prompt_id: `p-${id}`, created_at: at, last_event_at: at }),
	);
	store.upsertDispatch(c);
	store.recordAttemptEvents([delegate(c.tool_use_id, `p-${id}`, at + 100)]);
	return store.outcome(id)?.attempt_id as string;
}
/** A passing test on the attempt, so it has an outcome; no effort of its own. */
const pass = (
	store: Store,
	attempt: string,
	model: string | null = "m/worker",
	agent = "worker",
) =>
	store.recordAttemptEvents([
		{
			...main,
			agent_key: agent,
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

test("review 1, finding 1: a child converted from the parent's attempt drops the parent's effort", () => {
	const { store } = open();
	store.insertSuggestion(suggestion({ prompt_id: "p1" }));
	store.upsertDispatch(call("c1", "low"));
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
		["a", "m/worker", "ultra"],
		["b", "m/worker", "none"],
		["c", "m/small", "high"],
		["d", "m/mystery", "high"],
		["e", "m/worker", "medium"],
	] as const;
	cases.forEach(([agent, model, effort], i) => {
		const child = dispatched(
			store,
			agent,
			1000 * (i + 1),
			call(`call-${agent}`, effort, model, agent),
		);
		pass(store, child, model, agent);
	});
	// Outcomes without a known effort do not count.
	expect(learned(store)).toEqual(["m/small:none:1", "m/worker:medium:1"]);
	store.dispose();
});

test("review 1, finding 3: a resumed agent's attempts take each call's own effort, in both hook orders", () => {
	const { store } = open();
	// Dispatch hook first, then the transcript names the call.
	const a1 = dispatched(store, "s1", 1000, call("c1", "low"));
	// Transcript first: the delegation waits for its call and resolves on replay.
	store.insertSuggestion(
		suggestion({ id: "s2", prompt_id: "p-s2", created_at: 2000 }),
	);
	store.recordAttemptEvents([delegate("c2", "p-s2", 2100)]);
	store.upsertDispatch(call("c2", "high"));
	store.recordAttemptEvents([delegate("c2", "p-s2", 2100)]);
	const a2 = attemptOf(store, "s2");
	expect(a2).not.toBe(a1);
	pass(store, a1);
	pass(store, a2);
	expect(learned(store)).toEqual(["m/worker:high:1", "m/worker:low:1"]);
	store.dispose();
});

test("review 1, finding 4: explicit evidence replaces the requested effort without a conflict", () => {
	const { store } = open();
	const a = dispatched(store, "s1", 1000, call("c1", "low"));
	pass(store, a);
	expect(learned(store)).toEqual(["m/worker:low:1"]);
	const replay = {
		...worker,
		suggestion_id: "s1",
		key: "dispatch:worker:c1",
		model: "m/worker",
		at: 1100,
	};
	expect(() => store.startAttempt({ ...replay, effort: "high" })).not.toThrow();
	expect(learned(store)).toEqual(["m/worker:high:1"]);
	expect(() =>
		store.reportAttempt({
			suggestion_id: "s1",
			attempt_id: a,
			model: "m/worker",
			effort: "high",
			result: "pass",
			at: 1300,
		}),
	).not.toThrow();
	store.dispose();
});

test("review 2, finding 1: a second connection cannot claim a call between its read and its claim", () => {
	const { store: a, path } = open();
	a.insertSuggestion(suggestion({ id: "s1", prompt_id: "p1" }));
	a.upsertDispatch(call("c1", "low"));
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
	// a has read the unclaimed call: another hook process delivers the same delegation here.
	Database.prototype.query = function (this: Database, sql: string) {
		if (interleaved === "not reached" && /FROM dispatch_calls c /.test(sql)) {
			interleaved = null;
			try {
				b.recordAttemptEvents([delegate("c1", "p1", 1100)]);
			} catch (error) {
				interleaved = error;
			}
		}
		return query.call(this, sql);
	} as typeof query;
	try {
		a.recordAttemptEvents([delegate("c1", "p1", 1100)]);
	} finally {
		Database.prototype.query = query;
	}
	b.recordAttemptEvents([delegate("c1", "p1", 1100)]);
	expect(
		rows(path, "SELECT tool_use_id, attempt_id FROM dispatch_calls"),
	).toEqual([{ tool_use_id: "c1", attempt_id: attemptOf(a, "s1") }]);
	pass(a, attemptOf(a, "s1"));
	expect(learned(a)).toEqual(["m/worker:low:1"]);
	expect(String(interleaved)).toMatch(/locked|busy/i);
	b.dispose();
	a.dispose();
});

test("review 2, finding 2: a resumed delegation binds its own call to its own attempt", () => {
	const { store, path } = open();
	const a1 = dispatched(store, "s1", 1000, call("c1", "low"));
	const a2 = dispatched(store, "s2", 2000, call("c2", "high"));
	expect(
		rows(
			path,
			"SELECT c.tool_use_id, c.attempt_id, a.agent_key FROM dispatch_calls c JOIN attempts a ON a.id=c.attempt_id ORDER BY 1",
		),
	).toEqual([
		{ tool_use_id: "c1", attempt_id: a1, agent_key: "worker" },
		{ tool_use_id: "c2", attempt_id: a2, agent_key: "worker" },
	]);
	pass(store, a1);
	pass(store, a2);
	expect(learned(store)).toEqual(["m/worker:high:1", "m/worker:low:1"]);
	store.dispose();
});

test("review 2, finding 3: the answering model, not the requested one, validates the effort", () => {
	const { store } = open();
	// Requested for m/worker (offers high), no answered model; the transcript shows an unknown model.
	const a = dispatched(store, "s1", 1000, call("c1", "high", null));
	pass(store, a, "m/mystery");
	expect(learned(store)).toEqual([]);
	store.dispose();
});

test("review 2, finding 4: a PR signal never turns the requested effort into explicit evidence", () => {
	const { store } = open();
	const a = dispatched(store, "s1", 1000, call("c1", "low"));
	// What signalPr sends: the attempt's own pair, else the top ranked one.
	store.reportAttempt({
		suggestion_id: "s1",
		attempt_id: a,
		model: "m/worker",
		effort: "xhigh",
		result: "pass",
		at: 1200,
		revise: true,
	});
	expect(learned(store)).toEqual(["m/worker:low:1"]);
	const replay = {
		...worker,
		suggestion_id: "s1",
		key: "dispatch:worker:c1",
		model: "m/worker",
		at: 1100,
	};
	expect(() => store.startAttempt({ ...replay, effort: "high" })).not.toThrow();
	expect(learned(store)).toEqual(["m/worker:high:1"]);
	store.dispose();
});

test("review 2, finding 5: a start without effort keeps the claimed call's effort", () => {
	const { store } = open();
	const a = dispatched(store, "s1", 1000, call("c1", "low"));
	const started = store.startAttempt({
		...worker,
		suggestion_id: "s1",
		key: "dispatch:worker:c1",
		model: "m/worker",
		effort: null,
		owns_usage: true,
		at: 1100,
	});
	expect(started.id).toBe(a);
	pass(store, a);
	expect(learned(store)).toEqual(["m/worker:low:1"]);
	store.dispose();
});

test("review 3, finding 1: a PR signal writes no effort onto an attempt that holds a call, even an unresolvable one", () => {
	const { store } = open();
	const a = dispatched(store, "s1", 1000, call("c1", "ultra"));
	store.reportAttempt({
		suggestion_id: "s1",
		attempt_id: a,
		model: "m/worker",
		effort: "xhigh",
		result: "pass",
		at: 1200,
		revise: true,
	});
	expect(store.outcome("s1")).toMatchObject({ effort: null, quality: 1 });
	expect(learned(store)).toEqual([]);
	store.dispose();
});

test("review 3, finding 2: each call's own answering model reaches its attempt", () => {
	const { store } = open();
	dispatched(store, "s1", 1000, call("c1", "high", "m/worker"));
	const a2 = dispatched(store, "s2", 2000, call("c2", "high", "m/small"));
	pass(store, a2, null);
	expect(learned(store)).toEqual(["m/small:none:1"]);
	store.dispose();
});

test("review 3, finding 3: only the delegation that names a call claims it, whatever order the hooks arrive in", () => {
	const { store, path } = open();
	// The worker ran spatz in both calls; the main turns delegated c1, then c2.
	for (const [id, at] of [
		["w1", 1100],
		["w2", 2100],
	] as const)
		store.insertSuggestion(
			suggestion({ id, agent_id: "worker", created_at: at, last_event_at: at }),
		);
	store.insertSuggestion(suggestion({ id: "s1", prompt_id: "p1" }));
	store.insertSuggestion(
		suggestion({ id: "s2", prompt_id: "p2", created_at: 2000 }),
	);
	// c2's hook arrives first.
	store.upsertDispatch(call("c2", "high"));
	store.upsertDispatch(call("c1", "low"));
	expect(
		rows(
			path,
			"SELECT attempt_id FROM dispatch_calls WHERE attempt_id IS NOT NULL",
		),
	).toEqual([]);
	store.recordAttemptEvents([
		delegate("c1", "p1", 1050),
		delegate("c2", "p2", 2050),
	]);
	expect(
		rows(
			path,
			"SELECT c.tool_use_id, a.suggestion_id FROM dispatch_calls c JOIN attempts a ON a.id=c.attempt_id ORDER BY 1",
		),
	).toEqual([
		{ tool_use_id: "c1", suggestion_id: "s1" },
		{ tool_use_id: "c2", suggestion_id: "s2" },
	]);
	store.dispose();
});

test("without a delegation that names it, a call gives no effort", () => {
	const { store } = open();
	store.insertSuggestion(suggestion({ agent_id: "worker" }));
	store.upsertDispatch(call("c1", "low"));
	pass(store, attemptOf(store, "s1"));
	expect(learned(store)).toEqual([]);
	store.dispose();
});

test("review 3, finding 4: a delegation from an attempt that already holds a call creates its own child and keeps the batch", () => {
	const { store, path } = open();
	// The parent subagent's own suggestion; its implicit attempt holds the outer call (as a v14 call can).
	store.insertSuggestion(
		suggestion({ id: "sp", prompt_id: "pp", agent_id: "parent" }),
	);
	const outer = attemptOf(store, "sp");
	store.upsertDispatch(call("outer", "low", "m/worker", "parent"));
	const db = new Database(path);
	db.run("UPDATE dispatch_calls SET attempt_id=? WHERE tool_use_id='outer'", [
		outer,
	]);
	db.close();
	store.upsertDispatch(call("inner", "high", "m/worker", "child"));
	const parent = { ...main, agent_key: "parent" };
	expect(() =>
		store.recordAttemptEvents([delegate("inner", "pp", 1100, parent)]),
	).not.toThrow();
	expect(() => store.reconcileAttempts(parent, 3_600_000)).not.toThrow();
	expect(() =>
		store.recordAttemptEvents([
			{ ...delegate("inner", "pp", 1100, parent), revision: 1 },
		]),
	).not.toThrow();
	expect(
		rows(
			path,
			"SELECT c.tool_use_id, a.agent_key, a.execution_key FROM dispatch_calls c JOIN attempts a ON a.id=c.attempt_id ORDER BY 1",
		),
	).toEqual([
		{
			tool_use_id: "inner",
			agent_key: "child",
			execution_key: "dispatch:child:inner",
		},
		{ tool_use_id: "outer", agent_key: "parent", execution_key: "implicit" },
	]);
	store.dispose();
});

test("a call holds one attempt and an attempt one call", () => {
	const { store, path } = open();
	const a1 = dispatched(store, "s1", 1000, call("c1", "low"));
	store.recordAttemptEvents([{ ...delegate("c1", "p-s1", 1100), revision: 1 }]);
	store.upsertDispatch(call("c2", "high"));
	expect(
		rows(path, "SELECT tool_use_id, attempt_id FROM dispatch_calls ORDER BY 1"),
	).toEqual([
		{ tool_use_id: "c1", attempt_id: a1 },
		{ tool_use_id: "c2", attempt_id: null },
	]);
	const db = new Database(path);
	expect(() =>
		db.run("UPDATE dispatch_calls SET attempt_id=? WHERE tool_use_id='c2'", [
			a1,
		]),
	).toThrow(/UNIQUE/);
	db.close();
	store.dispose();
});
