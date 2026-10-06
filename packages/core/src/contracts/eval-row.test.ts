import { expect, test } from "bun:test";
import {
	EVAL_ROW_FIELDS,
	EVAL_ROW_SCHEMA,
	EVAL_ROW_TASK_TYPES,
	TASK_TYPES,
} from "../index.ts";

test("spatz-eval-row/1 pins the 16 labelled v2 task types, never other", () => {
	expect(EVAL_ROW_SCHEMA).toBe("spatz-eval-row/1");
	expect([...EVAL_ROW_TASK_TYPES]).toEqual([
		"code.bugfix",
		"code.feature",
		"code.refactor",
		"code.test",
		"code.explain",
		"investigation",
		"review",
		"spec",
		"planning",
		"ops",
		"design.ui",
		"design.visual",
		"design.3d",
		"writing",
		"research",
		"data",
	]);
	expect(
		TASK_TYPES.filter((t) => !EVAL_ROW_TASK_TYPES.includes(t as never)),
	).toEqual(["other"]);
});

test("spatz-eval-row/1 pins its field names", () => {
	expect([...EVAL_ROW_FIELDS]).toEqual([
		"schema",
		"run_id",
		"bench_version",
		"task_id",
		"task_version",
		"task_type",
		"difficulty",
		"criticality",
		"harness",
		"agent_version",
		"model",
		"effort",
		"answered_model",
		"model_version",
		"attempt",
		"result",
		"check",
		"judge",
		"duration_s",
		"tokens",
		"cost_usd",
		"started_at",
		"contributor",
		"verified",
	]);
});
