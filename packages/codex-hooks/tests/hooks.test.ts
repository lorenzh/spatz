import { expect, test } from "bun:test";
import manifest from "../.codex-plugin/plugin.json";
import { hooks } from "../hooks/hooks.json";

test("the Codex plugin runs the two spatz hooks with a 10-second timeout", () => {
	expect(manifest.name).toBe("spatz-hooks");
	expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "Stop"]);
	for (const [event, matcher] of [
		["PostToolUse", "Bash"],
		["Stop", undefined],
	] as const) {
		expect(hooks[event]).toEqual([
			{
				...(matcher && { matcher }),
				hooks: [
					{
						type: "command",
						command: `spatz hook ${event} --agent codex`,
						timeout: 10,
					},
				],
			},
		]);
	}
});
