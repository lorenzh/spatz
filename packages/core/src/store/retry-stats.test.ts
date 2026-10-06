import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuggestionRecord } from "../contracts/types.ts";
import { openStore } from "./index.ts";

function suggestion(over: Partial<SuggestionRecord> = {}): SuggestionRecord {
	return {
		id: "first",
		created_at: 1000,
		session_id: null,
		prompt_id: null,
		task_type: "code.bugfix",
		difficulty: "medium",
		criticality: "none",
		probabilities: null,
		model_ref: null,
		strategy: "rules",
		ranking: [],
		reason: "test",
		explored: false,
		control: false,
		fallback_used: true,
		fallback_reason: null,
		is_test: false,
		last_event_at: 1000,
		closed_at: null,
		scope: null,
		agent: null,
		turn_id: null,
		agent_id: null,
		...over,
	};
}

test("retries keep the first-attempt estimate and aggregate separately per pair and cell", () => {
	const store = openStore(":memory:");
	try {
		store.insertSuggestion(suggestion());
		const report = {
			suggestion_id: "first",
			model: "m/a",
			effort: "low" as const,
			at: 2000,
		};
		store.reportAttempt({ ...report, result: "fail" });
		const before = store.cellStats("code.bugfix");
		expect(before).toEqual([
			{
				task_type: "code.bugfix",
				difficulty: "medium",
				model: "m/a",
				effort: "low",
				n: 1,
				sum_quality: 0,
				successes: 0,
			},
		]);
		store.reportAttempt({ ...report, result: "pass" });
		store.insertSuggestion(suggestion({ id: "retry", retry_of: "first" }));
		store.reportAttempt({
			...report,
			suggestion_id: "retry",
			model: "m/b",
			result: "partial",
		});
		store.insertSuggestion(
			suggestion({ id: "hard-retry", difficulty: "hard", retry_of: "retry" }),
		);
		store.reportAttempt({
			...report,
			suggestion_id: "hard-retry",
			result: "pass",
		});
		store.insertSuggestion(
			suggestion({ id: "dry-retry", is_test: true, retry_of: "first" }),
		);
		store.reportAttempt({
			...report,
			suggestion_id: "dry-retry",
			result: "pass",
		});
		expect(store.cellStats("code.bugfix")).toEqual(before);
		const after = store.cellStats("code.bugfix")[0];
		if (!after) throw new Error("missing first-attempt history");
		expect((1 + after.sum_quality) / (2 + after.n)).toBe(1 / 3);
		expect(store.retryStats("code.bugfix")).toEqual(
			expect.arrayContaining([
				{ ...before[0], n: 1, sum_quality: 1, successes: 1 },
				{ ...before[0], model: "m/b", n: 1, sum_quality: 0.5, successes: 0 },
				{
					...before[0],
					difficulty: "hard",
					n: 1,
					sum_quality: 1,
					successes: 1,
				},
			]),
		);
		expect(store.retryStats("code.bugfix")).toHaveLength(3);
		expect(store.retryStats("review")).toEqual([]);
	} finally {
		store.dispose();
	}
});

test("first-attempt learning keeps legacy eval rows and normalizes none-only pairs in both histories", () => {
	const dir = mkdtempSync(join(tmpdir(), "spatz-retry-stats-"));
	const path = join(dir, "spatz.db");
	const store = openStore(path, ["m/none"]);
	try {
		store.insertSuggestion(suggestion({ id: "legacy" }));
		const db = new Database(path);
		try {
			db.run(
				"UPDATE suggestions SET is_legacy=1,difficulty='mittel' WHERE id='legacy'",
			);
			db.run(
				"INSERT INTO signals(suggestion_id,kind,value,weight,source,observed_at) VALUES('legacy','report',1,1,'eval',2000)",
			);
			db.run(
				"INSERT INTO usages(suggestion_id,model,effort,source,scope_key,is_sidechain,reported_at) VALUES('legacy','m/none',NULL,'report','',0,2000)",
			);
		} finally {
			db.close();
		}
		store.insertSuggestion(suggestion());
		const report = {
			suggestion_id: "first",
			model: "m/none",
			effort: "none" as const,
			at: 2000,
		};
		store.reportAttempt({ ...report, result: "fail" });
		store.reportAttempt({ ...report, result: "pass" });
		store.insertSuggestion(suggestion({ id: "unknown" }));
		store.recordAttemptEvents([
			{
				harness: "claude-code",
				session_key: "suggestion:unknown",
				agent_key: "",
				event_id: "unknown",
				revision: 0,
				suggestion_id: "unknown",
				kind: "test",
				value: 1,
				weight: 1,
				source: "PostToolUse",
				occurred_at: 2000,
				received_at: 2000,
			},
		]);
		expect(store.cellStats("code.bugfix")).toEqual([
			{
				task_type: "code.bugfix",
				difficulty: "medium",
				model: "m/none",
				effort: "none",
				n: 2,
				sum_quality: 1,
				successes: 1,
			},
		]);
		expect(store.retryStats("code.bugfix")).toEqual([
			{
				task_type: "code.bugfix",
				difficulty: "medium",
				model: "m/none",
				effort: "none",
				n: 1,
				sum_quality: 1,
				successes: 1,
			},
		]);
	} finally {
		store.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
