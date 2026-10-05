import { expect, test } from "claude-code/testing";
import { suggest } from "../hooks/bridge.ts";

const good = JSON.stringify({
	suggestion_id: "s1",
	ranking: [{ model: "anthropic/claude-opus-5.5", effort: "high" }],
});

test("bridge parses a spatz suggestion", async () => {
	let invocation: { argv: readonly string[]; timeoutMs: number } | undefined;
	const result = await suggest(
		async (argv, init) => {
			invocation = { argv, timeoutMs: init.timeoutMs };
			return { exitCode: 0, stdout: good, stderr: "" };
		},
		"task",
		["claude-opus-5-5:low+medium+high"],
		"subagent",
	);
	expect(invocation).toEqual({
		argv: [
			"spatz",
			"task",
			"--models",
			"claude-opus-5-5:low+medium+high",
			"--json",
		],
		timeoutMs: 6000,
	});
	expect(result).toEqual({
		suggestionId: "s1",
		model: "claude-opus-5-5",
		effort: "high",
		scope: "subagent",
	});
});

test("bridge fails open for execution, exit, timeout, and JSON errors", async () => {
	const throws = async () => {
		throw new Error("missing or timed out");
	};
	const failed = async () => ({ exitCode: 1, stdout: good, stderr: "failed" });
	const malformed = async () => ({ exitCode: 0, stdout: "nope", stderr: "" });
	for (const run of [throws, failed, malformed]) {
		expect(
			await suggest(run, "task", ["claude-opus-5-5:high"], "subagent"),
		).toBeNull();
	}
});
