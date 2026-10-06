import type { EngineInterface, On, PluginOptions } from "claude-code";
import {
	aliasFor,
	attemptCommand,
	type Decision,
	type Link,
	linkAgent,
	type Run,
	recordUsage,
	type Scope,
	type StepUsage,
	stronger,
	suggest,
	type Tokens,
} from "./bridge.ts";
import {
	band,
	change,
	describeDecision,
	readSettings,
	USAGE,
} from "./settings.ts";

// Keyword match, as the CLI's hook parser does (packages/core/src/signals): a test or build
// command that is the last step of a plain && chain, so its exit status is the one that counts.
// ponytail: keyword regexes, not a shell parser.
const PREFIX = String.raw`^(?:\w+=\S*\s+)*(?:(?:rtk(?:\s+proxy)?|time|npx|bunx|pnpx|uv\s+run|poetry\s+run|python3?\s+-m)\s+)*`;
const TEST_OR_BUILD = new RegExp(
	String.raw`${PREFIX}(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build)|pytest|(?:go|cargo)\s+(?:test|build)|vitest|jest|tsc|make(?:\s+-\S+)*(?:\s+(?:build|all|test|check))?(?:\s+-\S+)*\s*$)(?:\s|$)`,
);
const SETUP = /^(?:cd|pushd|export)(?:\s|$)/;
// Failure text of a run that never reached the runner, as in packages/core/src/signals.
const NOT_RUN =
	/No such file or directory|[Pp]ermission denied|command not found/;
function isTestOrBuild(command: string): boolean {
	const plain = command.trim().replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
	if (/[|;&\n`]|\$\(/.test(plain.replaceAll("&&", " "))) return false;
	const segs = plain.split("&&").map((x) => x.trim());
	const last = segs.pop() ?? "";
	if (!segs.every((x) => SETUP.test(x))) return false;
	return (
		TEST_OR_BUILD.test(last) &&
		!/\s(?:--collect-only|--co|--help|-h|--version)(?:\s|$)/.test(last)
	);
}

/** An interrupted run, or an error text of a run that never started, is no failure of the tests. */
function neverRan(result: unknown): boolean {
	if (typeof result === "string") return NOT_RUN.test(result);
	const r = result as { interrupted?: boolean; stderr?: string } | null;
	return !!r && (r.interrupted === true || NOT_RUN.test(r.stderr ?? ""));
}

/** What the hooks use of `$`; a hooks module may pass `$` only to a top-level function, so helpers take this. */
interface Io {
	run: Run;
	sessionId(): Promise<string | undefined>;
	status(text: string | undefined): void;
	log(text: string): void;
	toast(text: string): void;
}

function bind($: EngineInterface, spatz: string): Io {
	const executable =
		spatz === "spatz" ? ["sh", `${$.plugin.root}/bin/spatz`] : [spatz];
	return {
		run: (argv, init) =>
			$.process.run(
				argv[0] === spatz ? [...executable, ...argv.slice(1)] : [...argv],
				// The mod always runs inside Claude Code; this keeps the CLI's harness preset working
				// even when the engine environment lacks the markers Bash children get.
				{ ...init, env: { CLAUDECODE: "1", ...init?.env } },
			),
		sessionId: () => $.session.id().catch(() => undefined),
		status: (text) => $.ui.status(text),
		toast: (text) => $.ui.toast(text),
		log: (text) => $.ui.log(text, { to: "debug" }),
	};
}

const ESCALATING: readonly Scope[] = ["escalate"];

export function register(on: On, options: PluginOptions = {}) {
	const s = readSettings(options);
	/** Subagent and escalate decisions by agent id; kept across the agent's follow-up runs. */
	const agents = new Map<string, Decision>();
	/** turn and escalate decisions by turn id (main loop). */
	const turns = new Map<string, Decision>();
	/** Task text held only for the step scope, until the turn or agent ends. */
	const prompts = new Map<string, string>();
	const requested = new Map<
		string,
		Pick<Link, "requested" | "requestedAgent">
	>();
	type Segment = Omit<StepUsage, "attempt"> & {
		attempt: Promise<string | undefined>;
		turn: string;
		model: string;
		suggestionId: string;
	};
	const active = new Map<string, Segment>();
	const failures = new Map<string, number>();
	let lastTurn: Decision | undefined;
	let sessionDecision: Decision | undefined;
	let sessionTried = false;
	let currentTurn: string | undefined;
	let last: Decision | undefined;
	let logged = false;
	const logFailure = (io: Io, error: unknown) => {
		if (logged) return;
		logged = true;
		try {
			io.log(`spatz: decision failed, routing unchanged: ${error}`);
		} catch {}
		try {
			io.toast(
				"spatz: CLI call failed, routing unchanged (details: claude --debug)",
			);
		} catch {}
	};

	const show = (io: Io) => {
		try {
			io.status(band(s, last));
		} catch {}
	};

	async function decide(
		io: Io,
		task: string,
		link: Omit<Link, "session">,
		withSession = true,
	): Promise<Decision | undefined> {
		const session = withSession ? await io.sessionId() : undefined;
		const d = await suggest(
			io.run,
			task,
			s.models,
			{ ...link, session },
			s.spatz,
			(error) => logFailure(io, error),
		);
		if (!d) return undefined;
		if (d.exploredRisky && !s.exploreHard) return undefined;
		last = d;
		show(io);
		return d;
	}

	const applies = (agentId: string | undefined) =>
		s.mode === "apply" && (agentId !== undefined || s.main);

	async function pick(
		io: Io,
		e: { turnId: string; agentId?: string },
	): Promise<Decision | undefined> {
		const key = e.agentId ?? e.turnId;
		if (s.scope === "step") {
			const task = prompts.get(key);
			return task
				? decide(io, task, {
						scope: "step",
						turn: e.turnId,
						agentId: e.agentId,
						...requested.get(key),
					})
				: undefined;
		}
		if (e.agentId)
			return s.scope === "subagent" || s.scope === "escalate"
				? agents.get(e.agentId)
				: undefined;
		if (s.scope === "session") return sessionDecision;
		return s.scope === "subagent" ? undefined : turns.get(e.turnId);
	}

	const tokens = (u: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens: number;
		cache_creation_input_tokens: number;
	}): Tokens => ({
		input: u.input_tokens,
		output: u.output_tokens,
		cacheRead: u.cache_read_input_tokens,
		cacheCreation: u.cache_creation_input_tokens,
	});

	on("session.start", async ($, e, next) => {
		const result = await next(e);
		try {
			await $.command.register({
				name: "spatz",
				description: "Show or change the spatz model routing",
				argumentHint: "[status|mode|scope|record|main]",
			});
		} catch {}
		return result;
	});

	on("command.run", { command: "spatz" }, async ($, e) => {
		const io = bind($, s.spatz);
		const args = e.args.trim();
		if (args === "" || args === "status") {
			const record = s.record === "auto" ? "auto (on)" : s.record;
			return {
				text: `spatz\nmode: ${s.mode}\nscope: ${s.scope}\nmain: ${s.main ? "on" : "off"}\nrecord: ${record}\nlast: ${describeDecision(last)}`,
			};
		}
		const answer = change(s, args);
		show(io);
		return { text: answer ?? USAGE };
	});

	on("agent.spawn", async ($, e, next) => {
		const io = bind($, s.spatz);
		if (s.mode === "off" || e.fork) return next(e);
		// An explicit model or a named agent type is the caller's choice; so are all steps of that agent.
		if (
			s.respectPinned &&
			(e.model || (e.subagentType && e.subagentType !== "general-purpose"))
		)
			return next(e);
		if (s.scope === "step") {
			const result = await next(e);
			if (result.agentId && !result.deny) {
				prompts.set(result.agentId, e.prompt);
				requested.set(result.agentId, {
					requested: e.model,
					requestedAgent: e.subagentType,
				});
			}
			return result;
		}
		if (s.scope !== "subagent" && s.scope !== "escalate") return next(e);
		// The agent id exists only after the spawn: ask without session or agent, then link.
		const d = await decide(
			io,
			e.prompt,
			{ scope: s.scope, requested: e.model, requestedAgent: e.subagentType },
			false,
		);
		if (!d) return next(e);
		const alias = s.mode === "apply" ? aliasFor(d.model) : undefined;
		const result = await next(alias ? { ...e, model: alias } : e);
		if (result.agentId && !result.deny) {
			agents.set(result.agentId, d);
			try {
				await linkAgent(
					io.run,
					d.suggestionId,
					result.agentId,
					await io.sessionId().catch(() => undefined),
					s.spatz,
				);
			} catch {}
		}
		return result;
	});

	on("turn.start", async ($, e, next) => {
		const io = bind($, s.spatz);
		currentTurn = e.turnId;
		if (s.mode !== "off") {
			try {
				if (s.scope === "step") prompts.set(e.turnId, e.text);
				else if (s.scope === "session") {
					if (!sessionTried && e.text) {
						sessionTried = true;
						sessionDecision = await decide(io, e.text, {
							scope: "session",
							turn: e.turnId,
						});
					}
				} else if (s.scope !== "subagent") {
					const long = e.text.length >= s.minPromptChars;
					const d = long
						? await decide(io, e.text, { scope: s.scope, turn: e.turnId })
						: lastTurn;
					if (long) lastTurn = d;
					if (d) turns.set(e.turnId, d);
				}
			} catch {}
		}
		return next(e);
	});

	on("turn.step", async function* ($, e, next) {
		const io = bind($, s.spatz);
		let d: Decision | undefined;
		try {
			d = s.mode === "off" ? undefined : await pick(io, e);
		} catch (error) {
			logFailure(io, error);
		}
		const sent =
			d && applies(e.agentId)
				? {
						...e,
						model: d.model,
						...(d.effort !== "none" && { effort: d.effort }),
					}
				: e;
		let identity: Segment | undefined;
		const agentKey = e.agentId ?? "";
		if (!d || s.record === "off") active.delete(agentKey);
		try {
			if (d && s.record !== "off") {
				const session = await io.sessionId();
				const key = `${e.turnId}:${e.index}`;
				const effort =
					d && applies(e.agentId) && d.effort === "none" ? "none" : sent.effort;
				if (session) {
					const previous = active.get(agentKey);
					const samePair =
						previous?.suggestionId === d.suggestionId &&
						previous.model === sent.model &&
						previous.effort === effort;
					if (!samePair) active.delete(agentKey);
					const attempt = samePair
						? previous.attempt
						: attemptCommand(
								io.run,
								[
									"start",
									d.suggestionId,
									"--key",
									key,
									"--model",
									sent.model,
									...(effort ? ["--effort", effort] : []),
									"--session",
									session,
									"--turn",
									e.turnId,
									...(e.agentId ? ["--agent-id", e.agentId] : []),
									"--owns-usage",
									"--json",
								],
								s.spatz,
							);
					identity = {
						attempt,
						key,
						session,
						agentId: e.agentId,
						effort,
						turn: e.turnId,
						model: sent.model,
						suggestionId: d.suggestionId,
					};
					active.set(agentKey, identity);
				}
			}
		} catch {}
		const result = yield* next(sent);
		try {
			const attempt = await identity?.attempt;
			if (identity && !attempt && active.get(agentKey) === identity)
				active.delete(agentKey);
			if (d && result.usage && identity && attempt) {
				await recordUsage(
					io.run,
					d.suggestionId,
					result.usage.model,
					e.turnId,
					tokens(result.usage),
					s.spatz,
					{ ...identity, attempt },
				);
			}
		} catch {}
		return result;
	});

	on("turn.complete", async ($, e, next) => {
		const io = bind($, s.spatz);
		const result = await next(e);
		const key = e.agentId ?? "";
		const identity = active.get(key);
		if (identity?.turn === e.turnId && (await identity.attempt)) {
			await attemptCommand(
				io.run,
				[
					"finalize",
					"--session",
					identity.session,
					...(e.agentId ? ["--agent-id", e.agentId] : []),
				],
				s.spatz,
			);
		}
		prompts.delete(e.turnId);
		failures.delete(e.agentId ?? e.turnId);
		return result;
	});

	on("tool.call", async ($, e, next) => {
		const io = bind($, s.spatz);
		const identity = active.get(e.agentId ?? "");
		if (identity && s.mode !== "off" && s.record !== "off")
			void identity.attempt.then(
				(attempt) =>
					attempt &&
					attemptCommand(
						io.run,
						[
							"bind",
							attempt,
							"--call",
							e.tool_use_id,
							"--session",
							identity.session,
							...(e.agentId ? ["--agent-id", e.agentId] : []),
						],
						s.spatz,
					),
			);
		const result = await next(e);
		try {
			if (
				s.mode !== "off" &&
				ESCALATING.includes(s.scope) &&
				e.tool === "Bash" &&
				result.isError &&
				isTestOrBuild(e.command) &&
				!neverRan(result.result)
			)
				escalate(io, e.agentId);
		} catch {}
		return result;
	});

	function escalate(io: Io, agentId: string | undefined) {
		const key = agentId ?? currentTurn;
		if (!key) return;
		const count = (failures.get(key) ?? 0) + 1;
		failures.set(key, count >= s.escalateAfter ? 0 : count);
		if (count < s.escalateAfter) return;
		const map = agentId ? agents : turns;
		const current = map.get(key);
		const pairs = current?.candidates ?? [];
		const at = pairs.findIndex(
			(p) => p.model === current?.model && p.effort === current?.effort,
		);
		const up =
			current &&
			(s.models.length
				? stronger(s.models, current)
				: at >= 0
					? pairs[at + 1]
					: undefined);
		if (!current || !up) return;
		const d = { ...current, ...up, escalated: true };
		map.set(key, d);
		last = d;
		show(io);
		io.toast(`spatz: escalating to ${d.model}:${d.effort}`);
	}
}
