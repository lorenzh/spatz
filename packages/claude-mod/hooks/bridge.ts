export interface Decision {
	suggestionId: string;
	model: string;
	effort: "low" | "medium" | "high";
	scope: string;
}

interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

type Run = (
	argv: readonly string[],
	init: { timeoutMs: number },
) => Promise<ProcessResult>;

function claudeModel(id: unknown): string | null {
	if (typeof id !== "string" || !id.startsWith("anthropic/claude-"))
		return null;
	return id.slice("anthropic/".length).replaceAll(".", "-");
}

export async function suggest(
	run: Run,
	task: string,
	models: string[],
	scope: string,
	spatz = "spatz",
): Promise<Decision | null> {
	try {
		const { exitCode, stdout } = await run(
			[spatz, task, "--models", models.join(","), "--json"],
			{ timeoutMs: 6000 },
		);
		if (exitCode !== 0) return null;
		const result = JSON.parse(stdout);
		const first = result?.ranking?.[0];
		const model = claudeModel(first?.model);
		if (
			typeof result?.suggestion_id !== "string" ||
			!model ||
			!["low", "medium", "high"].includes(first?.effort)
		)
			return null;
		return {
			suggestionId: result.suggestion_id,
			model,
			effort: first.effort,
			scope,
		};
	} catch {
		return null;
	}
}
