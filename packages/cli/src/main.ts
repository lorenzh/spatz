// Thin CLI: argument parsing (node:util parseArgs) and output formatting only. No domain logic.
// Spec: "CLI interface".
import { parseArgs } from "node:util";
import type {
	Agent,
	Outcome,
	ReportResult,
	RoutingScope,
	SpatzApi,
	StatsReport,
	Suggestion,
	TaskType,
} from "@spatz/core";
import { AGENTS, ModelsUsageError, SCOPES, TASK_TYPES } from "@spatz/core";
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
  spatz "<task>" [--models <list>] [--family <claude|gpt>] [--json] [--dry-run] [--scope <scope>] [--session <id>] [--turn <id>] [--agent-id <id>] [--source <agent>]
  spatz report <suggestion_id> --model <m> --effort <e> --result pass|partial|fail [--rounds <n>] [--note <t>] [--turn <id> --source claude-code-mod] [--json]
  spatz usage <suggestion_id> --model <m> [--effort <e>] --input <n> --output <n> --cache-read <n> --cache-creation <n> --turn <id> --source claude-code-mod [--json]
  spatz hook <event> [--agent codex]
  spatz link <suggestion_id> --agent-id <id> --session <id> [--json]
  spatz stats [--type <t>] [--by scope] [--json]`;

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
	const diagnostics = [
		`fallbacks: ${
			Object.entries(r.fallbacks)
				.map(([reason, n]) => `${reason}=${n}`)
				.join("  ") || "-"
		}`,
		`failures: parse=${r.failures.parse}  hook=${r.failures.hook}  launcher=${r.failures.launcher}`,
	];
	if (r.by_scope)
		return r.by_scope
			.map(
				(s) =>
					`${s.scope ?? "unscoped"}  n=${s.n}  success=${s.success_rate === null ? "-" : pct(s.success_rate)}  input_tokens=${s.input_tokens}  output_tokens=${s.output_tokens}  cache_read_tokens=${s.cache_read_tokens}  cache_creation_tokens=${s.cache_creation_tokens}  cache_read_share=${pct(s.cache_read_share)}`,
			)
			.concat(diagnostics)
			.join("\n");
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
	return [...lines, ...diagnostics].join("\n");
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
				family: { type: "string" },
				"dry-run": { type: "boolean" },
				model: { type: "string" },
				effort: { type: "string" },
				result: { type: "string" },
				rounds: { type: "string" },
				note: { type: "string" },
				type: { type: "string" },
				scope: { type: "string" },
				session: { type: "string" },
				turn: { type: "string" },
				"agent-id": { type: "string" },
				source: { type: "string" },
				input: { type: "string" },
				output: { type: "string" },
				"cache-read": { type: "string" },
				"cache-creation": { type: "string" },
				by: { type: "string" },
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
		if (cmd === "usage") {
			if (v.source !== "claude-code-mod")
				throw new UsageError("--source must be claude-code-mod");
			const input = {
				suggestionId: required(rest[0], "<suggestion_id>"),
				model: required(v.model, "--model"),
				...(v.effort !== undefined && { effort: v.effort }),
				input: toInt(required(v.input, "--input"), "--input"),
				output: toInt(required(v.output, "--output"), "--output"),
				cacheRead: toInt(
					required(v["cache-read"], "--cache-read"),
					"--cache-read",
				),
				cacheCreation: toInt(
					required(v["cache-creation"], "--cache-creation"),
					"--cache-creation",
				),
				turn: required(v.turn, "--turn"),
				source: "claude-code-mod" as const,
			};
			run = async () => ({
				result: await api.usage(input),
				text: () =>
					`usage recorded: ${input.suggestionId}  turn: ${input.turn}`,
			});
		} else if (cmd === "link") {
			const input = {
				suggestionId: required(rest[0], "<suggestion_id>"),
				agentId: required(v["agent-id"], "--agent-id"),
				session: required(v.session, "--session"),
			};
			run = async () => {
				await api.link(input);
				return {
					result: {
						suggestion_id: input.suggestionId,
						agent_id: input.agentId,
					},
					text: () => `linked: ${input.suggestionId}  agent: ${input.agentId}`,
				};
			};
		} else if (cmd === "report") {
			const suggestionId = required(rest[0], "<suggestion_id>");
			const model = required(v.model, "--model");
			const effort = required(v.effort, "--effort");
			const result = required(v.result, "--result");
			if (!RESULTS.includes(result))
				throw new UsageError("--result must be pass, partial or fail");
			if (
				(v.source !== undefined || v.turn !== undefined) &&
				(v.source !== "claude-code-mod" || !v.turn?.trim())
			)
				throw new UsageError(
					"direct report needs --turn and --source claude-code-mod",
				);
			const input = {
				...(v.source && { source: "claude-code-mod" as const, turn: v.turn }),
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
			if (v.by !== undefined && v.by !== "scope")
				throw new UsageError("--by must be scope");
			const input = {
				...(type && { type: type as TaskType }),
				...(v.by && { by: "scope" as const }),
			};
			run = async () => {
				const r = await api.stats(input);
				return { result: r, text: () => formatStats(r) };
			};
		} else {
			const task = required(cmd, '"<task>"');
			if (
				v.scope !== undefined &&
				!(SCOPES as readonly string[]).includes(v.scope)
			)
				throw new UsageError(`--scope must be one of ${SCOPES.join(", ")}`);
			if (
				v.source !== undefined &&
				!(AGENTS as readonly string[]).includes(v.source)
			)
				throw new UsageError(`--source must be one of ${AGENTS.join(", ")}`);
			const input = {
				task,
				...(v.models !== undefined && { models: v.models }),
				...(v.family !== undefined && { family: v.family }),
				dryRun: v["dry-run"] ?? false,
				...(v.scope !== undefined && { scope: v.scope as RoutingScope }),
				...(v.source !== undefined && { source: v.source as Agent }),
				...(v.session !== undefined && {
					session: required(v.session, "--session"),
				}),
				...(v.turn !== undefined && { turn: required(v.turn, "--turn") }),
				...(v["agent-id"] !== undefined && {
					agentId: required(v["agent-id"], "--agent-id"),
				}),
			};
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
		if (e instanceof ModelsUsageError) {
			io.stderr(`spatz: ${e.message}\n${USAGE}`);
			return 2;
		}
		io.stderr(`spatz: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}

function toInt(s: string, flag = "--rounds"): number {
	const n = Number(s);
	if (!/^\d+$/.test(s) || !Number.isSafeInteger(n))
		throw new UsageError(`${flag} must be a non-negative safe integer`);
	return n;
}
