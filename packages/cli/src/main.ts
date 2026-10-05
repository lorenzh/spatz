// Thin CLI: argument parsing (node:util parseArgs) and output formatting only. No domain logic.
// Spec: "CLI-Schnittstelle".
import { parseArgs } from "node:util";
import type {
	Outcome,
	ReportResult,
	SpatzApi,
	StatsReport,
	Suggestion,
	TaskType,
} from "@spatz/core";
import { TASK_TYPES } from "@spatz/core";
import pkg from "../package.json";

declare const SPATZ_VERSION: string | undefined;
const VERSION = typeof SPATZ_VERSION === "string" ? SPATZ_VERSION : pkg.version;

export interface CliIO {
	stdout(text: string): void;
	stderr(text: string): void;
	readStdin(): Promise<string>;
}

const USAGE = `usage:
  spatz --version
  spatz "<task>" --models <list> [--json] [--dry-run]
  spatz report <suggestion_id> --model <m> --effort <e> --result pass|partial|fail [--rounds <n>] [--note <t>] [--json]
  spatz hook <event> [--agent codex]
  spatz stats [--type <t>] [--json]`;

const RESULTS: readonly string[] = ["pass", "partial", "fail"];

/** Thrown for bad arguments; main maps it to exit 2. */
class UsageError extends Error {}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function formatSuggestion(s: Suggestion): string {
	const c = s.classification;
	return [
		`suggestion_id: ${s.suggestion_id}`,
		...s.ranking.map(
			(r, i) =>
				`${i + 1}. ${r.model}:${r.effort}  estimate=${r.estimate.toFixed(2)}  n=${r.n}`,
		),
		`reason: ${s.reason}`,
		`task_type: ${c.task_type}  difficulty: ${c.difficulty}  criticality: ${c.criticality}`,
		`explored: ${s.explored}  control: ${s.control}  fallback_used: ${s.fallback_used}${s.is_test ? "  (dry-run)" : ""}`,
	].join("\n");
}

function formatOutcome(id: string, o: Outcome | null): string {
	return o
		? `reported: ${id}  quality: ${o.quality}  pair: ${o.model ?? "-"}:${o.effort ?? "-"}`
		: `reported: ${id}`;
}

function formatStats(r: StatsReport): string {
	const lines = r.by_type.flatMap((t) => [
		`${t.task_type}  n=${t.n}  adoption=${pct(t.adoption_rate)}  input_tokens=${t.input_tokens}  output_tokens=${t.output_tokens}`,
		...t.pairs.map(
			(p) =>
				`  ${p.model}:${p.effort ?? "-"}  n=${p.n}  success=${pct(p.success_rate)}`,
		),
	]);
	const opt = (x: number | null) => (x === null ? "-" : pct(x));
	lines.push(
		`coverage: ${pct(r.coverage)}  learned_success: ${opt(r.learned_success)}  control_success: ${opt(r.control_success)}`,
	);
	return lines.join("\n");
}

function parse(argv: string[]) {
	try {
		return parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				version: { type: "boolean" },
				json: { type: "boolean" },
				models: { type: "string" },
				"dry-run": { type: "boolean" },
				model: { type: "string" },
				effort: { type: "string" },
				result: { type: "string" },
				rounds: { type: "string" },
				note: { type: "string" },
				type: { type: "string" },
			},
		});
	} catch (e) {
		throw new UsageError((e as Error).message);
	}
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new UsageError(`missing ${name}`);
	return value;
}

/** Returns the exit code. `spatz hook <event>` always returns 0. Text output of a suggestion starts with "suggestion_id: <id>". */
export async function main(
	argv: string[],
	io: CliIO,
	api: SpatzApi,
): Promise<number> {
	if (argv[0] === "hook") {
		// Hooks must never block the session: no output, always exit 0.
		try {
			const agentAt = argv.indexOf("--agent");
			const agent = agentAt >= 0 ? argv[agentAt + 1] : undefined;
			const event = argv[1] ?? "";
			const stdin = await io.readStdin();
			await api.handleHook(agent === "codex" ? `codex:${event}` : event, stdin);
		} catch {}
		return 0;
	}

	let run: () => Promise<{ result: unknown; text: () => string }>;
	let json: boolean;
	try {
		const {
			values: v,
			positionals: [cmd, ...rest],
		} = parse(argv);
		if (v.version) {
			io.stdout(VERSION);
			return 0;
		}
		json = v.json ?? false;
		if (cmd === "report") {
			const suggestionId = required(rest[0], "<suggestion_id>");
			const model = required(v.model, "--model");
			const effort = required(v.effort, "--effort");
			const result = required(v.result, "--result");
			if (!RESULTS.includes(result))
				throw new UsageError("--result must be pass, partial or fail");
			const input = {
				suggestionId,
				model,
				effort,
				result: result as ReportResult,
				...(v.rounds !== undefined && { rounds: toInt(v.rounds) }),
				...(v.note !== undefined && { note: v.note }),
			};
			run = async () => {
				const o = await api.report(input);
				return { result: o, text: () => formatOutcome(suggestionId, o) };
			};
		} else if (cmd === "stats") {
			const type = v.type;
			if (
				type !== undefined &&
				!(TASK_TYPES as readonly string[]).includes(type)
			)
				throw new UsageError(`--type must be one of ${TASK_TYPES.join(", ")}`);
			const input = type === undefined ? {} : { type: type as TaskType };
			run = async () => {
				const r = await api.stats(input);
				return { result: r, text: () => formatStats(r) };
			};
		} else {
			const task = required(cmd, '"<task>"');
			const models = required(v.models, "--models");
			const input = { task, models, dryRun: v["dry-run"] ?? false };
			run = async () => {
				const s = await api.suggest(input);
				return { result: s, text: () => formatSuggestion(s) };
			};
		}
	} catch (e) {
		if (!(e instanceof UsageError)) throw e;
		io.stderr(`spatz: ${e.message}\n${USAGE}`);
		return 2;
	}

	try {
		const { result, text } = await run();
		io.stdout(json ? JSON.stringify(result) : text());
		return 0;
	} catch (e) {
		io.stderr(`spatz: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}

function toInt(s: string): number {
	const n = Number(s);
	if (!/^\d+$/.test(s) || !Number.isSafeInteger(n))
		throw new UsageError("--rounds must be a non-negative safe integer");
	return n;
}
