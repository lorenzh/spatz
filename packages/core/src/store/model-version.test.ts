import { expect, test } from "bun:test";
import { modelVersion } from "../catalog/index.ts";
import { priorCells } from "../catalog/snapshot.ts";
import type { SuggestionRecord } from "../contracts/types.ts";
import { openStore } from "./index.ts";

const suggestion = (id: string, at: number): SuggestionRecord => ({
	id,
	created_at: at,
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
	last_event_at: at,
	closed_at: null,
	scope: null,
	agent: null,
	turn_id: null,
	agent_id: null,
});

test("modelVersion takes the date suffix of dated ids, else null", () => {
	expect(modelVersion("claude-sonnet-4-5-20250929")).toBe("20250929");
	expect(modelVersion("gpt-5-2025-08-07")).toBe("2025-08-07");
	expect(modelVersion("claude-sonnet-5-5")).toBeNull();
});

test("a new known model_version starts an empty prior; null rows match any version", () => {
	const store = openStore(":memory:");
	try {
		const report = (id: string, at: number, version: string | null) => {
			store.insertSuggestion(suggestion(id, at));
			store.reportAttempt({
				suggestion_id: id,
				model: "m/a",
				effort: "low",
				result: "pass",
				at,
				model_version: version,
			});
		};
		report("old", 1000, "20250101");
		report("unknown", 1500, null);
		expect(store.cellStats("code.bugfix")[0]?.n).toBe(2);
		report("new", 2000, "20260101");
		// Old known version drops out; the null row and the new one remain.
		expect(store.cellStats("code.bugfix")[0]?.n).toBe(2);
		report("new2", 3000, "20260101");
		expect(store.cellStats("code.bugfix")[0]?.n).toBe(3);
	} finally {
		store.dispose();
	}
});

test("a test suggestion under an old revision does not change the live version", () => {
	const store = openStore(":memory:");
	try {
		const report = (
			id: string,
			at: number,
			version: string,
			isTest = false,
		) => {
			store.insertSuggestion({ ...suggestion(id, at), is_test: isTest });
			store.reportAttempt({
				suggestion_id: id,
				model: "m/a",
				effort: "low",
				result: "pass",
				at,
				model_version: version,
			});
		};
		report("old", 1000, "20250101");
		report("old2", 1500, "20250101");
		report("new", 2000, "20260101");
		expect(store.cellStats("code.bugfix")[0]?.n).toBe(1);
		report("dry", 3000, "20250101", true);
		expect(store.cellStats("code.bugfix")[0]?.n).toBe(1);
	} finally {
		store.dispose();
	}
});

test("a report under a new revision with the same verdict is not a replay", () => {
	const store = openStore(":memory:");
	try {
		store.insertSuggestion(suggestion("s", 1000));
		const r = (at: number, version: string | null) =>
			store.reportAttempt({
				suggestion_id: "s",
				model: "m/a",
				effort: "low",
				result: "pass",
				at,
				model_version: version,
			});
		const first = r(1000, "20250101");
		expect(r(1100, null).attempt_id).toBe(first.attempt_id);
		expect(r(1200, "20250101").attempt_id).toBe(first.attempt_id);
		expect(r(2000, "20260101").attempt_id).not.toBe(first.attempt_id);
	} finally {
		store.dispose();
	}
});

test("the snapshot prior follows the live version through the store (SPZ-161)", () => {
	const store = openStore(":memory:");
	const cell = (model_version: string | null) => ({
		model: "m/a",
		model_version,
		effort: "low",
		task_type: "code.bugfix",
		difficulty: "medium",
		n: 4,
		pass: 4,
		runs: ["aaaaaaaaaaaa"],
	});
	const snapshot = {
		commit: "3ce2237f116cff82f3ea13ff0a9f3e5e0fa46ce9",
		generated_at: "2026-10-10T00:00:00.000Z",
		cells: [cell("20250101"), cell(null)],
		source: "release" as const,
		fetched_at: 0,
	};
	const matches = () =>
		priorCells(snapshot, store.liveModelVersions(), new Set(), 0).map(
			(p) => p.version_match,
		);
	const report = (id: string, at: number, version: string, isTest = false) => {
		store.insertSuggestion({ ...suggestion(id, at), is_test: isTest });
		store.reportAttempt({
			suggestion_id: id,
			model: "m/a",
			effort: "low",
			result: "pass",
			at,
			model_version: version,
		});
	};
	try {
		// No live version yet: both cells match as unknown.
		expect(matches()).toEqual(["unknown", "unknown"]);
		report("a", 1000, "20250101");
		expect(matches()).toEqual(["exact", "unknown"]);
		report("b", 2000, "20260101");
		// Version A's cell drops out; the null cell still matches.
		expect(matches()).toEqual(["unknown"]);
		report("dry", 3000, "20250101", true);
		expect(matches()).toEqual(["unknown"]);
	} finally {
		store.dispose();
	}
});
