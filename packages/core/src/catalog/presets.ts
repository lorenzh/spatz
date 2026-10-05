import type { Env } from "../contracts/deps.ts";
import type {
	Config,
	ModelsSource,
	RequestedModel,
} from "../contracts/types.ts";
import { toCanonicalId } from "./index.ts";

// Review these presets each release. Keep efforts aligned with the mod defaults.
export const HARNESS_PRESETS = {
	"claude-code":
		"claude-opus-5-5:low+medium+high,claude-sonnet-5-5:low+medium+high",
	codex: "gpt-6-astra:low+medium+high,gpt-6-luna:low+medium+high",
} as const;

export class ModelsUsageError extends Error {}

export function detectHarness(env: Env): keyof typeof HARNESS_PRESETS | null {
	// Codex injects this into commands, including when launched inside Claude Code.
	// Companion variables alone identify a plugin, not an active Codex harness.
	if (env.CODEX_THREAD_ID?.trim()) return "codex";
	if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT?.trim())
		return "claude-code";
	return null;
}

export function resolveModels(
	flag: string | undefined,
	env: Env,
	config: Pick<Config, "models">,
): { value: string; source: ModelsSource } {
	// Empty or blank values count as unset, so the next source applies.
	if (flag?.trim()) return { value: flag, source: "flag" };
	if (env.SPATZ_MODELS?.trim())
		return { value: env.SPATZ_MODELS, source: "env" };
	if (config.models !== undefined) {
		const { value, source } = config.models;
		if (typeof value !== "string")
			throw new ModelsUsageError(
				`${source} config: models must be a string using --models syntax`,
			);
		if (value.trim()) return { value, source };
	}
	const harness = detectHarness(env);
	if (harness)
		return { value: HARNESS_PRESETS[harness], source: `preset:${harness}` };
	throw new ModelsUsageError(
		"No candidate models found. Use --models, SPATZ_MODELS, or models in .spatz.json or ~/.spatz/config.json.",
	);
}

const SOURCE_LABELS: Record<string, string> = {
	env: "SPATZ_MODELS",
	project: ".spatz.json models",
	user: "~/.spatz/config.json models",
};

/** Names the real source in a `--models:` parse error when the list did not come from the flag. */
export function labelModelsError(
	error: unknown,
	source: ModelsSource,
): unknown {
	const label = SOURCE_LABELS[source];
	if (label && error instanceof Error && error.message.startsWith("--models:"))
		error.message = `${label}:${error.message.slice("--models:".length)}`;
	return error;
}

export function filterFamily(
	requested: RequestedModel[],
	family: string | undefined,
	aliases: Record<string, string>,
): RequestedModel[] {
	if (family === undefined) return requested;
	const provider =
		family === "claude" || family === "anthropic"
			? "anthropic"
			: family === "gpt" || family === "openai"
				? "openai"
				: null;
	if (!provider)
		throw new ModelsUsageError(
			"--family must be claude, gpt, anthropic or openai",
		);
	const filtered = requested.filter((model) =>
		toCanonicalId(model.requested_id, aliases).startsWith(`${provider}/`),
	);
	if (filtered.length === 0)
		throw new ModelsUsageError(
			`--family ${family}: no matching candidates. Set --models or a models default that includes this family.`,
		);
	return filtered;
}
