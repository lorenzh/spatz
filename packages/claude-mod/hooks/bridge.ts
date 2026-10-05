export const SCOPES = [
	"step",
	"turn",
	"subagent",
	"session",
	"escalate",
] as const;
export type Scope = (typeof SCOPES)[number];
export const MODES = ["off", "show", "apply"] as const;
export type Mode = (typeof MODES)[number];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Decision {
	suggestionId: string;
	model: string;
	effort: Effort;
	scope: Scope;
	escalated?: boolean;
	candidates?: { model: string; effort: Effort }[];
}

/** What links a suggestion to the session: passed to the CLI as flags. */
export interface Link {
	scope: Scope;
	session?: string;
	turn?: string;
	agentId?: string;
}

export interface Tokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
}

interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type Run = (
	argv: readonly string[],
	init: { timeoutMs: number },
) => Promise<ProcessResult>;

export const SUGGEST_TIMEOUT_MS = 6000;
const USAGE_TIMEOUT_MS = 2000;

// ponytail: fixed table of what each Agent-tool alias resolves to today; the
// engine offers no lookup. Update with the model catalog.
const ALIASES: Record<string, string> = {
	sonnet: "claude-sonnet-5-5",
	opus: "claude-opus-5-5",
	haiku: "claude-haiku-4-5",
	fable: "claude-fable-5-1",
};

/** The Agent tool's model field takes aliases only: the alias that resolves to exactly this id, else undefined. */
export function aliasFor(model: string): string | undefined {
	return Object.keys(ALIASES).find((alias) => ALIASES[alias] === model);
}

function claudeModel(id: unknown): string | null {
	if (typeof id !== "string" || !id.startsWith("anthropic/claude-"))
		return null;
	return id.slice("anthropic/".length).replaceAll(".", "-");
}

export async function suggest(
	run: Run,
	task: string,
	models: string[],
	link: Link,
	spatz = "spatz",
	onFailure?: (error: unknown) => void,
): Promise<Decision | null> {
	const fail = (error: unknown) => {
		try {
			onFailure?.(error);
		} catch {}
	};
	try {
		const { exitCode, stdout, stderr } = await run(
			[
				spatz,
				task,
				...(models.length ? ["--models", models.join(",")] : []),
				"--json",
				"--scope",
				link.scope,
				"--source",
				"claude-code-mod",
				...(link.session ? ["--session", link.session] : []),
				...(link.turn ? ["--turn", link.turn] : []),
				...(link.agentId ? ["--agent-id", link.agentId] : []),
			],
			{ timeoutMs: SUGGEST_TIMEOUT_MS },
		);
		if (exitCode !== 0) {
			fail(
				new Error(
					`CLI exited ${exitCode}${stderr ? `: ${stderr.slice(0, 200)}` : ""}`,
				),
			);
			return null;
		}
		const result = JSON.parse(stdout);
		const first = result?.ranking?.[0];
		const model = claudeModel(first?.model);
		if (
			typeof result?.suggestion_id !== "string" ||
			!model ||
			!(EFFORTS as readonly string[]).includes(first?.effort)
		) {
			fail(new Error("invalid suggestion response"));
			return null;
		}
		const candidates = Array.isArray(result.candidates)
			? result.candidates.flatMap(
					(pair: { model?: unknown; effort?: unknown }) => {
						const model = claudeModel(pair?.model);
						return model &&
							(EFFORTS as readonly unknown[]).includes(pair?.effort)
							? [{ model, effort: pair.effort as Effort }]
							: [];
					},
				)
			: undefined;
		return {
			...(candidates && { candidates }),
			suggestionId: result.suggestion_id,
			model,
			effort: first.effort,
			scope: link.scope,
		};
	} catch (error) {
		fail(error);
		return null;
	}
}

/** `spatz link`: gives a spawn-time suggestion the real agent id and the session. Fails open: false on any error. */
export async function linkAgent(
	run: Run,
	suggestionId: string,
	agentId: string,
	session: string | undefined,
	spatz = "spatz",
): Promise<boolean> {
	if (!session) return false;
	try {
		const { exitCode } = await run(
			[
				spatz,
				"link",
				suggestionId,
				"--agent-id",
				agentId,
				"--session",
				session,
			],
			{ timeoutMs: USAGE_TIMEOUT_MS },
		);
		return exitCode === 0;
	} catch {
		return false;
	}
}

/** `spatz usage`: tokens and the answering model of one turn (or step). Fails open: false on any error. */
export async function recordUsage(
	run: Run,
	suggestionId: string,
	model: string,
	turn: string,
	tokens: Tokens,
	spatz = "spatz",
): Promise<boolean> {
	try {
		const { exitCode } = await run(
			[
				spatz,
				"usage",
				suggestionId,
				"--model",
				model,
				"--input",
				String(tokens.input),
				"--output",
				String(tokens.output),
				"--cache-read",
				String(tokens.cacheRead),
				"--cache-creation",
				String(tokens.cacheCreation),
				"--turn",
				turn,
				"--source",
				"claude-code-mod",
				"--json",
			],
			{ timeoutMs: USAGE_TIMEOUT_MS },
		);
		return exitCode === 0;
	} catch {
		return false;
	}
}

/** Candidate pairs from "model:low+high,model2:..." weakest first: the list is strongest model first; efforts ascend. */
export function ladder(models: string[]): { model: string; effort: Effort }[] {
	return models.toReversed().flatMap((entry) => {
		const [model = "", efforts = ""] = entry.split(":");
		return efforts
			.split("+")
			.filter((e): e is Effort => (EFFORTS as readonly string[]).includes(e))
			.sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b))
			.map((effort) => ({ model, effort }));
	});
}

/** The next stronger pair after `from`, or null when it is the top or not on the ladder. */
export function stronger(
	models: string[],
	from: { model: string; effort: Effort },
): { model: string; effort: Effort } | null {
	const pairs = ladder(models);
	const at = pairs.findIndex(
		(p) => p.model === from.model && p.effort === from.effort,
	);
	return at === -1 ? null : (pairs[at + 1] ?? null);
}
