import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	parseClaudeModelCatalog,
	parseCodexModelCatalog,
} from "./harness-catalog.ts";

describe("harness picker parsers", () => {
	test("selects the newest Opus and Sonnet IDs from Claude's embedded catalog", async () => {
		const fixture = await readFile(
			new URL("./fixtures/claude-picker-strings.txt", import.meta.url),
			"utf8",
		);
		expect(parseClaudeModelCatalog(fixture)).toEqual([
			{
				id: "claude-opus-5-5",
				efforts: ["low", "medium", "high", "xhigh", "max"],
			},
			{
				id: "claude-sonnet-5-5",
				efforts: ["low", "medium", "high", "xhigh", "max"],
			},
		]);
		expect(() => parseClaudeModelCatalog("no model strings")).toThrow();
		expect(() =>
			parseClaudeModelCatalog(
				fixture.replace("schema_version:1", "schema_version:2"),
			),
		).toThrow();
		expect(() =>
			parseClaudeModelCatalog(
				fixture.replace('family:"sonnet"', 'family:"missing"'),
			),
		).toThrow();
		expect(() =>
			parseClaudeModelCatalog(
				fixture.replaceAll(
					'effort_levels:["low","medium","high","xhigh","max"]',
					"effort_levels:[]",
				),
			),
		).toThrow();
	});

	test("selects visible models from Codex's newest generation and intersects efforts", async () => {
		const fixture = JSON.parse(
			await readFile(
				new URL("./fixtures/codex-picker.json", import.meta.url),
				"utf8",
			),
		);
		expect(parseCodexModelCatalog(fixture)).toEqual([
			{ id: "gpt-6-astra", efforts: ["low", "medium", "high"] },
			{ id: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh", "max"] },
		]);
		expect(() => parseCodexModelCatalog({ models: [] })).toThrow();
		expect(() =>
			parseCodexModelCatalog({
				models: [
					{
						slug: "gpt-7-test",
						visibility: "list",
						supported_reasoning_levels: [],
					},
				],
			}),
		).toThrow();
		expect(() => parseCodexModelCatalog(null)).toThrow();
	});
});
