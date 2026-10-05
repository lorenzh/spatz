import { describe, expect, test } from "bun:test";
import type {
	HookInput,
	PostToolUseFailureInput,
	PostToolUseInput,
} from "../contracts/hooks.ts";
import fixtures from "./fixtures/hook-inputs.json";
import {
	detectCommandKind,
	effortFromHook,
	extractSuggestionId,
	isIgnoredHookInput,
	parseHookInput,
	signalFromBashEvent,
} from "./index.ts";
import { parseCodexRollout } from "./transcript.ts";

const inputs = fixtures as { _event: string; input: Record<string, unknown> }[];
const parsed = (i: number) =>
	parseHookInput(JSON.stringify(inputs[i]?.input)) as HookInput;

describe("parseCodexRollout", () => {
	test("reads the matching turn, token usage and each shell exit code", async () => {
		const rollout = await Bun.file(
			`${import.meta.dir}/fixtures/codex-rollout.jsonl`,
		).text();
		const result = parseCodexRollout(
			rollout,
			"11111111-1111-1111-1111-111111111111",
		);
		expect(result).toEqual({
			model: "gpt-6-luna",
			effort: "low",
			usage: {
				input_tokens: 61711,
				cache_read_input_tokens: 48128,
				cache_creation_input_tokens: 0,
				output_tokens: 124,
			},
			calls: [
				{ command: "false", exit_code: 1 },
				{ command: "sh -c 'echo boom >&2; exit 3'", exit_code: 3 },
				{ command: "echo ok", exit_code: 0 },
			],
		});
	});
	test("ignores CommandExecution exits that have no matching call output", () => {
		const rollout = [
			JSON.stringify({
				type: "turn_context",
				payload: { turn_id: "turn", model: "gpt-6-luna" },
			}),
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "custom_tool_call",
					call_id: "call-real",
					input: 'exec_command({cmd:"false"})',
				},
			}),
			JSON.stringify({
				type: "event_msg",
				payload: {
					type: "item_completed",
					item: {
						type: "CommandExecution",
						id: "call-real",
						exit_code: 1,
					},
				},
			}),
		].join("\n");
		expect(parseCodexRollout(rollout, "turn")?.calls).toEqual([]);
	});
	test("skips partial and unknown records without throwing", () => {
		expect(parseCodexRollout('{"type":"future_record"}\n{bad', "x")).toBeNull();
	});
});

describe("parseHookInput", () => {
	test("parses every fixture event", () => {
		for (const f of inputs) {
			const input = parseHookInput(JSON.stringify(f.input));
			expect(input?.hook_event_name).toBe(f._event as never);
			expect(input?.session_id).toBe(f.input.session_id as string);
		}
	});

	test("invalid JSON or missing hook_event_name -> null", () => {
		expect(parseHookInput("{not json")).toBeNull();
		expect(parseHookInput("")).toBeNull();
		expect(parseHookInput('{"session_id":"s"}')).toBeNull();
		expect(parseHookInput("null")).toBeNull();
		expect(parseHookInput("[]")).toBeNull();
		expect(parseHookInput('{"hook_event_name":42}')).toBeNull();
	});
});

describe("isIgnoredHookInput", () => {
	test("SubagentHandback and <agent-message prompt are ignored, the rest is not", () => {
		const ignored = inputs.map((_, i) => isIgnoredHookInput(parsed(i)));
		const expected = inputs.map(
			(f) =>
				f.input.tool_name === "SubagentHandback" ||
				(f._event === "UserPromptSubmit" &&
					String(f.input.prompt).startsWith("<agent-message")),
		);
		expect(ignored).toEqual(expected);
		expect(ignored.filter(Boolean)).toHaveLength(2);
	});
});

describe("detectCommandKind", () => {
	test.each([
		"bun test",
		"npm test",
		"npm run test",
		"pytest -q",
		"go test ./...",
		"cargo test",
		"vitest run",
		"jest",
		"cd packages/core && bun test",
		"FOO=1 bun test 2>&1",
		"bunx vitest run",
		"python -m pytest -q",
	])("%p -> test", (cmd) => {
		expect(detectCommandKind(cmd)).toBe("test");
	});

	test.each([
		"bun run build",
		"npm run build",
		"tsc --noEmit",
		"cargo build",
		"go build",
		"bun build x.ts",
		"make",
	])("%p -> build", (cmd) => {
		expect(detectCommandKind(cmd)).toBe("build");
	});

	test("spatz suggest call", () => {
		expect(detectCommandKind('spatz "fix bug" --models x')).toBe(
			"spatz-suggest",
		);
		expect(
			detectCommandKind('spatz "fix bun test" --models x --json | jq .'),
		).toBe("spatz-suggest");
		expect(detectCommandKind("echo 'x; spatz fix'")).toBeNull();
	});

	test.each([
		"spatz report abc --model m --effort low --result pass",
		"spatz stats",
		"spatz hook Stop",
		"echo ok",
		"latest-tests.sh",
		"",
		'echo "bun test"',
		"echo 'a; bun test'",
		"rg pytest README.md",
		"grep -r 'make' src",
		"cat tsc.log",
		// ambiguous: the exit status is not (only) the test's or build's
		"bun test | tail -5",
		"bun test || true",
		"bun test; echo done",
		"bun test &",
		"bun run build && bun test",
		"echo $(bun test)",
	])("%p -> null", (cmd) => {
		expect(detectCommandKind(cmd)).toBeNull();
	});

	test.each([
		["rtk bun test", "test"],
		["rtk pytest -q", "test"],
		["rtk proxy bun test", "test"],
		["cd x && rtk proxy bun test", "test"],
		["bun test\n", "test"],
		["  rtk tsc --noEmit  \n", "build"],
		["rtk bun run build", "build"],
		["rtk proxy make", "build"],
		["rtk proxy echo bun test", null],
		["rtk gain", null],
	] as const)(
		"RTK prefix and surrounding whitespace: %p -> %p",
		(cmd, kind) => {
			expect(detectCommandKind(cmd)).toBe(kind);
		},
	);

	test.each([
		["bun test && false", null],
		["false && bun test", null],
		["bun install && bun test", null],
		["bun test && cd x", null],
		["cd x && bun test", "test"],
		["cd a && export CI=1 && bun run build", "build"],
	] as const)(
		"&& chain %p -> %p: the test/build is last, after setup only",
		(cmd, kind) => {
			expect(detectCommandKind(cmd)).toBe(kind);
		},
	);
});

describe("extractSuggestionId", () => {
	const id = "3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b";
	test("text line", () => {
		expect(
			extractSuggestionId(`Empfehlung: x\nsuggestion_id: ${id}\nreason: y`),
		).toBe(id);
	});
	test("JSON", () => {
		expect(
			extractSuggestionId(
				JSON.stringify({ suggestion_id: id, ranking: [] }, null, 2),
			),
		).toBe(id);
		expect(extractSuggestionId(`{"suggestion_id":"${id}"}`)).toBe(id);
	});
	test("none -> null", () => {
		expect(extractSuggestionId("ok")).toBeNull();
		expect(extractSuggestionId("suggestion_id: not-a-uuid")).toBeNull();
	});
});

const base = {
	session_id: "s",
	transcript_path: "/t.jsonl",
	cwd: "/",
	tool_use_id: "t1",
};
const ok = (command: string, tool_name = "Bash"): PostToolUseInput => ({
	...base,
	hook_event_name: "PostToolUse",
	tool_name,
	tool_input: { command },
	tool_response: { stdout: "", stderr: "", interrupted: false },
});
const fail = (command: string): PostToolUseFailureInput => ({
	...base,
	hook_event_name: "PostToolUseFailure",
	tool_name: "Bash",
	tool_input: { command },
	error: "Exit code 1",
});

describe("signalFromBashEvent", () => {
	test("PostToolUse bun test -> test 1", () => {
		expect(signalFromBashEvent(ok("bun test"), "sid", 123)).toEqual({
			suggestion_id: "sid",
			kind: "test",
			value: 1,
			weight: 1.0,
			source: "PostToolUse",
			observed_at: 123,
		});
	});
	test("PostToolUseFailure tsc -> build 0", () => {
		expect(signalFromBashEvent(fail("tsc"), "sid", 5)).toEqual({
			suggestion_id: "sid",
			kind: "build",
			value: 0,
			weight: 0.8,
			source: "PostToolUseFailure",
			observed_at: 5,
		});
	});
	test("non-Bash tool, non-test command, spatz call -> null", () => {
		expect(signalFromBashEvent(ok("bun test", "Agent"), "sid", 1)).toBeNull();
		expect(signalFromBashEvent(ok("echo ok"), "sid", 1)).toBeNull();
		expect(
			signalFromBashEvent(ok('spatz "x" --models m'), "sid", 1),
		).toBeNull();
		expect(
			signalFromBashEvent({ ...ok(""), tool_input: null }, "sid", 1),
		).toBeNull();
	});
	test("fixture events: echo ok and false give no signal", () => {
		for (const [i, f] of inputs.entries()) {
			if (f.input.tool_name !== "Bash") continue;
			expect(
				signalFromBashEvent(
					parsed(i) as PostToolUseInput | PostToolUseFailureInput,
					"sid",
					1,
				),
			).toBeNull();
		}
	});
});

describe("effortFromHook", () => {
	test("effort.level low -> low", () => {
		expect(effortFromHook({ ...ok("x"), effort: { level: "low" } })).toBe(
			"low",
		);
		expect(effortFromHook({ ...ok("x"), effort: { level: "max" } })).toBe(
			"max",
		);
		expect(effortFromHook(parsed(2))).toBe("low");
	});
	test("missing or unknown -> null", () => {
		expect(effortFromHook(ok("x"))).toBeNull();
		expect(
			effortFromHook({ ...ok("x"), effort: { level: "none" } }),
		).toBeNull();
		expect(effortFromHook(parsed(1))).toBeNull();
	});
});
