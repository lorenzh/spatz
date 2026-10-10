// api: production wiring and config loading.
import { homedir } from "node:os";
import { join } from "node:path";
import { createJevClient } from "../classify/index.ts";
import type { CoreDeps, Env } from "../contracts/deps.ts";
import { type Config, DEFAULT_TUNING } from "../contracts/types.ts";
import { openStore } from "../store/index.ts";

/** Real deps: homeDir from env HOME, dbPath ~/.spatz/spatz.db, global fetch, Jev client only when TYPESAFE_AI_API_KEY is set, Date.now, Math.random, crypto.randomUUID, openStore. */
export function defaultDeps(env: Env, cwd: string): CoreDeps {
	const homeDir = env.HOME || homedir();
	const spatzDir = join(homeDir, ".spatz");
	const key = env.TYPESAFE_AI_API_KEY;
	return {
		env,
		homeDir,
		cwd,
		dbPath: join(spatzDir, "spatz.db"),
		openRouterCachePath: join(spatzDir, "openrouter-models.json"),
		fetch: (input, init) => fetch(input, init),
		jev: key ? createJevClient(key) : null,
		clock: { now: Date.now },
		random: Math.random,
		newId: () => crypto.randomUUID(),
		openStore,
	};
}

/** Parsed JSON object from the file, or null when missing, unreadable or not an object. */
async function readJsonObject(
	path: string,
): Promise<Record<string, unknown> | null> {
	try {
		const v = await Bun.file(path).json();
		return v && typeof v === "object" && !Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

/** Keeps only string values (the files map an id to an id or a description). */
const strings = (o: Record<string, unknown> | null): Record<string, string> =>
	Object.fromEntries(
		Object.entries(o ?? {}).filter(
			(e): e is [string, string] => typeof e[1] === "string",
		),
	);

/** `{"bench": {"use": true|false}}`; undefined when the file does not set it. */
const benchUse = (o: Record<string, unknown> | null): boolean | undefined => {
	const bench = o?.bench as Record<string, unknown> | undefined;
	return typeof bench?.use === "boolean" ? bench.use : undefined;
};

/** `{"bench": {"snapshot": true|false}}`; undefined when the file does not set it. */
const benchSnapshot = (
	o: Record<string, unknown> | null,
): boolean | undefined => {
	const bench = o?.bench as Record<string, unknown> | undefined;
	return typeof bench?.snapshot === "boolean" ? bench.snapshot : undefined;
};

/** `{"bench": {"prior_weight": <number >= 0>}}`; undefined when the file does not set a valid one. */
const priorWeight = (o: Record<string, unknown> | null): number | undefined => {
	const w = (o?.bench as Record<string, unknown> | undefined)?.prior_weight;
	return typeof w === "number" && Number.isFinite(w) && w >= 0 ? w : undefined;
};

/** DEFAULT_TUNING; jevEnabled false when env SPATZ_NO_JEV=1 or <cwd>/.spatz.json has {"jev": false}; aliases/descriptions from ~/.spatz/*.json (missing file -> {}); bench.use, bench.snapshot and bench.prior_weight from .spatz.json, else ~/.spatz/config.json, else false, true and 6. */
export async function loadConfig(
	deps: Pick<CoreDeps, "env" | "homeDir" | "cwd">,
): Promise<Config> {
	const spatzDir = join(deps.homeDir, ".spatz");
	const [project, user, aliases, descriptions] = await Promise.all([
		readJsonObject(join(deps.cwd, ".spatz.json")),
		readJsonObject(join(spatzDir, "config.json")),
		readJsonObject(join(spatzDir, "aliases.json")),
		readJsonObject(join(spatzDir, "descriptions.json")),
	]);
	return {
		...(project?.models !== undefined
			? { models: { value: project.models, source: "project" as const } }
			: user?.models !== undefined
				? { models: { value: user.models, source: "user" as const } }
				: {}),
		jevEnabled:
			deps.env.SPATZ_NO_NETWORK !== "1" &&
			deps.env.SPATZ_NO_JEV !== "1" &&
			project?.jev !== false,
		tuning: {
			...DEFAULT_TUNING,
			familyPooling: deps.env.SPATZ_FAMILY_POOLING === "1",
			priorWeight:
				priorWeight(project) ?? priorWeight(user) ?? DEFAULT_TUNING.priorWeight,
		},
		aliases: strings(aliases),
		descriptions: strings(descriptions),
		benchUse: benchUse(project) ?? benchUse(user) ?? false,
		benchSnapshot: benchSnapshot(project) ?? benchSnapshot(user) ?? true,
	};
}
