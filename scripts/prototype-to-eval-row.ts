// Converts prototype bench result lines (JSONL) to spatz-eval-row/1 rows; rejected lines go to stderr.
// Usage: bun scripts/prototype-to-eval-row.ts <results.jsonl> <harness>
import { toCanonicalId } from "../packages/core/src/catalog/index.ts";
import { parseEvalRow } from "../packages/core/src/index.ts";

type Line = Record<string, any>;
const NO_USAGE = {
	input: null,
	output: null,
	cache_read: null,
	cache_write: null,
	reasoning: null,
};

function tokens(p: Line) {
	const t = p.tokens,
		u = p.usage;
	if (u?.input_tokens != null)
		return {
			input: u.input_tokens - (u.cached_input_tokens ?? 0),
			output: u.output_tokens,
			cache_read: u.cached_input_tokens ?? null,
			cache_write: u.cache_write_input_tokens ?? null,
			reasoning: u.reasoning_output_tokens ?? null,
		};
	if (t?.input != null)
		return {
			input: t.input,
			output: t.output,
			cache_read: t.cache_read ?? null,
			cache_write: t.cache_create ?? null,
			reasoning: t.thinking ?? null,
		};
	return NO_USAGE;
}

export function toEvalRow(p: Line, harness: string) {
	const tok = tokens(p);
	return {
		schema: "spatz-eval-row/1",
		run_id: crypto.randomUUID(),
		bench_version: "prototype",
		task_id: p.task,
		task_version: 1,
		task_type: p.type,
		difficulty: p.difficulty,
		harness,
		agent_version: "unknown",
		model: toCanonicalId(p.model, {}),
		effort: p.effort,
		answered_model: p.model_answered ?? p.answering_model?.model ?? null,
		model_version: null,
		attempt: 1,
		result: p.result === "PASS" ? "pass" : "fail",
		check: "tests",
		judge: null,
		duration_s: p.wall_s ?? p.wall_seconds,
		tokens: tok,
		cost_usd: tok === NO_USAGE ? null : (p.cost_usd ?? null),
		started_at: new Date(p.started ?? p.started_at).toISOString(),
		contributor: "anon-proto",
		verified: true,
	};
}

if (import.meta.main) {
	const [file, harness] = Bun.argv.slice(2) as [string, string];
	for (const line of (await Bun.file(file).text())
		.split("\n")
		.filter(Boolean)) {
		const p = JSON.parse(line),
			row = parseEvalRow(toEvalRow(p, harness));
		if (row) console.log(JSON.stringify(row));
		else console.error(`rejected: ${p.task}`);
	}
}
