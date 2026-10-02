import { expect, test } from "bun:test";
import { run } from "./index.ts";

test("run sums numeric args", () => {
	expect(run(["1", "2", "3"])).toBe("6");
});

test("run rejects non-numeric args", () => {
	expect(() => run(["1", "x"])).toThrow("Not a number: x");
});
