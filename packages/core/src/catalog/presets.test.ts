import { describe, expect, test } from "bun:test";
import { DEFAULT_MODELS } from "../../../claude-mod/hooks/settings.ts";
import type { Env } from "../contracts/deps.ts";
import { buildCatalog, parseModelsArg } from "./index.ts";
import {
	detectHarness,
	filterFamily,
	HARNESS_PRESETS,
	labelModelsError,
	ModelsUsageError,
	resolveModels,
} from "./presets.ts";

describe("harness presets", () => {
	test.each([
		[{}, null],
		[{ CLAUDECODE: "1" }, "claude-code"],
		[{ CLAUDE_CODE_ENTRYPOINT: "cli" }, "claude-code"],
		[{ CLAUDECODE: "0", CLAUDE_CODE_ENTRYPOINT: "" }, null],
		[{ CODEX_THREAD_ID: "thread" }, "codex"],
		[{ CODEX_THREAD_ID: "  " }, null],
		[
			{
				CODEX_COMPANION_SESSION_ID: "session",
				CODEX_COMPANION_TRANSCRIPT_PATH: "/tmp/log",
			},
			null,
		],
		[{ CLAUDECODE: "1", CODEX_COMPANION_SESSION_ID: "session" }, "claude-code"],
		[
			{
				CLAUDECODE: "1",
				CLAUDE_CODE_ENTRYPOINT: "cli",
				CODEX_THREAD_ID: "inner",
				CODEX_COMPANION_SESSION_ID: "outer",
			},
			"codex",
		],
	] as [Env, "claude-code" | "codex" | null][])(
		"detects %j as %s",
		(env, expected) => {
			expect(detectHarness(env)).toBe(expected);
		},
	);

	test("release presets contain only their harness family at low, medium, high", () => {
		expect(HARNESS_PRESETS["claude-code"]).toBe(DEFAULT_MODELS);
		for (const [harness, ids] of [
			[
				"claude-code",
				["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5"],
			],
			["codex", ["openai/gpt-6-astra", "openai/gpt-6-luna"]],
		] as const) {
			const catalog = buildCatalog(
				parseModelsArg(HARNESS_PRESETS[harness]),
				[],
				{ aliases: {}, descriptions: {} },
			);
			expect(catalog).toHaveLength(6);
			for (const model of ids)
				expect(
					catalog.filter((c) => c.model === model).map((c) => c.effort),
				).toEqual(["low", "medium", "high"]);
		}
	});
});

describe("candidate defaults", () => {
	test("flag > env > selected config > preset", () => {
		const env = { SPATZ_MODELS: "env-model", CLAUDECODE: "1" };
		const config = {
			models: { value: "project-model", source: "project" as const },
		};
		expect(resolveModels("flag-model", env, config)).toEqual({
			value: "flag-model",
			source: "flag",
		});
		expect(resolveModels(undefined, env, config)).toEqual({
			value: "env-model",
			source: "env",
		});
		expect(resolveModels(undefined, { CLAUDECODE: "1" }, config)).toEqual({
			value: "project-model",
			source: "project",
		});
		for (const [env, harness] of [
			[{ CLAUDECODE: "1" }, "claude-code"],
			[{ CODEX_THREAD_ID: "t" }, "codex"],
		] as const)
			expect(resolveModels(undefined, env, {})).toEqual({
				value: HARNESS_PRESETS[harness],
				source: `preset:${harness}`,
			});
		expect(
			resolveModels(
				undefined,
				{},
				{ models: { value: "user-model", source: "user" } },
			),
		).toEqual({ value: "user-model", source: "user" });
	});

	test("blank values count as unset and fall through", () => {
		expect(resolveModels(" ", { SPATZ_MODELS: "fallback" }, {})).toEqual({
			value: "fallback",
			source: "env",
		});
		expect(
			resolveModels(undefined, { SPATZ_MODELS: "", CLAUDECODE: "1" }, {})
				.source,
		).toBe("preset:claude-code");
		expect(
			resolveModels(
				undefined,
				{ CLAUDECODE: "1" },
				{ models: { value: "", source: "user" } },
			).source,
		).toBe("preset:claude-code");
	});

	test("parse errors name the source of the bad value", () => {
		const fail = (source: "env" | "project" | "user" | "flag") => {
			try {
				parseModelsArg("claude-opus-5-5:turbo");
			} catch (error) {
				return (labelModelsError(error, source) as Error).message;
			}
		};
		expect(fail("env")).toStartWith("SPATZ_MODELS: unknown effort");
		expect(fail("project")).toStartWith(".spatz.json models: unknown effort");
		expect(fail("user")).toStartWith(
			"~/.spatz/config.json models: unknown effort",
		);
		expect(fail("flag")).toStartWith("--models: unknown effort");
	});

	test("missing defaults name every configuration option", () => {
		expect(() => resolveModels(undefined, {}, {})).toThrow(ModelsUsageError);
		try {
			resolveModels(undefined, {}, {});
		} catch (error) {
			for (const name of [
				"--models",
				"SPATZ_MODELS",
				".spatz.json",
				"~/.spatz/config.json",
			])
				expect((error as Error).message).toContain(name);
		}
	});

	test.each([[null], [42], [[]], [{}]])(
		"invalid models value %j fails only when selected",
		(value) => {
			const config = { models: { value, source: "project" as const } };
			expect(() => resolveModels(undefined, {}, config)).toThrow(
				"models must be a string",
			);
			expect(resolveModels("gpt-6-luna", {}, config).source).toBe("flag");
			expect(
				resolveModels(undefined, { SPATZ_MODELS: "gpt-6-luna" }, config).source,
			).toBe("env");
		},
	);
});

describe("family filter", () => {
	const requested = parseModelsArg(
		"claude-opus-5-5:high,gpt-6-astra,openai/gpt-6-luna:low,custom,vendor/model",
	);
	const aliases = { custom: "anthropic/claude-sonnet-5.5" };
	test.each(["claude", "anthropic", "gpt", "openai"])(
		"filters %s after canonicalization",
		(family) => {
			const result = filterFamily(requested, family, aliases);
			expect(result).toEqual(
				family === "claude" || family === "anthropic"
					? requested.filter((_, i) => i === 0 || i === 3)
					: requested.slice(1, 3),
			);
		},
	);
	test("absent filter preserves the list", () => {
		expect(filterFamily(requested, undefined, aliases)).toBe(requested);
	});
	test("invalid and empty family matches fail", () => {
		expect(() => filterFamily(requested, "other", aliases)).toThrow(
			ModelsUsageError,
		);
		expect(() =>
			filterFamily(parseModelsArg("gpt-6-luna"), "claude", {}),
		).toThrow("no matching candidates");
	});
});
