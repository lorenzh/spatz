import { expect, test } from "bun:test";
import { sum } from "./index.ts";

test("sum adds all numbers", () => {
	expect(sum([1, 2, 3])).toBe(6);
});

test("sum of an empty list is 0", () => {
	expect(sum([])).toBe(0);
});
