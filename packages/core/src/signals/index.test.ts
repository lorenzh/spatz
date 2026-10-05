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
	test("reads completed command events once, within their turn, without legacy mirrors", async () => {
		const rollout = await Bun.file(
			`${import.meta.dir}/fixtures/codex-command-events.jsonl`,
		).text();
		expect(parseCodexRollout(rollout, "todo-turn")).toEqual({
			model: "gpt-6-luna",
			effort: "low",
			usage: {
				input_tokens: 174968,
				cache_read_input_tokens: 149504,
				cache_creation_input_tokens: 0,
				output_tokens: 674,
			},
			calls: [
				{ command: "rtk proxy bun test", exit_code: 1 },
				{ command: "rtk proxy bun build app.js --outdir dist", exit_code: 0 },
			],
		});
		// Legacy records also stay in their own turn.
		expect(parseCodexRollout(rollout, "later")?.calls).toEqual([
			{ command: "bun test", exit_code: 0 },
		]);
	});
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
		"make clean",
		"make clean -j4",
		"make test --help",
		"make install",
		"make -j4 clean",
		"pytest --collect-only",
		"pytest --co -q",
		"pytest --help",
		"cargo test --help",
	])("%p -> null (no false pass)", (cmd) => {
		expect(detectCommandKind(cmd)).toBeNull();
	});
	test.each(["make -j4", "make build", "make all"])("%p -> build", (cmd) => {
		expect(detectCommandKind(cmd)).toBe("build");
	});
	test.each(["make test", "make check"])("%p -> test", (cmd) => {
		expect(detectCommandKind(cmd)).toBe("test");
	});
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
		'spatz "fix bug" --json',
		'rtk spatz "fix bug"',
		'rtk proxy spatz "fix bug"',
		'npx @spatz/cli "fix bug"',
		'npx --yes @spatz/cli "fix bug"',
		'npx -y @spatz/cli@0.1.0 "fix bug"',
		'npx @spatz/cli@nightly "fix bug"',
		'bunx @spatz/cli "fix bug"',
		'bunx --bun @spatz/cli "fix bug"',
		'npm exec @spatz/cli -- "fix bug"',
		'bunx @spatz/cli@1.2.3-rc.1 "fix bug"',
		'rtk proxy npx -y @spatz/cli@0.1.0 "fix bug"',
		'/plugins/spatz/bin/spatz "fix bug"',
		'"/plugins/with spaces/bin/spatz" "fix bug"',
		`"\${CLAUDE_PLUGIN_ROOT}/bin/spatz" "fix bug"`,
		`"\${PLUGIN_ROOT}/bin/spatz" "fix bug"`,
		'~/.codex/plugins/cache/spatz/spatz/0.1.1/bin/spatz "fix bug"',
		'~/.claude/plugins/cache/spatz-mod/spatz/0.1.1/bin/spatz "fix bug"',
		'~/.claude/plugins/cache/spatz/spatz/0.1.1/bin/spatz "fix bug"',
		"'/plugins/with spaces/bin/spatz' 'fix bug'",
	])("launcher suggestion: %p", (cmd) => {
		expect(detectCommandKind(cmd)).toBe("spatz-suggest");
	});

	test.each([
		'npx -y @spatz/cli-extra "fix bug"',
		'npx -y @other/cli "fix bug"',
		'bunx spatz "fix bug"',
		'bunx @spatz/cli@ "fix bug"',
		'echo npx @spatz/cli "fix bug"',
		'echo "x; npx @spatz/cli fix"',
		'echo "/plugins/bin/spatz" "fix bug"',
		'/plugins/bin/spatz-extra "fix bug"',
		"npx -y @spatz/cli report id",
		"bunx @spatz/cli hook Stop",
		'"/plugins/bin/spatz" stats --json',
		"spatz link id --session s",
		"spatz --version",
		'spatz "report" id',
	])("launcher lookalike or subcommand: %p", (cmd) => {
		expect(detectCommandKind(cmd)).toBeNull();
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
			extractSuggestionId(`Recommendation: x\nsuggestion_id: ${id}\nreason: y`),
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
	test("failures that never reached the runner give no signal", () => {
		const f = (error: string, is_interrupt = false) => ({
			...fail("cd /missing && bun test"),
			error,
			is_interrupt,
		});
		for (const e of [
			f("Exit code 1\ncd: /missing: No such file or directory"),
			f("Exit code 126\nbash: permission denied"),
			f("Exit code 127\nbun: command not found"),
			f("Exit code 130", true),
		])
			expect(signalFromBashEvent(e, "sid", 1)).toBeNull();
		expect(
			signalFromBashEvent(fail("cd pkg && bun test"), "sid", 1)?.value,
		).toBe(0);
	});
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
		for (const level of ["none", "ultra"] as const)
			expect(effortFromHook({ ...ok("x"), effort: { level } })).toBe(level);
	});
	test("missing or unknown -> null", () => {
		expect(effortFromHook(ok("x"))).toBeNull();
		expect(
			effortFromHook({ ...ok("x"), effort: { level: "turbo" } }),
		).toBeNull();
		expect(effortFromHook(parsed(1))).toBeNull();
	});
});
