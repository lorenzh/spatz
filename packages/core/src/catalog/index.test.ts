import { describe, expect, test } from "bun:test";
import type { Candidate, OpenRouterModel } from "../contracts/types.ts";
import fixture from "./fixtures/openrouter-models.json";
import {
	buildCatalog,
	candidateKey,
	compareCost,
	parseModelsArg,
	toCanonicalId,
} from "./index.ts";
import { parseOpenRouterModels } from "./openrouter.ts";

const models = parseOpenRouterModels(fixture);
const noConfig = { aliases: {}, descriptions: {} };
const keys = (c: Candidate[]) => c.map(candidateKey);

describe("parseModelsArg", () => {
	test("parses ids with explicit efforts", () => {
		expect(
			parseModelsArg("claude-opus-5-5:low+medium+high,gpt-6-sol:medium"),
		).toEqual([
			{ requested_id: "claude-opus-5-5", efforts: ["low", "medium", "high"] },
			{ requested_id: "gpt-6-sol", efforts: ["medium"] },
		]);
	});

	test("id without efforts gives efforts null", () => {
		expect(parseModelsArg("gpt-6-sol")).toEqual([
			{ requested_id: "gpt-6-sol", efforts: null },
		]);
	});

	test("unknown effort throws", () => {
		expect(() => parseModelsArg("gpt-6-sol:turbo")).toThrow(/turbo/);
	});

	test("empty list throws", () => {
		expect(() => parseModelsArg("")).toThrow();
		expect(() => parseModelsArg(" , ")).toThrow();
		expect(() => parseModelsArg("gpt-6-sol:")).toThrow();
		expect(() => parseModelsArg(":low")).toThrow();
	});
});

describe("toCanonicalId", () => {
	test.each([
		["claude-opus-5-5", "anthropic/claude-opus-5.5"],
		["claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"],
		["claude-haiku-4-5-20251001", "anthropic/claude-haiku-4.5"],
		["claude-sonnet-5-5-20261001", "anthropic/claude-sonnet-5.5"],
		["claude-fable-5-1-20261231", "anthropic/claude-fable-5.1"],
		["claude-haiku-4-5-20260101", "anthropic/claude-haiku-4.5"],
		["gpt-6-sol", "openai/gpt-6-sol"],
		["gpt-6.1-sol", "openai/gpt-6.1-sol"],
	])("%s -> %s", (id, canonical) => {
		expect(toCanonicalId(id, {})).toBe(canonical);
	});

	test("alias overrides the rule", () => {
		expect(
			toCanonicalId("claude-opus-5-5", { "claude-opus-5-5": "x/opus" }),
		).toBe("x/opus");
	});

	test.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
		"inherited property %s is not an alias",
		(id) => {
			expect(toCanonicalId(id, {})).toBe(id);
		},
	);

	test("ids containing a slash stay unchanged", () => {
		expect(toCanonicalId("anthropic/claude-opus-5.5", {})).toBe(
			"anthropic/claude-opus-5.5",
		);
		expect(toCanonicalId("claude/opus-5-5", {})).toBe("claude/opus-5-5");
	});
});

describe("candidateKey", () => {
	test("joins model and effort", () => {
		expect(
			candidateKey({ model: "anthropic/claude-opus-5.5", effort: "high" }),
		).toBe("anthropic/claude-opus-5.5:high");
	});
});

describe("buildCatalog effort expansion", () => {
	const limited: OpenRouterModel[] = [
		{
			id: "openai/gpt-6-sol",
			name: "Sol",
			price_prompt: 1e-6,
			price_completion: 1e-5,
			context_length: 1000,
			supported_efforts: ["max", "medium", "low", "none"],
		},
		{
			id: "openai/gpt-6-luna",
			name: "Luna",
			price_prompt: 1e-7,
			price_completion: 1e-6,
			context_length: 1000,
			supported_efforts: null,
		},
	];

	test("no efforts -> low, medium, high intersected with supported_efforts", () => {
		const c = buildCatalog(parseModelsArg("gpt-6-sol"), limited, noConfig);
		expect(keys(c)).toEqual([
			"openai/gpt-6-sol:low",
			"openai/gpt-6-sol:medium",
		]);
	});

	test("supported_efforts null -> low, medium, high", () => {
		const c = buildCatalog(parseModelsArg("gpt-6-luna"), limited, noConfig);
		expect(c.map((x) => x.effort)).toEqual(["low", "medium", "high"]);
	});

	test("unknown model -> low, medium, high", () => {
		const c = buildCatalog(parseModelsArg("gpt-9-nova"), limited, noConfig);
		expect(c.map((x) => x.effort)).toEqual(["low", "medium", "high"]);
	});

	test("xhigh and max only when passed explicitly", () => {
		expect(
			buildCatalog(parseModelsArg("claude-opus-5-5"), models, noConfig).map(
				(x) => x.effort,
			),
		).toEqual(["low", "medium", "high"]);
		expect(
			buildCatalog(
				parseModelsArg("claude-opus-5-5:xhigh+max"),
				models,
				noConfig,
			).map((x) => x.effort),
		).toEqual(["xhigh", "max"]);
	});

	test("duplicate (model, effort) pairs appear once", () => {
		const c = buildCatalog(
			parseModelsArg(
				"claude-opus-5-5:high,claude-opus-5-5:high+low,anthropic/claude-opus-5.5:low+low",
			),
			models,
			noConfig,
		);
		expect(keys(c)).toEqual([
			"anthropic/claude-opus-5.5:low",
			"anthropic/claude-opus-5.5:high",
		]);
	});
});

describe("cost order", () => {
	test("fixture: gpt-6-luna:low first, claude-opus-5.5:high last", () => {
		const c = buildCatalog(
			parseModelsArg("claude-opus-5-5,gpt-6-luna:low"),
			models,
			noConfig,
		);
		expect(keys(c)).toEqual([
			"openai/gpt-6-luna:low",
			"anthropic/claude-opus-5.5:low",
			"anthropic/claude-opus-5.5:medium",
			"anthropic/claude-opus-5.5:high",
		]);
		expect(c[0]?.price_completion).toBe(0.0000005);
	});

	test("price tie falls to effort, then id", () => {
		const c = buildCatalog(
			parseModelsArg("gpt-6-sol:low+high,claude-sonnet-5-5:low+high"),
			models,
			noConfig,
		);
		expect(keys(c)).toEqual([
			"anthropic/claude-sonnet-5.5:low",
			"openai/gpt-6-sol:low",
			"anthropic/claude-sonnet-5.5:high",
			"openai/gpt-6-sol:high",
		]);
	});

	test("output price before input price", () => {
		const base = {
			effort: "low" as const,
			requested_id: "",
			known: true,
			context_length: null,
			description: "",
		};
		const a = { ...base, model: "a", price_prompt: 9, price_completion: 1 };
		// Equal output price: input price decides, against alphabetical order.
		const b = { ...base, model: "b", price_prompt: 2, price_completion: 2 };
		const c = { ...base, model: "c", price_prompt: 1, price_completion: 2 };
		expect([b, c, a].sort(compareCost).map((x) => x.model)).toEqual([
			"a",
			"c",
			"b",
		]);
	});

	test("equal prices sort by all seven effort ranks", () => {
		const c = buildCatalog(
			parseModelsArg("gpt-6-sol:ultra+max+high+low+xhigh+medium+none"),
			models,
			noConfig,
		);
		expect(c.map((x) => x.effort)).toEqual([
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"ultra",
		]);
	});

	test("dated picker Haiku uses its OpenRouter price and stays below reasoning models", () => {
		const c = buildCatalog(
			parseModelsArg("claude-haiku-4-5-20251001:none,claude-opus-5-5:low"),
			[
				...models,
				{
					id: "anthropic/claude-haiku-4.5",
					name: "Haiku",
					price_prompt: 1e-6,
					price_completion: 5e-6,
					context_length: 200000,
					supported_efforts: null,
				},
			],
			noConfig,
		);
		expect(c[0]).toMatchObject({
			model: "anthropic/claude-haiku-4.5",
			effort: "none",
			known: true,
			requested_id: "claude-haiku-4-5-20251001",
		});
		expect(c[1]?.model).toBe("anthropic/claude-opus-5.5");
		expect(
			toCanonicalId("claude-haiku-4-5-20251001", {
				"claude-haiku-4-5-20251001": "custom/haiku",
			}),
		).toBe("custom/haiku");
	});

	test("price takes precedence over none and ultra", () => {
		const c = buildCatalog(
			parseModelsArg("claude-opus-5-5:none,claude-sonnet-5-5:ultra"),
			models,
			noConfig,
		);
		expect(keys(c)).toEqual([
			"anthropic/claude-sonnet-5.5:ultra",
			"anthropic/claude-opus-5.5:none",
		]);
	});

	test("models unknown to OpenRouter sort after all known ones", () => {
		const c = buildCatalog(
			parseModelsArg("gpt-9-nova:low,gpt-6-astra:max,claude-opus-5-5:low"),
			models,
			noConfig,
		);
		expect(keys(c)).toEqual([
			"anthropic/claude-opus-5.5:low",
			"openai/gpt-6-astra:max",
			"openai/gpt-9-nova:low",
		]);
		const unknown = c[2];
		expect(unknown?.known).toBe(false);
		expect(unknown?.price_prompt).toBeNull();
		expect(unknown?.price_completion).toBeNull();
		expect(unknown?.context_length).toBeNull();
		expect(c[0]?.known).toBe(true);
		expect(c[0]?.context_length).toBe(1000000);
		expect(c[0]?.requested_id).toBe("claude-opus-5-5");
	});
});

describe("description", () => {
	test("uses the description file entry when present", () => {
		const c = buildCatalog(parseModelsArg("claude-opus-5-5:high"), models, {
			aliases: {},
			descriptions: { "anthropic/claude-opus-5.5": "Strongest model" },
		});
		expect(c[0]?.description).toBe("Strongest model");
	});

	test("falls back to model name and output price class", () => {
		const c = buildCatalog(
			parseModelsArg("claude-opus-5-5:high,gpt-6-luna:low"),
			models,
			noConfig,
		);
		expect(c[0]?.description).toBe(
			"OpenAI: GPT-6 Luna, Preisklasse: 0.5 USD/M Output-Tokens",
		);
		expect(c[1]?.description).toBe(
			"Anthropic: Claude Opus 5.5, Preisklasse: 20 USD/M Output-Tokens",
		);
	});

	test("unknown model gets price class 'unbekannt'", () => {
		const c = buildCatalog(parseModelsArg("gpt-9-nova:low"), models, noConfig);
		expect(c[0]?.description).toBe("openai/gpt-9-nova, Preisklasse: unbekannt");
	});

	test("inherited property name is not a description", () => {
		const c = buildCatalog(parseModelsArg("constructor:low"), models, noConfig);
		expect(c[0]?.description).toBe("constructor, Preisklasse: unbekannt");
	});
});
