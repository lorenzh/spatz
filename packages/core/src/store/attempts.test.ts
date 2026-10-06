import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuggestionRecord } from "../contracts/types.ts";
import { openStore } from "./index.ts";

function suggestion(over: Partial<SuggestionRecord> = {}): SuggestionRecord {
	return {
		id: "s1",
		created_at: 1000,
		scope: null,
		agent: null,
		turn_id: null,
		agent_id: null,
		session_id: null,
		prompt_id: null,
		task_type: "code.bugfix",
		difficulty: "medium",
		criticality: "none",
		probabilities: null,
		model_ref: null,
		strategy: "rules",
		ranking: [
			{
				model: "anthropic/claude-opus-5.5",
				effort: "high",
				estimate: 0.5,
				n: 0,
			},
		],
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

const context = {
	harness: "claude-code",
	session_key: "session",
	agent_key: "",
};
test("same-pair retries preserve failure, correction and replay preserve the slot", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion());
	const report = {
		suggestion_id: "s1",
		model: "m/a",
		effort: "low" as const,
		at: 2000,
	};
	const first = store.reportAttempt({ ...report, result: "fail" });
	const replay = store.reportAttempt({ ...report, result: "fail" });
	expect(replay.attempt_id).toBe(first.attempt_id);
	const second = store.reportAttempt({ ...report, result: "pass" });
	expect(second.ordinal).toBe(2);
	expect(store.cellStats("code.bugfix")[0]).toMatchObject({
		n: 1,
		sum_quality: 0,
		successes: 0,
	});
	expect(
		store.reportAttempt({ ...report, result: "partial", correct: true })
			.attempt_id,
	).toBe(second.attempt_id);
	expect(store.outcome("s1")?.quality).toBe(0.5);
	store.dispose();
});
test("A to B to A starts three UUIDs; source-ordered test red to green is one outcome", () => {
	const dir = mkdtempSync(join(tmpdir(), "spatz-segments-"));
	const path = join(dir, "db");
	const store = openStore(path);
	const db = new Database(path);
	try {
		store.insertSuggestion(suggestion({ session_id: "session" }));
		const starts = ["m/a", "m/b", "m/a"].map((model, i) =>
			store.startAttempt({
				...context,
				suggestion_id: "s1",
				key: `t:${i}`,
				model,
				effort: "low",
				at: 1100 + i,
			}),
		);
		expect(starts.map((a) => a.ordinal)).toEqual([1, 2, 3]);
		expect(new Set(starts.map((a) => a.id)).size).toBe(3);
		for (const attempt of starts.slice(0, 2))
			store.recordAttemptEvents([
				{
					...context,
					event_id: `fail:${attempt.ordinal}`,
					revision: 0,
					attempt_id: attempt.id,
					kind: "test",
					value: 0,
					weight: 1,
					source_seq: 0,
					received_at: 1200,
				},
			]);
		store.recordAttemptEvents(
			[0, 1].map((value, i) => ({
				...context,
				event_id: `test:${i}`,
				revision: 0,
				attempt_id: starts.at(-1)?.id,
				kind: "test" as const,
				value,
				weight: 1,
				source_seq: i,
				received_at: 1200 + i,
			})),
		);
		expect(store.outcome("s1")).toMatchObject({ quality: 1, ordinal: 3 });
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM attempt_outcomes WHERE suggestion_id='s1'",
				)
				.get(),
		).toEqual({ n: 3 });
		expect(
			db
				.query(
					"SELECT ordinal,model,effort,quality FROM attempt_outcomes WHERE suggestion_id='s1' ORDER BY ordinal",
				)
				.all(),
		).toEqual([
			{ ordinal: 1, model: "m/a", effort: "low", quality: 0 },
			{ ordinal: 2, model: "m/b", effort: "low", quality: 0 },
			{ ordinal: 3, model: "m/a", effort: "low", quality: 1 },
		]);
	} finally {
		db.close();
		store.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("pending and provisional usage and signals reconcile together; known prompt never escapes", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(
		suggestion({ session_id: "session", prompt_id: "p1" }),
	);
	store.insertSuggestion(
		suggestion({
			id: "s2",
			session_id: "session",
			prompt_id: "p2",
			created_at: 2000,
			last_event_at: 2000,
		}),
	);
	store.linkSession("s2", "session", "p2", 2000);
	store.recordAttemptEvents([
		{
			...context,
			event_id: "late",
			revision: 0,
			prompt_id: "p1",
			kind: "test",
			value: 0,
			weight: 1,
			occurred_at: 2100,
			received_at: 3000,
		},
	]);
	expect(store.outcome("s2")?.quality).toBeNull();
	store.recordAttemptEvents([
		{
			...context,
			event_id: "missing",
			revision: 0,
			kind: "test",
			value: 1,
			received_at: 3000,
		},
	]);
	expect(store.outcome("s2")?.quality).toBeNull();
	store.dispose();
});

test("pending repair moves signal and usage atomically and rolls back conflicts", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion({ session_id: "session" }));
	const events = [
		{
			...context,
			event_id: "check",
			revision: 0,
			prompt_id: "late",
			kind: "test" as const,
			value: 0,
			weight: 1,
			received_at: 1500,
		},
		{
			...context,
			event_id: "measure",
			revision: 0,
			prompt_id: "late",
			kind: "usage" as const,
			model: "m/a",
			effort: "low" as const,
			input_tokens: 100,
			output_tokens: 20,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			received_at: 1500,
		},
	];
	store.recordAttemptEvents(events);
	expect(store.outcome("s1")?.quality).toBeNull();
	const attempt = store.outcome("s1")?.attempt_id;
	if (!attempt) throw new Error("missing attempt");
	store.bindAttempt({
		...context,
		attempt_id: attempt,
		id_kind: "prompt",
		external_id: "late",
	});
	expect(store.outcome("s1")).toMatchObject({
		quality: 0,
		input_tokens: 100,
		output_tokens: 20,
	});
	const [check, measure] = events;
	if (!check || !measure) throw new Error("missing repair events");
	expect(() =>
		store.recordAttemptEvents([
			{ ...check, event_id: "other", value: 1 },
			{ ...measure, output_tokens: -1 },
		]),
	).toThrow();
	expect(store.outcome("s1")).toMatchObject({ quality: 0, output_tokens: 20 });
	store.dispose();
});
test("exact identity without time works, revisions replace snapshots, invalid duplicate rejects", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion({ session_id: "session" }));
	const a = store.outcome("s1")?.attempt_id;
	if (!a) throw new Error("missing attempt");
	store.bindAttempt({
		...context,
		attempt_id: a,
		id_kind: "call",
		external_id: "call",
	});
	const e = {
		...context,
		event_id: "tokens",
		call_id: "call",
		kind: "usage" as const,
		model: "m/a",
		effort: "low" as const,
		received_at: 2000,
		input_tokens: 10,
		output_tokens: 10,
		cache_read_tokens: 2,
		cache_creation_tokens: 3,
	};
	store.recordAttemptEvents([
		{ ...e, revision: 2, output_tokens: 20 },
		{ ...e, revision: 1 },
	]);
	expect(store.outcome("s1")).toMatchObject({
		quality: null,
		output_tokens: 20,
	});
	expect(() =>
		store.recordAttemptEvents([{ ...e, revision: 2, output_tokens: 30 }]),
	).toThrow(/conflict/);
	store.dispose();
});
test("report cannot overwrite known execution pair and explicit attempts check ownership", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion());
	const a = store.startAttempt({
		harness: "claude-code",
		session_key: "suggestion:s1",
		agent_key: "",
		suggestion_id: "s1",
		key: "run",
		model: "m/a",
		effort: "low",
		at: 1100,
	});
	expect(() =>
		store.reportAttempt({
			suggestion_id: "s1",
			attempt_id: a.id,
			model: "m/b",
			effort: "high",
			result: "pass",
			at: 1200,
		}),
	).toThrow();
	const b = store.reportAttempt({
		suggestion_id: "s1",
		model: "m/b",
		effort: "high",
		result: "pass",
		at: 1200,
	});
	expect(b.ordinal).toBe(2);
	expect(b.root_id).toBe(a.id);
	store.dispose();
});

test("source delegation retains worker pair and charges orchestration separately", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion({ session_id: "session", prompt_id: "p" }));
	store.upsertDispatch({
		session_id: "session",
		agent_id: "worker",
		tool_use_id: "dispatch",
		requested_model: "m/worker",
		answered_model: "m/worker",
		requested_agent_type: "worker",
		suggestion_id: null,
	});
	store.recordAttemptEvents([
		{
			...context,
			event_id: "delegate",
			revision: 0,
			prompt_id: "p",
			call_id: "dispatch",
			kind: "delegate",
			model: "m/orchestrator",
			effort: "high",
			occurred_at: 1100,
			source_seq: 1,
			received_at: 1200,
		},
	]);
	store.recordAttemptEvents([
		{
			...context,
			agent_key: "worker",
			event_id: "worker-usage",
			revision: 0,
			kind: "usage",
			model: "m/worker",
			input_tokens: 10,
			output_tokens: 20,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			occurred_at: 1200,
			received_at: 1300,
		},
	]);
	store.finalizeAttempts({ ...context, agent_key: "worker" }, 1300);
	store.recordAttemptEvents([
		{
			...context,
			event_id: "verify",
			revision: 0,
			prompt_id: "p",
			kind: "test",
			value: 1,
			weight: 1,
			model: "m/orchestrator",
			effort: "high",
			occurred_at: 1400,
			source_seq: 3,
			received_at: 1500,
		},
		{
			...context,
			event_id: "orchestration",
			revision: 0,
			prompt_id: "p",
			kind: "usage",
			model: "m/orchestrator",
			effort: "high",
			input_tokens: 50,
			output_tokens: 60,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			occurred_at: 1400,
			source_seq: 3,
			received_at: 1500,
		},
	]);
	expect(store.outcome("s1")).toMatchObject({
		ordinal: 1,
		model: "m/worker",
		effort: null,
		quality: 1,
		input_tokens: 10,
		output_tokens: 20,
	});
	store.dispose();
});
test("mod measurements own usage for only their session and agent", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion({ session_id: "session" }));
	const a = store.startAttempt({
		...context,
		suggestion_id: "s1",
		key: "step:0",
		model: "m/a",
		effort: "low",
		at: 1100,
		owns_usage: true,
	});
	const usage = {
		...context,
		revision: 0,
		attempt_id: a.id,
		kind: "usage" as const,
		model: "m/a",
		effort: "low" as const,
		input_tokens: 100,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
		received_at: 1200,
	};
	store.recordAttemptEvents([
		{ ...usage, event_id: "hook", source: "transcript", output_tokens: 3 },
		{
			...usage,
			event_id: "step:0",
			source: "claude-code-mod",
			output_tokens: 156,
		},
	]);
	expect(store.outcome("s1")).toMatchObject({
		input_tokens: 100,
		output_tokens: 156,
	});
	store.dispose();
});
test("finalized same-pair follow-up reuses its attempt and explicit start creates the next one", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion({ session_id: "session" }));
	const event = {
		...context,
		revision: 0,
		kind: "test" as const,
		model: "m/a",
		effort: "low" as const,
		value: 0,
		weight: 1,
		received_at: 1500,
	};
	store.recordAttemptEvents([{ ...event, event_id: "red", occurred_at: 1100 }]);
	store.finalizeAttempts(context, 1200);
	store.recordAttemptEvents([
		{ ...event, event_id: "green", occurred_at: 1300, value: 1 },
	]);
	expect(store.outcome("s1")).toMatchObject({ quality: 1, ordinal: 1 });
	expect(
		store.startAttempt({
			...context,
			suggestion_id: "s1",
			key: "restart",
			model: "m/a",
			effort: "low",
			at: 1400,
		}).ordinal,
	).toBe(2);
	store.dispose();
});

test("an unresolved identity conflict removes provisional signal and usage credit", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion({ session_id: "session" }));
	const a = store.outcome("s1")?.attempt_id;
	if (!a) throw new Error("missing implicit attempt");
	const base = {
		...context,
		revision: 0,
		prompt_id: "late",
		call_id: "conflict",
		occurred_at: 1100,
		received_at: 1200,
	};
	store.recordAttemptEvents([
		{ ...base, event_id: "check-conflict", kind: "test", value: 1, weight: 1 },
		{
			...base,
			event_id: "usage-conflict",
			kind: "usage",
			model: "m/a",
			effort: "low",
			input_tokens: 10,
			output_tokens: 20,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		},
	]);
	expect(store.outcome("s1")?.quality).toBe(1);
	store.insertSuggestion(
		suggestion({
			id: "s2",
			session_id: "session",
			created_at: 2000,
			last_event_at: 2000,
		}),
	);
	const b = store.outcome("s2")?.attempt_id;
	if (!b) throw new Error("missing second attempt");
	store.bindAttempt({
		...context,
		attempt_id: a,
		id_kind: "prompt",
		external_id: "late",
	});
	store.bindAttempt({
		...context,
		attempt_id: b,
		id_kind: "call",
		external_id: "conflict",
	});
	expect(store.outcome("s1")).toMatchObject({
		quality: null,
		input_tokens: null,
		output_tokens: null,
	});
	expect(store.outcome("s2")?.quality).toBeNull();
	store.dispose();
});

test("chain charges 10/20/70 once to root; failed report waits for next unlinked work and review stays separate", () => {
	const dir = mkdtempSync(join(tmpdir(), "spatz-chain-"));
	const path = join(dir, "db");
	const store = openStore(path);
	const db = new Database(path);
	const now = Date.now();
	try {
		for (const [i, cost] of [10, 20, 70].entries()) {
			const id = `s${i}`;
			store.insertSuggestion(
				suggestion({
					id,
					session_id: "session",
					created_at: now + i * 100,
					last_event_at: now + i * 100,
					retry_of: i ? "s0" : undefined,
				}),
			);
			store.linkSession(id, "session", null, now + i * 100);
			const a = store.startAttempt({
				...context,
				suggestion_id: id,
				key: `run:${i}`,
				model: `m/${i}`,
				effort: "low",
				at: now + i * 100 + 1,
			});
			store.recordAttemptEvents([
				{
					...context,
					event_id: `cost:${i}`,
					revision: 0,
					attempt_id: a.id,
					kind: "usage",
					model: `m/${i}`,
					effort: "low",
					input_tokens: cost,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
					cost_usd: cost,
					cost_source: "reported",
					received_at: now + i * 100 + 2,
				},
			]);
			store.reportAttempt({
				suggestion_id: id,
				model: `m/${i}`,
				effort: "low",
				result: i === 2 ? "pass" : "fail",
				at: now + i * 100 + 3,
			});
			if (i === 0)
				expect(db.query("SELECT completed FROM chain_outcomes").get()).toEqual({
					completed: 0,
				});
		}
		expect(
			db
				.query(
					"SELECT model,cost_usd,input_tokens,completed,success FROM chain_outcomes",
				)
				.all(),
		).toEqual([
			{
				model: "m/0",
				cost_usd: 100,
				input_tokens: 100,
				completed: 1,
				success: 1,
			},
		]);
		store.insertSuggestion(
			suggestion({
				id: "review",
				task_type: "review",
				session_id: "session",
				created_at: now + 400,
				last_event_at: now + 400,
			}),
		);
		store.linkSession("review", "session", null, now + 400);
		store.reportAttempt({
			suggestion_id: "review",
			model: "m/review",
			effort: "low",
			result: "fail",
			at: now + 450,
		});
		expect(
			db
				.query(
					"SELECT completed FROM chain_outcomes WHERE suggestion_id='review'",
				)
				.get(),
		).toEqual({ completed: 0 });
		store.insertSuggestion(
			suggestion({
				id: "next",
				session_id: "session",
				created_at: now + 500,
				last_event_at: now + 500,
			}),
		);
		store.linkSession("next", "session", null, now + 500);
		expect(
			db
				.query(
					"SELECT completed,success FROM chain_outcomes WHERE suggestion_id='review'",
				)
				.get(),
		).toEqual({ completed: 1, success: 0 });
		expect(db.query("SELECT COUNT(*) AS n FROM chain_outcomes").get()).toEqual({
			n: 3,
		});
	} finally {
		db.close();
		store.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("idle expiry counts a failed chain and late correction recomputes closure without another charge", () => {
	const dir = mkdtempSync(join(tmpdir(), "spatz-chain-"));
	const path = join(dir, "db");
	const store = openStore(path);
	const db = new Database(path);
	try {
		store.insertSuggestion(suggestion());
		expect(
			db.query("SELECT completed,quality FROM chain_outcomes").get(),
		).toEqual({ completed: 1, quality: 0 });
		const report = {
			suggestion_id: "s1",
			model: "m/a",
			effort: "low" as const,
			at: 2000,
		};
		store.reportAttempt({ ...report, result: "pass" });
		expect(
			db.query("SELECT closed_at,success FROM chain_outcomes").get(),
		).toEqual({ closed_at: 2000, success: 1 });
		store.reportAttempt({ ...report, result: "fail", correct: true, at: 3000 });
		expect(
			db.query("SELECT closed_at,success FROM chain_outcomes").get(),
		).toEqual({ closed_at: null, success: 0 });
		expect(db.query("SELECT COUNT(*) AS n FROM attempts").get()).toEqual({
			n: 1,
		});
	} finally {
		db.close();
		store.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("known turn source order splits A B A without timestamps", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(
		suggestion({ session_id: "session", turn_id: "turn" }),
	);
	for (const [i, model] of ["m/a", "m/b", "m/a"].entries())
		store.recordAttemptEvents([
			{
				...context,
				event_id: `seq:${i}`,
				revision: 0,
				turn_id: "turn",
				source_seq: i,
				kind: "test",
				value: 1,
				weight: 1,
				model,
				effort: "low",
				received_at: 2000 + i,
			},
		]);
	expect(store.outcome("s1")).toMatchObject({
		ordinal: 3,
		model: "m/a",
		quality: 1,
	});
	expect(store.cellStats("code.bugfix").reduce((n, r) => n + r.n, 0)).toBe(1);
	store.dispose();
});

test("source activity extends the idle window without using receipt time", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(
		suggestion({ session_id: "session", prompt_id: "p1" }),
	);
	const minute = 60_000;
	const base = {
		...context,
		revision: 0,
		model: "m/a",
		effort: "low" as const,
		received_at: 1000 + 500 * minute,
	};
	store.recordAttemptEvents([
		{
			...base,
			event_id: "p1-check",
			prompt_id: "p1",
			kind: "test",
			value: 1,
			occurred_at: 1000 + 90 * minute,
		},
	]);
	store.finalizeAttempts(context, 1000 + 90 * minute);
	store.recordAttemptEvents([
		{
			...base,
			event_id: "p2-check",
			prompt_id: "p2",
			kind: "test",
			value: 0,
			occurred_at: 1000 + 150 * minute,
		},
		{
			...base,
			event_id: "p2-usage",
			prompt_id: "p2",
			kind: "usage",
			output_tokens: 20,
			occurred_at: 1000 + 151 * minute,
		},
	]);
	expect(store.outcome("s1")).toMatchObject({
		quality: 0,
		output_tokens: 20,
		ordinal: 1,
	});
	expect(store.getSuggestion("s1")?.last_event_at).toBe(1000 + 151 * minute);
	store.recordAttemptEvents([
		{
			...base,
			event_id: "old",
			prompt_id: "p1",
			kind: "usage",
			occurred_at: 1000 + 80 * minute,
		},
	]);
	expect(store.getSuggestion("s1")?.last_event_at).toBe(1000 + 151 * minute);
	store.dispose();
});

test("hook writes and lifecycle repairs are bounded by context, not ledger size", () => {
	const dir = mkdtempSync(join(tmpdir(), "spatz-work-"));
	const path = join(dir, "db");
	const store = openStore(path);
	const db = new Database(path);
	try {
		store.insertSuggestion(suggestion({ session_id: "session" }));
		for (let i = 0; i < 20; i++)
			store.insertSuggestion(
				suggestion({ id: `other-${i}`, session_id: `other-${i}` }),
			);
		db.run(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<22000)
   INSERT INTO attempt_events(harness,session_key,agent_key,event_id,revision,binding,kind,source,received_at)
   SELECT 'claude-code','unrelated-' || i,'','pending',0,'pending','test','hook',1000 FROM n`);
		db.run(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000)
   INSERT INTO attempt_events(harness,session_key,agent_key,event_id,revision,binding,kind,source,received_at,occurred_at,suggestion_id,attempt_id)
   SELECT 'claude-code','session','','window-' || i,0,'window','usage','hook',1000,1001,'s1',(SELECT id FROM attempts WHERE suggestion_id='s1') FROM n`);
		db.run("CREATE TABLE touched(session_key TEXT)");
		db.run(
			"CREATE TRIGGER watch_events AFTER UPDATE ON attempt_events BEGIN INSERT INTO touched VALUES(new.session_key); END",
		);
		db.run("CREATE TABLE touched_roots(id TEXT)");
		db.run(
			"CREATE TRIGGER watch_roots AFTER UPDATE OF chain_closed_at ON attempts WHEN new.suggestion_id<>'s1' BEGIN INSERT INTO touched_roots VALUES(new.id); END",
		);
		const started = performance.now();
		store.recordAttemptEvents([
			{
				...context,
				event_id: "new",
				revision: 0,
				kind: "test",
				value: 1,
				occurred_at: 1100,
				received_at: 1200,
			},
		]);
		expect(db.query("SELECT COUNT(*) AS n FROM touched").get()).toEqual({
			n: 1,
		});
		expect(performance.now() - started).toBeLessThan(500);
		store.linkSession("s1", "session", "p1", 1000);
		const a = store.startAttempt({
			...context,
			suggestion_id: "s1",
			key: "run",
			model: "m/a",
			effort: "low",
			at: 1100,
		});
		store.bindAttempt({
			...context,
			attempt_id: a.id,
			id_kind: "call",
			external_id: "call",
		});
		expect(
			db
				.query("SELECT COUNT(*) AS n FROM touched WHERE session_key<>'session'")
				.get(),
		).toEqual({ n: 0 });
		expect(db.query("SELECT COUNT(*) AS n FROM touched_roots").get()).toEqual({
			n: 0,
		});
		store.recordAttemptEvents([
			{
				...context,
				event_id: "cleanup",
				revision: 0,
				kind: "test",
				received_at: 7202000,
			},
		]);
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM attempt_events WHERE binding='pending' AND session_key LIKE 'unrelated-%'",
				)
				.get(),
		).toEqual({ n: 22000 - 256 });
	} finally {
		db.close();
		store.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("report events retain rounds, note and source turn across corrections", () => {
	const dir = mkdtempSync(join(tmpdir(), "spatz-report-"));
	const path = join(dir, "db");
	const store = openStore(path);
	const db = new Database(path);
	try {
		store.insertSuggestion(suggestion());
		const input = {
			suggestion_id: "s1",
			model: "m/a",
			effort: "low" as const,
			result: "fail" as const,
			at: 2000,
			rounds: 2,
			note: "second try",
			turn_id: "turn",
		};
		store.reportAttempt(input);
		expect(
			db
				.query(
					"SELECT rounds,note,turn_id FROM latest_attempt_events WHERE kind='report'",
				)
				.get(),
		).toEqual({ rounds: 2, note: "second try", turn_id: "turn" });
		store.reportAttempt({
			...input,
			correct: true,
			result: "pass",
			rounds: 3,
			note: "fixed",
			at: 3000,
		});
		expect(
			db
				.query(
					"SELECT rounds,note,turn_id FROM latest_attempt_events WHERE kind='report'",
				)
				.get(),
		).toEqual({ rounds: 3, note: "fixed", turn_id: "turn" });
		const retry = store.reportAttempt({ ...input, result: "fail", at: 4000 });
		expect(retry).toMatchObject({ ordinal: 2, quality: 0 });
		const retryId = retry.attempt_id;
		if (!retryId) throw new Error("missing retry attempt");
		expect(
			db
				.query(
					"SELECT rounds,note,turn_id FROM latest_attempt_events WHERE attempt_id=? AND kind='report'",
				)
				.get(retryId),
		).toEqual({ rounds: 2, note: "second try", turn_id: "turn" });

		expect(() => store.reportAttempt({ ...input, rounds: -1 })).toThrow();
	} finally {
		db.close();
		store.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("confirm requires an existing attempt and cannot create a retry or change a prior verdict", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion());
	const input = {
		suggestion_id: "s1",
		model: "m/a",
		effort: "low" as const,
		result: "pass" as const,
		at: 2000,
		confirm: true,
	};
	expect(() => store.reportAttempt(input)).toThrow(/--attempt/);
	const attempt_id = store.outcome("s1")?.attempt_id;
	if (!attempt_id) throw new Error("missing attempt");
	expect(store.reportAttempt({ ...input, attempt_id })).toMatchObject({
		attempt_id,
		quality: 1,
		ordinal: 1,
	});
	expect(store.reportAttempt({ ...input, attempt_id })).toMatchObject({
		attempt_id,
		ordinal: 1,
	});
	expect(() =>
		store.reportAttempt({ ...input, attempt_id, result: "fail" }),
	).toThrow(/--correct/);
	expect(() =>
		store.reportAttempt({ ...input, attempt_id, correct: true }),
	).toThrow(/--correct/);
	expect(store.outcome("s1")).toMatchObject({ ordinal: 1, quality: 1 });
	store.dispose();
});

test("a late dispatch repairs its child's pending usage when the delegate event replays", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion({ session_id: "session", prompt_id: "p" }));
	const event = {
		...context,
		event_id: "delegate",
		revision: 0,
		prompt_id: "p",
		call_id: "call",
		kind: "delegate" as const,
		occurred_at: 1100,
		received_at: 1200,
	};
	store.recordAttemptEvents([event]);
	store.recordAttemptEvents([
		{
			...context,
			agent_key: "worker",
			event_id: "usage",
			revision: 0,
			kind: "usage",
			model: "m/worker",
			occurred_at: 1200,
			received_at: 1300,
			output_tokens: 20,
		},
	]);
	store.upsertDispatch({
		session_id: "session",
		agent_id: "worker",
		tool_use_id: "call",
		requested_model: "m/worker",
		answered_model: "m/worker",
		requested_agent_type: "worker",
		suggestion_id: null,
	});
	store.recordAttemptEvents([event]);
	expect(store.outcome("s1")).toMatchObject({
		model: "m/worker",
		output_tokens: 20,
	});
	store.dispose();
});

test("expired pending revisions are pruned with their history without restoring old credit", () => {
	const dir = mkdtempSync(join(tmpdir(), "spatz-expiry-"));
	const path = join(dir, "db");
	const store = openStore(path);
	const db = new Database(path);
	try {
		store.insertSuggestion(suggestion({ session_id: "session" }));
		const input = {
			...context,
			event_id: "revision",
			kind: "test" as const,
			value: 1,
			received_at: 1200,
		};
		store.recordAttemptEvents([{ ...input, revision: 0, occurred_at: 1100 }]);
		expect(store.outcome("s1")?.quality).toBe(1);
		store.recordAttemptEvents([{ ...input, revision: 1 }]);
		expect(store.outcome("s1")?.quality).toBeNull();
		store.recordAttemptEvents([
			{
				...context,
				event_id: "cleanup",
				revision: 0,
				kind: "usage",
				received_at: 7202000,
			},
		]);
		expect(store.outcome("s1")?.quality).toBeNull();
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM attempt_events WHERE event_id='revision'",
				)
				.get(),
		).toEqual({ n: 0 });
	} finally {
		db.close();
		store.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test.each([
	["low", "low"],
	["high", "low"],
	["high", "none"],
] as const)(
	"late mod start adopts hook effort %s with sent effort %s without creating a retry",
	(hookEffort, sentEffort) => {
		const store = openStore(":memory:");
		store.insertSuggestion(suggestion({ session_id: "session" }));
		store.recordAttemptEvents([
			{
				...context,
				event_id: "early-hook",
				revision: 0,
				call_id: "c1",
				kind: "test",
				value: 1,
				weight: 1,
				model: "m/a",
				effort: hookEffort,
				occurred_at: 1500,
				received_at: 1600,
			},
		]);
		const implicit = store.outcome("s1")?.attempt_id;
		if (!implicit) throw new Error("missing implicit attempt");
		const started = store.startAttempt({
			...context,
			suggestion_id: "s1",
			key: "step:0",
			model: "m/a",
			effort: sentEffort,
			at: 1700,
			owns_usage: true,
		});
		expect(started.id).toBe(implicit);
		expect(started.ordinal).toBe(1);
		expect(started.effort).toBe(sentEffort);
		store.bindAttempt({
			...context,
			attempt_id: started.id,
			id_kind: "call",
			external_id: "c1",
		});
		expect(store.outcome("s1")).toMatchObject({
			ordinal: 1,
			quality: 1,
			effort: sentEffort,
		});
		expect(store.cellStats("code.bugfix")).toEqual([
			expect.objectContaining({
				model: "m/a",
				effort: sentEffort,
				n: 1,
				sum_quality: 1,
				successes: 1,
			}),
		]);
		expect(store.retryStats("code.bugfix")).toEqual([]);
		store.dispose();
	},
);
