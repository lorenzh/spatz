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
		n: 2,
		sum_quality: 1,
	});
	expect(
		store.reportAttempt({ ...report, result: "partial", correct: true })
			.attempt_id,
	).toBe(second.attempt_id);
	expect(store.outcome("s1")?.quality).toBe(0.5);
	store.dispose();
});
test("A to B to A starts three UUIDs; source-ordered test red to green is one outcome", () => {
	const store = openStore(":memory:");
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
	store.recordAttemptEvents(
		[0, 1].map((value, i) => ({
			...context,
			event_id: `test:${i}`,
			revision: 0,
			attempt_id: starts[2]!.id,
			kind: "test" as const,
			value,
			weight: 1,
			source_seq: i,
			received_at: 1200 + i,
		})),
	);
	expect(store.outcome("s1")).toMatchObject({ quality: 1, ordinal: 3 });
	store.dispose();
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
	store.bindAttempt({
		...context,
		attempt_id: store.outcome("s1")!.attempt_id!,
		id_kind: "prompt",
		external_id: "late",
	});
	expect(store.outcome("s1")).toMatchObject({
		quality: 0,
		input_tokens: 100,
		output_tokens: 20,
	});
	expect(() =>
		store.recordAttemptEvents([
			{ ...events[0]!, event_id: "other", value: 1 },
			{ ...events[1]!, output_tokens: -1 },
		]),
	).toThrow();
	expect(store.outcome("s1")).toMatchObject({ quality: 0, output_tokens: 20 });
	store.dispose();
});
test("exact identity without time works, revisions replace snapshots, invalid duplicate rejects", () => {
	const store = openStore(":memory:");
	store.insertSuggestion(suggestion({ session_id: "session" }));
	const a = store.outcome("s1")!.attempt_id!;
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
	expect(store.cellStats("code.bugfix").reduce((n, r) => n + r.n, 0)).toBe(3);
	store.dispose();
});
