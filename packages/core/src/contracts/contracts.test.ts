import { expect, test } from "bun:test";
import {
	DEFAULT_TUNING,
	DIFFICULTIES,
	SIGNAL_WEIGHTS,
	TASK_FAMILY,
	TASK_TYPES,
} from "../index.ts";

test("contract constants match the spec start values", () => {
	expect(TASK_TYPES).toHaveLength(17);
	expect(DEFAULT_TUNING.familyPooling).toBe(false);
	expect(DIFFICULTIES).toEqual(["easy", "medium", "hard"]);
	expect(SIGNAL_WEIGHTS).toEqual({ report: 1, test: 1, build: 0.8 });
	expect(DEFAULT_TUNING.minN).toBe(5);
	expect(DEFAULT_TUNING.jevTimeoutMs).toBe(1000);
});

test("taxonomy v2 is a superset of v1 and every type has a family", () => {
	for (const t of [
		"code.bugfix",
		"code.feature",
		"code.refactor",
		"code.explain",
		"review",
		"spec",
		"planning",
		"other",
	])
		expect(TASK_TYPES).toContain(t as never);
	expect(Object.keys(TASK_FAMILY).sort()).toEqual([...TASK_TYPES].sort());
	expect(TASK_FAMILY["code.test"]).toBe("code");
	expect(TASK_FAMILY.investigation).toBe("code");
	expect(TASK_FAMILY["design.3d"]).toBe("design");
	expect(TASK_FAMILY.research).toBe("prose");
	expect(TASK_FAMILY.ops).toBe("ops");
});
