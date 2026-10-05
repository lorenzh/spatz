import { expect, test } from "claude-code/testing";
import {
	aliasFor,
	ladder,
	recordUsage,
	stronger,
	suggest,
} from "../hooks/bridge.ts";

const good = JSON.stringify({
	suggestion_id: "s1",
	classification: {
		task_type: "code.bugfix",
		difficulty: "medium",
		criticality: "none",
	},
	ranking: [{ model: "anthropic/claude-opus-5.5", effort: "high" }],
});

test("bridge accepts English and legacy difficulty values from the CLI", async () => {
	for (const difficulty of [
		"easy",
		"medium",
		"hard",
		"leicht",
		"mittel",
		"schwer",
	]) {
		const result = await suggest(
			async () => ({
				exitCode: 0,
				stderr: "",
				stdout: JSON.stringify({
					...JSON.parse(good),
					classification: {
						task_type: "code.bugfix",
						difficulty,
						criticality: "none",
					},
				}),
			}),
			"task",
			["claude-opus-5-5:high"],
			{ scope: "turn" },
		);
		expect(result?.model).toBe("claude-opus-5-5");
	}
});

test("bridge parses a spatz suggestion and passes every link flag", async () => {
	let invocation: { argv: readonly string[]; timeoutMs: number } | undefined;
	const result = await suggest(
		async (argv, init) => {
			invocation = { argv, timeoutMs: init.timeoutMs };
			return { exitCode: 0, stdout: good, stderr: "" };
		},
		"task",
		["claude-opus-5-5:low+medium+high"],
		{ scope: "subagent", session: "sess", turn: "t1", agentId: "a1" },
	);
	expect(invocation).toEqual({
		argv: [
			"spatz",
			"task",
			"--models",
			"claude-opus-5-5:low+medium+high",
			"--json",
			"--scope",
			"subagent",
			"--source",
			"claude-code-mod",
			"--session",
			"sess",
			"--turn",
			"t1",
			"--agent-id",
			"a1",
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
			await suggest(run, "task", ["claude-opus-5-5:high"], { scope: "turn" }),
		).toBeNull();
	}
	for (const run of [throws, failed]) {
		expect(
			await recordUsage(run, "s1", "m", "t1", {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheCreation: 0,
			}),
		).toBe(false);
	}
});

test("aliasFor returns an alias only for the exact id it resolves to", () => {
	expect(aliasFor("claude-sonnet-5-5")).toBe("sonnet");
	expect(aliasFor("claude-opus-5-5")).toBe("opus");
	expect(aliasFor("claude-sonnet-4-6")).toBeUndefined();
});

test("ladder runs from the weakest pair to the strongest model at its highest effort", () => {
	const models = ["claude-opus-5-5:low+high", "claude-sonnet-5-5:medium+low"];
	expect(ladder(models)).toEqual([
		{ model: "claude-sonnet-5-5", effort: "low" },
		{ model: "claude-sonnet-5-5", effort: "medium" },
		{ model: "claude-opus-5-5", effort: "low" },
		{ model: "claude-opus-5-5", effort: "high" },
	]);
	expect(
		stronger(models, { model: "claude-sonnet-5-5", effort: "medium" }),
	).toEqual({
		model: "claude-opus-5-5",
		effort: "low",
	});
	expect(
		stronger(models, { model: "claude-opus-5-5", effort: "high" }),
	).toBeNull();
	expect(stronger(models, { model: "other", effort: "low" })).toBeNull();
});

test("bridge accepts max effort from CLI defaults", async () => {
	const result = await suggest(
		async () => ({
			exitCode: 0,
			stderr: "",
			stdout: good.replace('"high"', '"max"'),
		}),
		"task",
		[],
		{ scope: "turn" },
	);
	expect(result?.effort).toBe("max");
});

test("Claude fails open for a Codex-only ultra recommendation", async () => {
	expect(
		await suggest(
			async () => ({
				exitCode: 0,
				stderr: "",
				stdout: good.replace('"high"', '"ultra"'),
			}),
			"task",
			[],
			{ scope: "turn" },
		),
	).toBeNull();
});

test("bridge restores catalog snapshots and preserves explicit dated IDs", async () => {
	for (const [id, expected] of [
		["anthropic/claude-haiku-4.5", "claude-haiku-4-5-20251001"],
		["anthropic/claude-sonnet-5.5-20261001", "claude-sonnet-5-5-20261001"],
		["anthropic/claude-fable-5.1-20261231", "claude-fable-5-1-20261231"],
	]) {
		const result = await suggest(
			async () => ({
				exitCode: 0,
				stderr: "",
				stdout: JSON.stringify({
					suggestion_id: "s",
					ranking: [{ model: id, effort: "high" }],
				}),
			}),
			"task",
			[],
			{ scope: "turn" },
		);
		expect(result?.model).toBe(expected);
	}
});
