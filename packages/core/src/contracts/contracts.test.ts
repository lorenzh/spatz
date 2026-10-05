import { expect, test } from "bun:test";
import {
	DEFAULT_TUNING,
	DIFFICULTIES,
	SIGNAL_WEIGHTS,
	TASK_TYPES,
} from "../index.ts";

test("contract constants match the spec start values", () => {
	expect(TASK_TYPES).toHaveLength(8);
	expect(DIFFICULTIES).toEqual(["easy", "medium", "hard"]);
	expect(SIGNAL_WEIGHTS).toEqual({ report: 1, test: 1, build: 0.8 });
	expect(DEFAULT_TUNING.minN).toBe(5);
	expect(DEFAULT_TUNING.jevTimeoutMs).toBe(1000);
});
