import { expect, test } from "bun:test";
import { modelVersion } from "../catalog/index.ts";
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
