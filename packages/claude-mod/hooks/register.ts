import type { EngineInterface, On, PluginOptions } from "claude-code";
import { type Decision, suggest } from "./bridge.ts";

type Options = PluginOptions;
const DEFAULT_MODELS = [
	"claude-opus-5-5:low+medium+high",
	"claude-sonnet-5-5:low+medium+high",
];

export function register(on: On, options: Options = {}) {
	const stringOption = (key: string, fallback: string) =>
		typeof options[key] === "string" ? (options[key] as string) : fallback;
	const mode = stringOption("mode", "show");
	const scope = stringOption("scope", "subagent");
	const models = stringOption("models", DEFAULT_MODELS.join(","))
		.split(",")
		.map((model) => model.trim())
		.filter(Boolean);
	const decisions = new Map<string, Decision>();

	on("agent.spawn", async ($, e, next) => {
		if (e.fork || scope !== "subagent") return next(e);
		const decision = await suggest(
			(argv, init) => $.process.run(argv, init),
			e.prompt,
			models,
			scope,
			stringOption("spatz", "spatz"),
		);
		if (!decision) return next(e);
		const result = await next(
			mode === "apply" ? { ...e, model: decision.model } : e,
		);
		if (result.agentId && !result.deny) decisions.set(result.agentId, decision);
		return result;
	});

	on("turn.step", async function* (_$: EngineInterface, e, next) {
		const decision =
			mode === "apply" && e.agentId ? decisions.get(e.agentId) : undefined;
		if (decision)
			return yield* next({
				...e,
				model: decision.model,
				effort: decision.effort,
			});
		return yield* next(e);
	});
}
