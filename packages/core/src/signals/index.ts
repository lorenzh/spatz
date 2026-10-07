// signals: pure interpretation of hook inputs (no IO, no persistence).
// Spec: "Hooks and signals" (Hooks, Signals, Attribution, Hook rules).
import type {
	BashToolInput,
	HookInput,
	PostToolUseFailureInput,
	PostToolUseInput,
} from "../contracts/hooks.ts";
import {
	EFFORTS,
	type Effort,
	type ReportResult,
	SIGNAL_WEIGHTS,
	type SignalRecord,
} from "../contracts/types.ts";

export type CommandKind = "test" | "build" | "spatz-suggest" | null;

/** Parses stdin JSON; null on invalid JSON or missing hook_event_name. */
export function parseHookInput(stdin: string): HookInput | null {
	try {
		const v = JSON.parse(stdin);
		return v && typeof v.hook_event_name === "string" ? v : null;
	} catch {
		return null;
	}
}

/** true for tool_name SubagentHandback and for UserPromptSubmit whose prompt starts with "<agent-message". */
export function isIgnoredHookInput(input: HookInput): boolean {
	if (input.hook_event_name === "PostToolUse")
		return input.tool_name === "SubagentHandback";
	if (input.hook_event_name === "UserPromptSubmit")
		return String(input.prompt).startsWith("<agent-message");
	return false;
}

// A command segment starts at the beginning or after ;, &, |.
const START = String.raw`(?:^|[;&|]\s*)`;
const SPATZ_SUGGEST = new RegExp(
	String.raw`${START}(?:rtk(?:\s+proxy)?\s+)?(?:(?:[^\s;&|]*/)?spatz|(?:npx(?:\s+(?:-y|--yes))?|bunx(?:\s+--bun)?|npm\s+exec)\s+@spatz/cli(?:@[0-9A-Za-z.+_-]+)?(?:\s+--)?)\s+(?!(?:report|hook|stats|usage|link|import-rollout|attempt|pending|signal)(?:\s|$)|-)\S`,
);
// ponytail: keyword regexes, not a shell parser; extend the lists when a tool is missed.
// Each matches only at the command position of a segment: after env assignments and runner prefixes.
const PREFIX = String.raw`^(?:\w+=\S*\s+)*(?:(?:rtk(?:\s+proxy)?|time|npx|bunx|pnpx|uv\s+run|poetry\s+run|python3?\s+-m)\s+)*`;
const TEST = new RegExp(
	String.raw`${PREFIX}(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test|pytest|(?:go|cargo)\s+test|vitest|jest|make(?:\s+-\S+)*\s+(?:test|check))(?:\s|$)`,
);
const BUILD = new RegExp(
	String.raw`${PREFIX}(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build|tsc|(?:go|cargo)\s+build|make(?:\s+-\S+)*(?:\s+(?:build|all))?(?:\s+-\S+)*\s*$)(?:\s|$)`,
);

/** Quoted strings become '' (their text is an argument, never a command); fd redirections like 2>&1 are dropped. */
const unquote = (command: string) =>
	command
		.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")
		.replace(/\d*>&\d*|&>/g, " ");

// Runs that only list or print help never execute the tests.
const NO_RUN = /\s(?:--collect-only|--co|--help|-h|--version)(?:\s|$)/;
// Failure text of a run that never reached the runner (bad cd, missing or non-executable binary).
const NOT_RUN =
	/No such file or directory|[Pp]ermission denied|command not found/;

// Setup that may precede the test/build in an && chain without producing the exit status of interest.
const SETUP = /^(?:cd|pushd|export)(?:\s|$)/;

/**
 * Regex classification of a Bash command. A spatz suggest call ("spatz <task>", not report/hook/stats/usage) wins.
 * Test or build count only when the exit status is theirs: the last segment of a plain && chain, after setup segments only.
 * Pipes, ||, ;, &, newlines and command substitution make the status ambiguous -> null.
 */
export function detectCommandKind(command: string): CommandKind {
	const plain = unquote(command.trim());
	// Preserve quoted executable paths and subcommands without exposing quoted shell syntax.
	const suggestion = command
		.trim()
		.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (quoted) => {
			const value = quoted.slice(1, -1);
			if (
				/^(?:report|hook|stats|usage|link|import-rollout|attempt|pending|signal)$/.test(
					value,
				)
			)
				return value;
			return /^[^"'`;|&\n()]+\/spatz$/.test(value) ? "spatz" : "''";
		});
	if (SPATZ_SUGGEST.test(suggestion)) return "spatz-suggest";
	if (/[|;&\n`]|\$\(/.test(plain.replaceAll("&&", " "))) return null;
	const segs = plain.split("&&").map((s) => s.trim());
	const last = segs.pop() ?? "";
	if (!segs.every((s) => SETUP.test(s))) return null;
	if (NO_RUN.test(last)) return null;
	return TEST.test(last) ? "test" : BUILD.test(last) ? "build" : null;
}

const SUGGESTION_ID =
	/"?suggestion_id"?\s*:\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/** Finds the suggestion id in spatz output: text line "suggestion_id: <uuid>" or JSON "suggestion_id": "<uuid>". */
export function extractSuggestionId(stdout: string): string | null {
	return SUGGESTION_ID.exec(stdout)?.[1] ?? null;
}

/** Bash test/build -> signal: PostToolUse value 1, PostToolUseFailure value 0; weight from SIGNAL_WEIGHTS. null for other commands/tools. */
export function signalFromBashEvent(
	input: PostToolUseInput | PostToolUseFailureInput,
	suggestionId: string,
	at: number,
): SignalRecord | null {
	if (input.tool_name !== "Bash") return null;
	const command = (input.tool_input as BashToolInput | null)?.command;
	if (typeof command !== "string") return null;
	const kind = detectCommandKind(command);
	if (kind !== "test" && kind !== "build") return null;
	const failed = input.hook_event_name === "PostToolUseFailure";
	if (
		failed &&
		((input as PostToolUseFailureInput).is_interrupt ||
			NOT_RUN.test((input as PostToolUseFailureInput).error))
	)
		return null;
	return {
		suggestion_id: suggestionId,
		kind,
		value: failed ? 0 : 1,
		weight: SIGNAL_WEIGHTS[kind],
		source: input.hook_event_name,
		observed_at: at,
	};
}

/** effort.level -> Effort, or null when missing or not one of EFFORTS. */
export function effortFromHook(input: HookInput): Effort | null {
	const level = input.effort?.level;
	return EFFORTS.find((e) => e === level) ?? null;
}

// ---------- Work-result signals: pull requests ----------

export interface PrInfo {
	/** GitHub state: OPEN, CLOSED or MERGED. */
	state: string;
	body: string;
	/** Full commit messages. */
	commits: string[];
	/** Check conclusions or states, e.g. SUCCESS, FAILURE. Empty when the repo has no checks. */
	checks: string[];
}

export type ReviewVerdict = "approve" | "changes" | "blocker";
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
	"approve",
	"changes",
	"blocker",
];
const REVIEW_RESULT = {
	approve: "pass",
	changes: "partial",
	blocker: "fail",
} as const;

const TRAILER =
	/^Spatz-Suggestion:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im;

/** The suggestion id of a `Spatz-Suggestion: <id>` trailer in the PR body, else in a commit message. */
export function suggestionFromPr(pr: PrInfo): string | null {
	for (const text of [pr.body, ...pr.commits]) {
		const id = TRAILER.exec(text)?.[1];
		if (id) return id.toLowerCase();
	}
	return null;
}

const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Merged with green checks (or no checks) -> pass; merged with other checks -> partial; closed unmerged -> fail.
 * An open PR has no result yet, except through a review verdict: approve pass, changes partial, blocker fail.
 */
export function resultFromPr(
	pr: PrInfo,
	review?: ReviewVerdict,
): ReportResult | null {
	if (pr.state === "MERGED")
		return pr.checks.every((c) => GREEN.has(c)) ? "pass" : "partial";
	if (pr.state === "CLOSED") return "fail";
	return review ? REVIEW_RESULT[review] : null;
}
