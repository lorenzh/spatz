import { expect, test } from "bun:test";
import { priceDiffs } from "./price-check.ts";

const official = {
	"anthropic/claude-opus-5.5": {
		input: 4,
		cache_read: 0.2,
		cache_write: 8,
		output: 20,
		prefer_official: ["cache_write"],
	},
	"openai/gpt-6.1-sol": {
		input: 2,
		cache_read: 0.1,
		cache_write: null,
		output: 10,
	},
	"openai/gpt-6-luna": {
		input: 0.1,
		cache_read: 0.01,
		cache_write: null,
		output: 0.5,
	},
};
const model = (
	id: string,
	prompt: number,
	completion: number,
	read: number | null,
	write: number | null,
) => ({
	id,
	name: id,
	price_prompt: prompt / 1e6,
	price_completion: completion / 1e6,
	price_cache_read: read === null ? null : read / 1e6,
	price_cache_write: write === null ? null : write / 1e6,
	context_length: null,
	supported_efforts: null,
});

test("reports changed prices and missing models; preferred official fields and OpenRouter-only prices are notes", () => {
	const d = priceDiffs(official, [
		// OpenRouter's 5-minute cache write: expected, the table keeps the 1-hour rate.
		model("anthropic/claude-opus-5.5", 4, 20, 0.2, 5),
		// Output went up; OpenRouter also prices a cache write the official page does not list.
		model("openai/gpt-6.1-sol", 2, 12, 0.1, 2.5),
	]);
	expect(d.changed).toEqual([
		"openai/gpt-6.1-sol output: official 10, OpenRouter 12",
		"openai/gpt-6-luna: not listed at OpenRouter",
	]);
	expect(d.notes).toEqual([
		"anthropic/claude-opus-5.5 cache_write: official 8 (preferred), OpenRouter 5",
		"openai/gpt-6.1-sol cache_write: official none, OpenRouter 2.5",
	]);
});

test("equal prices report nothing, despite float noise in USD per token", () => {
	expect(
		priceDiffs(
			{ "anthropic/claude-opus-5.5": official["anthropic/claude-opus-5.5"] },
			[model("anthropic/claude-opus-5.5", 4, 20, 0.2, 8)],
		),
	).toEqual({ changed: [], notes: [] });
});
