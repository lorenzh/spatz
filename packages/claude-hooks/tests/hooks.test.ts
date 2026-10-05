import { expect, test } from "bun:test";
import manifest from "../.claude-plugin/plugin.json";
import { hooks } from "../hooks/hooks.json";

test("the hooks plugin runs the four spatz events asynchronously", () => {
	expect(manifest.name).toBe("spatz-hooks");
	expect(Object.keys(hooks).sort()).toEqual([
		"PostToolUse",
		"PostToolUseFailure",
		"Stop",
		"SubagentStop",
	]);
	for (const [event, matcher] of [
		["PostToolUse", "Bash|Agent"],
		["PostToolUseFailure", "Bash"],
		["Stop", undefined],
		["SubagentStop", undefined],
	] as const) {
		expect(hooks[event]).toEqual([
			{
				...(matcher && { matcher }),
				hooks: [
					{ type: "command", command: `spatz hook ${event}`, async: true },
				],
			},
		]);
	}
});
