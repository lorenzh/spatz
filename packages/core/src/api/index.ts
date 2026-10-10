// api: use cases suggest, usage, report, handleHook, stats. Orchestrates the modules; the CLI calls only this.
// Spec: "CLI interface", "Flow", "Attribution", "Used pair", "Privacy".
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	formatHarnessModels,
	type Harness,
	loadHarnessCatalog,
} from "../catalog/harness.ts";
import {
	buildCatalog,
	modelVersion,
	parseModelsArg,
	toCanonicalId,
} from "../catalog/index.ts";
import { loadOpenRouterModels } from "../catalog/openrouter.ts";
import {
	filterFamily,
	labelModelsError,
	resolveModels,
} from "../catalog/presets.ts";
import {
	loadSnapshot,
	priorCells,
	snapshotAgeDays,
} from "../catalog/snapshot.ts";
import { classify } from "../classify/index.ts";
import type { AttemptEvent } from "../contracts/attempts.ts";
import type { CoreDeps, SpatzApi, Store } from "../contracts/deps.ts";
import {
	type EvalRow,
	evalRowError,
	parseEvalRow,
} from "../contracts/eval-row.ts";
import type {
	AgentToolResponse,
	BashToolInput,
	BashToolResponse,
	CodexHookInput,
	HookInput,
} from "../contracts/hooks.ts";
import {
	AGENTS,
	type Config,
	EFFORTS,
	type Effort,
	REPORT_VALUES,
	SCOPES,
	SIGNAL_WEIGHTS,
	type StatsReport,
	TASK_FAMILY,
	TASK_TYPES,
	type UsageRecord,
} from "../contracts/types.ts";
import { closeOnEnd, fromClaudeHook, fromCodexHook } from "../events/index.ts";
import { recommend } from "../recommend/index.ts";
import type { StatsOptions } from "../report/index.ts";
import {
	detectCommandKind,
	effortFromHook,
	extractSuggestionId,
	isIgnoredHookInput,
	type PrInfo,
	parseHookInput,
	resultFromPr,
	signalFromBashEvent,
	suggestionFromPr,
} from "../signals/index.ts";
import {
	type CodexRollout,
	mainTurnMessages,
	parseCodexRollout,
	parseCodexRollouts,
	subagentMessages,
} from "../signals/transcript.ts";
import { loadConfig } from "./deps.ts";

export interface ApiInternals {
	/** Test seam. Default: report module, imported lazily so it loads only for stats. */
	runStats?: (options: StatsOptions) => Promise<StatsReport>;
	/** Test seam. Default: `gh pr view` (needs the GitHub CLI and its login). */
	fetchPr?: (url: string) => Promise<PrInfo>;
}

async function ghPr(url: string): Promise<PrInfo> {
	const out =
		await Bun.$`gh pr view ${url} --json state,body,commits,statusCheckRollup`.text();
	const pr = JSON.parse(out) as {
		state: string;
		body: string;
		commits: { messageHeadline: string; messageBody: string }[];
		statusCheckRollup: {
			conclusion?: string;
			state?: string;
			status?: string;
		}[];
	};
	return {
		state: pr.state,
		body: pr.body ?? "",
		commits: pr.commits.map((c) => `${c.messageHeadline}\n\n${c.messageBody}`),
		// A run that has not finished has no conclusion: not green.
		checks: pr.statusCheckRollup.map(
			(c) => c.conclusion || c.state || c.status || "PENDING",
		),
	};
}

/** A JSON Lines file, a run directory with rows.jsonl, or a directory of runs (runs/<id>/rows.jsonl). */
function evalFiles(path: string): string[] {
	if (!statSync(path).isDirectory()) return [path];
	const own = join(path, "rows.jsonl");
	if (existsSync(own)) return [own];
	const files = readdirSync(path)
		.sort()
		.map((run) => join(path, run, "rows.jsonl"))
		.filter((file) => existsSync(file));
	if (!files.length) throw new Error(`no rows.jsonl in ${path}`);
	return files;
}

/** Valid rows with their optional task_hash, and the rejected lines with a reason. */
async function readEvalFile(file: string) {
	const rows: { row: EvalRow; task_hash: string | null }[] = [];
	const rejected: { line: number; reason: string }[] = [];
	(await Bun.file(file).text()).split("\n").forEach((text, i) => {
		if (!text.trim()) return;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			rejected.push({ line: i + 1, reason: "invalid JSON" });
			return;
		}
		const reason = evalRowError(value);
		if (reason) {
			rejected.push({ line: i + 1, reason });
			return;
		}
		// task_hash is not part of spatz-eval-row/1; keep it when the bench sends one.
		const hash = (value as { task_hash?: unknown }).task_hash;
		rows.push({
			row: parseEvalRow(value) as EvalRow,
			task_hash: typeof hash === "string" && hash ? hash : null,
		});
	});
	// A run folder's id: the first 12 hex digits of the SHA-256 of its sorted row run_ids. The snapshot lists runs by it.
	const source_run = createHash("sha256")
		.update(
			rows
				.map((r) => r.row.run_id)
				.sort()
				.join("\n"),
		)
		.digest("hex")
		.slice(0, 12);
	return {
		file,
		rows: rows.map((r) => ({ ...r, source_run })),
		rejected,
	};
}

/** Missing, unreadable or malformed transcripts count as an empty parse. */
async function readTranscript<T>(
	path: string,
	parse: (text: string) => T,
): Promise<T | null> {
	try {
		return parse(await Bun.file(path).text());
	} catch {
		return null;
	}
}

export function createApi(
	deps: CoreDeps,
	internals: ApiInternals = {},
): SpatzApi {
	let config: Promise<Config> | undefined;
	const snapshotCachePath = join(deps.homeDir, ".spatz", "bench-snapshot.json");
	const getConfig = () =>
		(config ??= deps.config ? Promise.resolve(deps.config) : loadConfig(deps));
	const debugHook = (message: string) => {
		if (deps.env.SPATZ_DEBUG === "1") console.error(`spatz hook: ${message}`);
	};
	async function cachedHarnessCatalog() {
		const cfg = await getConfig();
		// Recording and explicit lists use the available cache/bundle without a network request.
		return loadHarnessCatalog({
			fetch: deps.fetch,
			env: { ...deps.env, SPATZ_NO_NETWORK: "1" },
			cachePath: join(deps.homeDir, ".spatz", "harness-models.json"),
			clock: deps.clock,
			ttlMs: cfg.tuning.openRouterCacheMs,
		});
	}
	async function availableEfforts() {
		const cfg = await getConfig();
		const catalog = await cachedHarnessCatalog();
		const byModel = new Map<string, Effort[]>();
		for (const harness of Object.values(catalog.harnesses))
			for (const model of harness.models) {
				const id = toCanonicalId(model.id, cfg.aliases);
				byModel.set(id, [...(byModel.get(id) ?? []), ...model.efforts]);
			}
		return byModel;
	}
	const noneOnly = (available: Map<string, Effort[]>) =>
		[...available]
			.filter(([, efforts]) => efforts.every((e) => e === "none"))
			.map(([model]) => model);
	async function validateNone(models: string[]) {
		if (!models.length) return;
		const cfg = await getConfig();
		const available = await availableEfforts();
		for (const model of models) {
			const efforts = available.get(toCanonicalId(model, cfg.aliases));
			if (efforts?.some((e) => e !== "none"))
				throw new Error(
					`none is not supported for ${model}; use a catalog effort: ${efforts.join(", ")}`,
				);
		}
	}

	/** One store handle per use case; each spatz call is its own process. */
	async function withStore<T>(
		fn: (store: Store) => T | Promise<T>,
	): Promise<T> {
		const noneOnlyModels = noneOnly(await availableEfforts());
		const store = deps.openStore(deps.dbPath, noneOnlyModels);
		try {
			return await fn(store);
		} finally {
			store.dispose();
		}
	}

	async function dispatchModel(model: unknown): Promise<string | null> {
		if (
			typeof model !== "string" ||
			!model.trim() ||
			model === "-" ||
			model === "inherit"
		)
			return null;
		const cfg = await getConfig();
		const catalog = await cachedHarnessCatalog();
		const alias = catalog.harnesses["claude-code"].models
			.filter((m) => m.id.startsWith(`claude-${model}-`))
			.sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }))[0];
		return toCanonicalId(model, cfg.aliases) !== model
			? toCanonicalId(model, cfg.aliases)
			: toCanonicalId(alias?.id ?? model, cfg.aliases);
	}

	/** Resolve the caller's pin before routing; project definitions override user definitions. */
	async function requestedDispatchModel(
		model: unknown,
		agentType: unknown,
		cwd = deps.cwd,
	): Promise<string | null> {
		const explicit = await dispatchModel(model);
		if (explicit) return explicit;
		// ponytail: local agent files only; add plugin discovery when plugin pins are needed.
		if (typeof agentType !== "string" || !/^[a-zA-Z0-9_-]+$/.test(agentType))
			return null;
		for (const agents of [
			join(cwd, ".claude", "agents"),
			join(
				deps.env.CLAUDE_CONFIG_DIR || join(deps.homeDir, ".claude"),
				"agents",
			),
		]) {
			let text: string;
			try {
				text = await Bun.file(join(agents, `${agentType}.md`)).text();
			} catch {
				continue;
			}
			try {
				const header = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
					text,
				)?.[1];
				if (header === undefined) return null;
				const definition = Bun.YAML.parse(header);
				return await dispatchModel(
					definition && typeof definition === "object" && "model" in definition
						? definition.model
						: null,
				);
			} catch {
				return null;
			}
		}
		return null;
	}

	async function onHook(input: HookInput, cfg: Config): Promise<void> {
		if (isIgnoredHookInput(input)) return;
		const now = deps.clock.now();
		const context = {
			harness: "claude-code",
			session_key: input.session_id,
			agent_key: input.agent_id ?? "",
		};
		const sub = !!input.agent_id;
		const path =
			input.hook_event_name === "SubagentStop"
				? input.agent_transcript_path
				: input.transcript_path;
		const messages =
			(await readTranscript(path, (text) =>
				sub
					? subagentMessages(text)
					: mainTurnMessages(text, input.prompt_id ?? ""),
			)) ?? [];
		return withStore(async (store) => {
			const ownsUsage = store.attemptOwnsUsage(context);
			const effort = sub || ownsUsage ? null : effortFromHook(input);
			const events: AttemptEvent[] = [];
			for (const message of messages) {
				const base = {
					...context,
					prompt_id: message.prompt_id ?? input.prompt_id ?? null,
					message_id: message.id,
					source_seq: message.source_seq,
					occurred_at: Number.isFinite(message.at) ? message.at : null,
					received_at: now,
					model: toCanonicalId(message.model, cfg.aliases),
					model_version: modelVersion(message.model),
					effort,
					revision: 0,
				};
				if (
					!ownsUsage &&
					(input.hook_event_name === "Stop" ||
						input.hook_event_name === "SubagentStop")
				)
					events.push({
						...base,
						event_id: `message:${message.id}`,
						kind: "usage",
						source: sub ? "subagent" : "transcript",
						call_id: message.calls[0]?.id ?? null,
						input_tokens: message.usage.input_tokens ?? null,
						output_tokens: message.usage.output_tokens ?? null,
						cache_read_tokens: message.usage.cache_read_input_tokens ?? null,
						cache_creation_tokens:
							message.usage.cache_creation_input_tokens ?? null,
					});
				for (const call of message.calls)
					if (call.name === "Agent")
						events.push({
							...base,
							event_id: `delegate:${call.id}`,
							kind: "delegate",
							call_id: call.id,
						});
			}
			if (
				input.hook_event_name === "PostToolUse" ||
				input.hook_event_name === "PostToolUseFailure"
			) {
				const message = messages.find((m) =>
					m.calls.some((call) => call.id === input.tool_use_id),
				);
				if (
					input.hook_event_name === "PostToolUse" &&
					input.tool_name === "Agent"
				) {
					const response = input.tool_response as AgentToolResponse | null;
					if (typeof response?.agentId === "string" && response.agentId) {
						const requested = input.tool_input as {
							model?: unknown;
							subagent_type?: unknown;
						} | null;
						store.upsertDispatch({
							session_id: input.session_id,
							agent_id: response.agentId,
							tool_use_id: input.tool_use_id,
							requested_model: await requestedDispatchModel(
								requested?.model,
								requested?.subagent_type,
								input.cwd,
							),
							requested_agent_type:
								typeof requested?.subagent_type === "string"
									? requested.subagent_type
									: null,
							answered_model: await dispatchModel(response.resolvedModel),
							suggestion_id: null,
						});
					}
				}
				if (input.tool_name === "Bash") {
					const command =
						(input.tool_input as BashToolInput | null)?.command ?? "";
					if (
						input.hook_event_name === "PostToolUse" &&
						detectCommandKind(command) === "spatz-suggest"
					) {
						const id = extractSuggestionId(
							(input.tool_response as BashToolResponse | null)?.stdout ?? "",
						);
						if (id) {
							store.linkSession(
								id,
								input.session_id,
								input.prompt_id ?? null,
								store.getSuggestion(id)?.created_at ?? now,
								input.agent_id,
							);
							store.reconcileAttempts(context, cfg.tuning.openWindowMs);
						}
					} else {
						const signal = signalFromBashEvent(input, "", now);
						if (signal)
							events.push({
								...context,
								event_id: `call:${input.tool_use_id}:${signal.kind}`,
								revision: message ? 1 : 0,
								prompt_id: message?.prompt_id ?? input.prompt_id ?? null,
								call_id: input.tool_use_id,
								message_id: message?.id ?? null,
								source_seq: message?.source_seq ?? null,
								occurred_at:
									message && Number.isFinite(message.at) ? message.at : null,
								received_at: now,
								model: message
									? toCanonicalId(message.model, cfg.aliases)
									: null,
								model_version: message ? modelVersion(message.model) : null,
								effort,
								kind: signal.kind as "test" | "build",
								value: signal.value,
								weight: signal.weight,
								source: input.hook_event_name,
							});
					}
				}
			}
			if (events.length)
				store.recordAttemptEvents(events, cfg.tuning.openWindowMs);
			if (
				input.hook_event_name === "Stop" ||
				input.hook_event_name === "SubagentStop"
			) {
				const times = messages.map((m) => m.at).filter(Number.isFinite);
				if (times.length)
					store.finalizeAttempts(
						context,
						Math.max(...times),
						cfg.tuning.successQuality,
					);
				else
					store.recordFailure(
						"parse",
						input.hook_event_name,
						now,
						input.session_id,
						input.agent_id ?? input.prompt_id ?? null,
					);
				const ended = fromClaudeHook(input);
				if (ended) closeOnEnd(store, ended, now);
			}
		});
	}

	/** Keep calls and the final cumulative measurement together for atomic reconciliation. */
	function recordCodexTurn(
		store: Store,
		cfg: Config,
		suggestionId: string | null,
		turnId: string,
		rollout: CodexRollout,
		sessionId?: string,
	) {
		const now = deps.clock.now();
		const context = {
			harness: "codex",
			session_key:
				rollout.session_id ??
				(suggestionId ? `suggestion:${suggestionId}` : (sessionId ?? "")),
			agent_key: "",
		};
		if (suggestionId) {
			const attempts = rollout.segments.map((segment) => ({
				segment,
				attempt: store.startAttempt({
					...context,
					suggestion_id: suggestionId,
					key: `dispatch:${context.session_key}:${segment.key}`,
					model: toCanonicalId(segment.model, cfg.aliases),
					effort: EFFORTS.find((e) => e === segment.effort) ?? null,
					at:
						segment.at ?? store.getSuggestion(suggestionId)?.created_at ?? now,
				}),
			}));
			for (const { attempt } of attempts)
				store.bindAttempt({
					...context,
					attempt_id: attempt.id,
					id_kind: "turn",
					external_id: turnId,
				});
			for (const call of rollout.calls) {
				const owner = attempts.findLast(
					({ segment }) => segment.source_seq <= call.source_seq,
				);
				if (owner)
					store.bindAttempt({
						...context,
						attempt_id: owner.attempt.id,
						id_kind: "call",
						external_id: call.id,
					});
			}
		}
		const events: AttemptEvent[] = [];
		for (const call of rollout.calls) {
			const kind = detectCommandKind(call.command);
			if (kind !== "test" && kind !== "build") continue;
			events.push({
				...context,
				event_id: call.id,
				revision: 0,
				turn_id: turnId,
				call_id: call.id,
				source_seq: call.source_seq,
				occurred_at: call.at,
				received_at: now,
				model: toCanonicalId(call.model, cfg.aliases),
				model_version: modelVersion(call.model),
				effort: EFFORTS.find((e) => e === call.effort) ?? null,
				kind,
				value: call.exit_code === 0 ? 1 : 0,
				weight: SIGNAL_WEIGHTS[kind],
				source: "Stop",
			});
		}
		if (rollout.usage)
			events.push({
				...context,
				event_id: `usage:${turnId}`,
				revision: rollout.usage_revision,
				turn_id: turnId,
				source_seq: rollout.usage_revision,
				occurred_at: rollout.usage_at ?? rollout.at,
				received_at: now,
				model: rollout.mixed_pair
					? null
					: toCanonicalId(rollout.model, cfg.aliases),
				model_version: rollout.mixed_pair ? null : modelVersion(rollout.model),
				effort: rollout.mixed_pair
					? null
					: (EFFORTS.find((e) => e === rollout.effort) ?? null),
				kind: "usage",
				source: "transcript",
				suggestion_only: rollout.mixed_pair,
				input_tokens: rollout.usage.input_tokens ?? null,
				output_tokens: rollout.usage.output_tokens ?? null,
				cache_read_tokens: rollout.usage.cache_read_input_tokens ?? null,
				cache_creation_tokens:
					rollout.usage.cache_creation_input_tokens ?? null,
			});
		if (events.length)
			store.recordAttemptEvents(events, cfg.tuning.openWindowMs);
		const at = rollout.usage_at ?? rollout.at ?? rollout.calls.at(-1)?.at;
		if (at !== null && at !== undefined)
			store.finalizeAttempts(context, at, cfg.tuning.successQuality);
	}

	async function onCodexHook(
		input: CodexHookInput,
		cfg: Config,
	): Promise<void> {
		const suggestionId = deps.env.SPATZ_SUGGESTION_ID;
		return withStore(async (store) => {
			if (suggestionId !== undefined && !store.getSuggestion(suggestionId))
				throw new Error(`unknown suggestion_id ${suggestionId}`);
			if (
				input.hook_event_name === "PostToolUse" &&
				input.tool_name === "Bash" &&
				suggestionId === undefined
			) {
				const command =
					(input.tool_input as BashToolInput | undefined)?.command ?? "";
				if (detectCommandKind(command) === "spatz-suggest") {
					const id = extractSuggestionId(
						typeof input.tool_response === "string" ? input.tool_response : "",
					);
					if (id) {
						store.linkSession(
							id,
							input.session_id,
							null,
							store.getSuggestion(id)?.created_at ?? deps.clock.now(),
							undefined,
							"codex",
						);
						const attempt = store.outcome(id)?.attempt_id;
						if (attempt && input.turn_id)
							store.bindAttempt({
								harness: "codex",
								session_key: input.session_id,
								agent_key: "",
								attempt_id: attempt,
								id_kind: "turn",
								external_id: input.turn_id,
							});
						store.reconcileAttempts(
							{
								harness: "codex",
								session_key: input.session_id,
								agent_key: "",
							},
							cfg.tuning.openWindowMs,
						);
					}
				}
			}
			if (input.hook_event_name !== "Stop") return;
			const ended = fromCodexHook(input);
			// Whatever the rollout holds, the run is over: close what no evidence reached.
			const close = () =>
				ended && closeOnEnd(store, ended, deps.clock.now(), suggestionId);
			if (!input.turn_id) {
				close();
				throw new Error("missing turn id");
			}
			const rollout = await readTranscript(input.transcript_path, (text) =>
				parseCodexRollout(text, input.turn_id as string),
			);
			if (!rollout) {
				store.recordFailure(
					"parse",
					"codex:Stop",
					deps.clock.now(),
					input.session_id,
					input.turn_id,
				);
				close();
				return;
			}
			recordCodexTurn(
				store,
				cfg,
				suggestionId ?? null,
				input.turn_id,
				rollout,
				input.session_id,
			);
			close();
		});
	}

	return {
		async startAttempt(input) {
			if (!input.key.trim() || !input.session.trim() || !input.model.trim())
				throw new Error("attempt start needs key, session and model");
			if (
				input.effort !== undefined &&
				!(EFFORTS as readonly string[]).includes(input.effort)
			)
				throw new Error("invalid effort");
			if (input.effort === "none") await validateNone([input.model]);
			const cfg = await getConfig();
			return withStore((store) =>
				store.startAttempt({
					harness: "claude-code",
					session_key: input.session,
					agent_key: input.agentId ?? "",
					suggestion_id: input.suggestionId,
					key: input.key,
					model: toCanonicalId(input.model, cfg.aliases),
					effort: (input.effort as Effort) ?? null,
					at: deps.clock.now(),
					turn_id: input.turn,
					owns_usage: input.ownsUsage,
				}),
			);
		},
		async bindAttempt(input) {
			return withStore((store) =>
				store.bindAttempt({
					harness: "claude-code",
					session_key: input.session,
					agent_key: input.agentId ?? "",
					attempt_id: input.attempt,
					id_kind: "call",
					external_id: input.call,
				}),
			);
		},
		async finalizeAttempts(input) {
			const cfg = await getConfig();
			return withStore((store) =>
				store.finalizeAttempts(
					{
						harness: "claude-code",
						session_key: input.session,
						agent_key: input.agentId ?? "",
					},
					deps.clock.now(),
					cfg.tuning.successQuality,
				),
			);
		},
		async importRollout({ file, suggestionId }) {
			const cfg = await getConfig();
			return withStore(async (store) => {
				if (!store.getSuggestion(suggestionId))
					throw new Error(`unknown suggestion_id ${suggestionId}`);
				const turns = parseCodexRollouts(await Bun.file(file).text());
				if (!turns.size)
					throw new Error("Codex rollout has no matching turn context");
				for (const [turnId, rollout] of turns)
					recordCodexTurn(store, cfg, suggestionId, turnId, rollout);
				return { suggestion_id: suggestionId, turns: turns.size };
			});
		},

		async importEval({ paths, dryRun }) {
			const parsed = await Promise.all(
				paths.flatMap(evalFiles).map(readEvalFile),
			);
			return withStore((store) => {
				// One transaction over all files: a run_id in two files counts once.
				const added = store.importEvalRows(
					parsed.flatMap((p) => p.rows),
					deps.clock.now(),
					dryRun,
				);
				let at = 0;
				const files = parsed.map(({ file, rows, rejected }) => {
					const imported = added
						.slice(at, at + rows.length)
						.filter(Boolean).length;
					at += rows.length;
					return {
						file,
						imported,
						duplicate: rows.length - imported,
						rejected,
					};
				});
				const sum = (n: (f: (typeof files)[number]) => number) =>
					files.reduce((total, f) => total + n(f), 0);
				return {
					dry_run: dryRun,
					imported: sum((f) => f.imported),
					duplicate: sum((f) => f.duplicate),
					rejected: sum((f) => f.rejected.length),
					files,
				};
			});
		},

		async suggest({
			task,
			models,
			family,
			dryRun,
			scope,
			source,
			session,
			turn,
			agentId,
			requested: requestedModel,
			requestedAgent,
			retryOf,
		}) {
			if (scope !== undefined && !(SCOPES as readonly string[]).includes(scope))
				throw new Error("invalid scope");
			if (
				source !== undefined &&
				!(AGENTS as readonly string[]).includes(source)
			)
				throw new Error("invalid source");
			for (const [name, value] of Object.entries({
				session,
				turn,
				agentId,
				requested: requestedModel,
				requestedAgent,
			})) {
				if (value !== undefined && !value.trim())
					throw new Error(`invalid ${name}`);
			}
			// A subagent's id exists only after its spawn: link it later with `link`.
			if (source === "claude-code-mod" && session && !turn && !agentId)
				throw new Error(
					"a mod suggestion with --session needs --turn or --agent-id",
				);
			const originalModel = await requestedDispatchModel(
				requestedModel,
				requestedAgent,
			);
			const cfg = await getConfig();
			const resolved = resolveModels(models, deps.env, cfg);
			const parseRequested = () => {
				try {
					return filterFamily(
						parseModelsArg(resolved.value),
						family,
						cfg.aliases,
					);
				} catch (error) {
					throw labelModelsError(error, resolved.source);
				}
			};
			// Reject invalid explicit candidates before starting either request.
			let requested = parseRequested();
			try {
				await validateNone(
					requested
						.filter((r) => r.efforts?.includes("none"))
						.map((r) => r.requested_id),
				);
			} catch (error) {
				throw labelModelsError(
					new Error(`--models: ${(error as Error).message}`),
					resolved.source,
				);
			}
			const options = {
				fetch: deps.fetch,
				env: deps.env,
				clock: deps.clock,
				ttlMs: cfg.tuning.openRouterCacheMs,
				timeoutMs: cfg.tuning.openRouterTimeoutMs,
			};
			const [harnessCatalog, openRouter, snapshot] = await Promise.all([
				resolved.source.startsWith("preset:")
					? loadHarnessCatalog({
							...options,
							cachePath: join(deps.homeDir, ".spatz", "harness-models.json"),
						})
					: null,
				loadOpenRouterModels({
					...options,
					cachePath: deps.openRouterCachePath,
				}),
				cfg.benchSnapshot === false
					? null
					: loadSnapshot({ ...options, cachePath: snapshotCachePath }),
			]);
			if (harnessCatalog) {
				const harness = resolved.source.slice("preset:".length) as Harness;
				resolved.value = formatHarnessModels(
					harnessCatalog.harnesses[harness].models,
				);
				requested = parseRequested();
			}
			const catalog = buildCatalog(requested, openRouter, cfg);
			if (catalog.length === 0)
				throw new Error("--models: no usable candidate");
			// The task text goes to classify (and maybe Jev) only; it is never stored.
			const c = await classify(
				task,
				catalog,
				deps.env.SPATZ_NO_NETWORK === "1" ? null : deps.jev,
				cfg,
			);
			return withStore((store) => {
				const priors = [
					// With bench.use on, imported rows replace the snapshot cells of their runs.
					...(snapshot
						? priorCells(
								snapshot,
								store.liveModelVersions(),
								cfg.benchUse ? store.benchRuns() : new Set(),
								deps.clock.now(),
							)
						: []),
					// Imported bench rows join the same capped prior only when bench.use is on.
					...(cfg.benchUse ? store.benchPriors() : []),
				];
				const d = recommend(
					{
						classification: c,
						random: deps.random(),
						tuning: cfg.tuning,
						priors,
					},
					catalog,
					cfg.tuning.familyPooling
						? TASK_TYPES.filter(
								(t) => TASK_FAMILY[t] === TASK_FAMILY[c.task_type],
							).flatMap((t) => store.cellStats(t, cfg.tuning.successQuality))
						: store.cellStats(c.task_type, cfg.tuning.successQuality),
				);
				const id = deps.newId();
				const now = deps.clock.now();
				store.insertSuggestion({
					id,
					retry_of: retryOf,
					requested_model: originalModel,
					created_at: now,
					price_date: now,
					price_snapshot: Object.fromEntries(
						openRouter
							.filter((m) => catalog.some((c) => c.model === m.id))
							.map((m) => [
								m.id,
								{
									price_prompt: m.price_prompt,
									price_completion: m.price_completion,
									price_cache_read: m.price_cache_read ?? null,
									price_cache_write: m.price_cache_write ?? null,
								},
							]),
					),
					session_id: session ?? null,
					prompt_id: null,
					scope: scope ?? null,
					agent: source ?? null,
					turn_id: turn ?? null,
					agent_id: agentId ?? null,
					task_type: c.task_type,
					difficulty: c.difficulty,
					criticality: c.criticality,
					probabilities: c.probabilities,
					model_ref: c.model_ref,
					strategy: d.strategy,
					ranking: d.ranking,
					reason: d.reason,
					explored: d.explored,
					control: d.control,
					fallback_used: c.fallback_used,
					fallback_reason: c.fallback_reason,
					is_test: dryRun,
					last_event_at: now,
					closed_at: null,
				});
				if (session) store.linkSession(id, session, null, now);
				return {
					suggestion_id: id,
					models_source: resolved.source,
					...(source === "claude-code-mod" && {
						candidates: catalog.map(({ model, effort }) => ({ model, effort })),
					}),
					ranking: d.ranking,
					reason: d.reason,
					classification: {
						task_type: c.task_type,
						difficulty: c.difficulty,
						criticality: c.criticality,
					},
					fallback_used: c.fallback_used,
					explored: d.explored,
					control: d.control,
					strategy: d.strategy,
					is_test: dryRun,
				};
			});
		},

		async link({ suggestionId, agentId, session }) {
			for (const [name, value] of Object.entries({ agentId, session }))
				if (!value.trim()) throw new Error(`invalid ${name}`);
			const now = deps.clock.now();
			return withStore((store) => {
				const suggestion = store.getSuggestion(suggestionId);
				if (!suggestion)
					throw new Error(`unknown suggestion_id ${suggestionId}`);
				if (suggestion.session_id !== null && suggestion.session_id !== session)
					throw new Error(
						`${suggestionId} is already linked to another session`,
					);
				if (suggestion.agent_id === agentId) return;
				if (suggestion.agent_id !== null)
					throw new Error(`${suggestionId} is already linked to another agent`);
				store.linkSession(suggestionId, session, null, now, agentId);
			});
		},

		async usage(input) {
			const { suggestionId, model, effort, source, turn } = input;
			if (source !== "claude-code-mod") throw new Error("invalid usage source");
			if (!turn?.trim()) throw new Error("missing turn");
			if (!model.trim()) throw new Error("missing model");
			if (
				effort !== undefined &&
				!(EFFORTS as readonly string[]).includes(effort)
			)
				throw new Error("invalid effort");
			if (effort === "none") await validateNone([model]);
			for (const n of [
				input.input,
				input.output,
				input.cacheRead,
				input.cacheCreation,
			]) {
				if (n !== null && (!Number.isSafeInteger(n) || n < 0))
					throw new Error("tokens must be non-negative safe integers");
			}
			if (
				input.costUsd !== undefined &&
				(!Number.isFinite(input.costUsd) || input.costUsd < 0)
			)
				throw new Error("cost must be finite and non-negative");
			const cfg = await getConfig();
			return withStore((store) => {
				const suggestion = store.getSuggestion(suggestionId);
				if (!suggestion)
					throw new Error(`unknown suggestion_id ${suggestionId}`);
				const record: UsageRecord = {
					suggestion_id: suggestionId,
					model: toCanonicalId(model, cfg.aliases),
					effort: (effort as Effort) ?? null,
					source,
					scope_key: turn,
					turn_id: turn,
					agent_id: suggestion.agent_id,
					...(input.costUsd !== undefined && {
						cost_usd: input.costUsd,
						cost_source: "reported" as const,
					}),
					input_tokens: input.input,
					output_tokens: input.output,
					cache_read_tokens: input.cacheRead,
					cache_creation_tokens: input.cacheCreation,
					is_sidechain: suggestion.agent_id !== null,
					rounds: null,
					note: null,
					reported_at: deps.clock.now(),
				};
				if (input.attempt) {
					if (!input.session || !input.key)
						throw new Error("attempt usage needs session and key");
					store.recordAttemptEvents([
						{
							harness: "claude-code",
							session_key: input.session,
							agent_key: input.agentId ?? "",
							event_id: `step:${input.key}`,
							revision: 0,
							suggestion_id: suggestionId,
							attempt_id: input.attempt,
							turn_id: turn,
							source_seq: Number(input.key.split(":").at(-1)) || 0,
							occurred_at: null,
							received_at: record.reported_at,
							model: record.model,
							effort: record.effort,
							kind: "usage",
							source,
							input_tokens: record.input_tokens,
							output_tokens: record.output_tokens,
							cache_read_tokens: record.cache_read_tokens,
							cache_creation_tokens: record.cache_creation_tokens,
							cost_usd: record.cost_usd,
							cost_source: record.cost_source,
						},
					]);
					return record;
				}
				store.upsertUsage(record);
				const stored = store.getUsage(suggestionId, source, turn, record.model);
				if (!stored) throw new Error("usage was not stored");
				return stored;
			});
		},

		async report({
			suggestionId,
			model,
			effort,
			result,
			source,
			turn,
			attempt,
			correct,
			confirm,
			rounds,
			note,
		}) {
			if (source !== undefined && source !== "claude-code-mod")
				throw new Error("invalid report source");
			if (
				(source !== undefined || turn !== undefined) &&
				(source !== "claude-code-mod" || !turn?.trim())
			)
				throw new Error("direct report needs source and turn");
			if (!(EFFORTS as readonly string[]).includes(effort))
				throw new Error(
					`invalid effort "${effort}" (allowed: ${EFFORTS.join(", ")})`,
				);
			if (!Object.hasOwn(REPORT_VALUES, result))
				throw new Error(`invalid result "${result}"`);
			if (effort === "none") await validateNone([model]);
			const cfg = await getConfig();
			return withStore((store) => {
				const suggestion = store.getSuggestion(suggestionId);
				if (!suggestion)
					throw new Error(`unknown suggestion_id ${suggestionId}`);
				return store.reportAttempt({
					suggestion_id: suggestionId,
					model: toCanonicalId(model, cfg.aliases),
					model_version: modelVersion(model),
					effort: effort as Effort,
					result,
					at: deps.clock.now(),
					attempt_id: attempt,
					correct,
					confirm,
					rounds,
					note,
					turn_id: turn,
				});
			});
		},

		async handleHook(_event, stdin) {
			// Hooks must never block the session: every error is swallowed.
			try {
				if (_event.startsWith("codex:")) {
					const input = JSON.parse(stdin) as CodexHookInput;
					if (!input || typeof input.hook_event_name !== "string")
						throw new Error("invalid hook input");
					await onCodexHook(input, await getConfig());
				} else {
					const input = parseHookInput(stdin);
					if (!input) throw new Error("invalid hook input");
					await onHook(input, await getConfig());
				}
			} catch {
				debugHook(
					"Recording failed; check hook input, transcript access and database permissions.",
				);
				// Recording must also work when config loading failed. Never block a hook on diagnostics.
				try {
					const input = parseHookInput(stdin);
					const session = input?.session_id;
					const turn =
						input?.hook_event_name === "SubagentStop"
							? input.agent_id
							: (input?.prompt_id ??
								(input as unknown as CodexHookInput)?.turn_id);
					const store = deps.openStore(deps.dbPath);
					try {
						store.recordFailure(
							"hook",
							_event,
							deps.clock.now(),
							typeof session === "string" ? session : null,
							typeof turn === "string" ? turn : null,
						);
					} finally {
						store.dispose();
					}
				} catch {}
			}
		},

		async pending({ olderThanMs = 0 }) {
			return withStore((store) => store.pending(olderThanMs, deps.clock.now()));
		},

		async signalPr({ url, review }) {
			const pr = await (internals.fetchPr ?? ghPr)(url);
			const id = suggestionFromPr(pr);
			if (!id) throw new Error("PR has no Spatz-Suggestion trailer");
			const result = resultFromPr(pr, review);
			if (!result) return null;
			return withStore((store) => {
				const pair = store.pairOf(id);
				if (!store.getSuggestion(id) || !pair)
					throw new Error(`unknown suggestion_id ${id}`);
				store.reportAttempt({
					suggestion_id: id,
					model: pair.model,
					model_version: null,
					effort: pair.effort,
					result,
					at: deps.clock.now(),
				});
				return { suggestion_id: id, result };
			});
		},

		async stats({ type, by, modelVersion }) {
			const cfg = await getConfig();
			const noneOnlyModels = noneOnly(await availableEfforts());
			// Opening the store runs migrations; the read-only stats connection cannot.
			await withStore(() => {});
			const runStats =
				internals.runStats ?? (await import("../report/index.ts")).runStats;
			const report = await runStats({
				dbPath: deps.dbPath,
				...(type && { type }),
				...(by && { by }),
				...(modelVersion && { modelVersion }),
				successQuality: cfg.tuning.successQuality,
				noneOnlyModels,
			});
			// Fixed markers survive hook wrappers that discard stderr; do not consume them.
			const launcher = await Bun.file(
				join(deps.homeDir, ".spatz", "launcher-failures"),
			)
				.text()
				.catch((error) => {
					if (error.code === "ENOENT") return "";
					throw error;
				});
			report.failures.launcher = launcher
				.split("\n")
				.filter((line) => line === "1").length;
			if (cfg.benchSnapshot === false) report.snapshot = null;
			else {
				// What the next suggestion uses, read without a network request.
				const s = await loadSnapshot({
					fetch: deps.fetch,
					env: { ...deps.env, SPATZ_NO_NETWORK: "1" },
					clock: deps.clock,
					ttlMs: cfg.tuning.openRouterCacheMs,
					cachePath: snapshotCachePath,
				});
				report.snapshot = {
					source: s.source,
					commit: s.commit,
					generated_at: s.generated_at,
					age_days: snapshotAgeDays(s, deps.clock.now()),
					fetched_at:
						s.fetched_at === null ? null : new Date(s.fetched_at).toISOString(),
					cells: s.cells.length,
					prior_weight: cfg.tuning.priorWeight,
				};
			}
			return report;
		},
	};
}
