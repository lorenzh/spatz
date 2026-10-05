// api: use cases suggest, usage, report, handleHook, stats. Orchestrates the modules; the CLI calls only this.
// Spec: "CLI interface", "Flow", "Attribution", "Used pair", "Privacy".
import { join } from "node:path";
import {
	formatHarnessModels,
	type Harness,
	loadHarnessCatalog,
} from "../catalog/harness.ts";
import {
	buildCatalog,
	parseModelsArg,
	toCanonicalId,
} from "../catalog/index.ts";
import { loadOpenRouterModels } from "../catalog/openrouter.ts";
import {
	filterFamily,
	labelModelsError,
	resolveModels,
} from "../catalog/presets.ts";
import { classify } from "../classify/index.ts";
import type { CoreDeps, SpatzApi, Store } from "../contracts/deps.ts";
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
	type UsageRecord,
} from "../contracts/types.ts";
import { recommend } from "../recommend/index.ts";
import type { StatsOptions } from "../report/index.ts";
import {
	detectCommandKind,
	effortFromHook,
	extractSuggestionId,
	isIgnoredHookInput,
	parseHookInput,
	signalFromBashEvent,
} from "../signals/index.ts";
import {
	type AssistantMessage,
	type ModelUsage,
	mainTurnMessages,
	parseCodexRollout,
	subagentMessages,
	sumByModel,
} from "../signals/transcript.ts";
import { loadConfig } from "./deps.ts";

export interface ApiInternals {
	/** Test seam. Default: report module, imported lazily so DuckDB loads only for stats. */
	runStats?: (options: StatsOptions) => Promise<StatsReport>;
}

const NO_TOKENS = {
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
};

export function createApi(
	deps: CoreDeps,
	internals: ApiInternals = {},
): SpatzApi {
	let config: Promise<Config> | undefined;
	const getConfig = () =>
		(config ??= deps.config ? Promise.resolve(deps.config) : loadConfig(deps));
	const debugHook = (message: string) => {
		if (deps.env.SPATZ_DEBUG === "1") console.error(`spatz hook: ${message}`);
	};

	/** One store handle per use case; each spatz call is its own process. */
	async function withStore<T>(
		fn: (store: Store) => T | Promise<T>,
	): Promise<T> {
		const store = deps.openStore(deps.dbPath);
		try {
			return await fn(store);
		} finally {
			store.dispose();
		}
	}

	async function onHook(input: HookInput, cfg: Config): Promise<void> {
		if (isIgnoredHookInput(input)) return;
		const now = deps.clock.now();
		const canonical = (model: string) => toCanonicalId(model, cfg.aliases);
		const usage = (
			id: string,
			u: Pick<UsageRecord, "model" | "source" | "scope_key" | "is_sidechain"> &
				Partial<UsageRecord>,
		): UsageRecord => ({
			suggestion_id: id,
			effort: null,
			...NO_TOKENS,
			rounds: null,
			note: null,
			reported_at: now,
			...u,
		});
		type ScopeFields = Pick<
			UsageRecord,
			"source" | "scope_key" | "is_sidechain" | "effort"
		>;
		const fromTranscript = (
			id: string,
			rows: ModelUsage[],
			fields: ScopeFields,
		) => {
			// Sum per canonical model: two raw names can map to one id, and upsert would overwrite.
			const byModel = new Map<string, UsageRecord>();
			for (const r of rows) {
				const model = canonical(r.model);
				const u = byModel.get(model) ?? usage(id, { ...fields, model });
				u.input_tokens += r.input_tokens;
				u.output_tokens += r.output_tokens;
				u.cache_read_tokens += r.cache_read_tokens;
				u.cache_creation_tokens += r.cache_creation_tokens;
				byModel.set(model, u);
			}
			return [...byModel.values()];
		};
		/**
		 * Each suggestion of the session gets the messages inside its own time window [created_at, end).
		 * Rewrites the whole scope atomically, so replays drop stale rows; an older snapshot is skipped.
		 */
		const writeWindowed = (
			store: Store,
			messages: AssistantMessage[],
			fields: ScopeFields,
		) => {
			const timed = messages.filter((m) => Number.isFinite(m.at));
			if (timed.length === 0) return;
			const times = timed.map((m) => m.at);
			store.rewriteScope(
				{
					session_id: input.session_id,
					source: fields.source,
					scope_key: fields.scope_key,
					agent_id: fields.source === "subagent" ? fields.scope_key : null,
					message_count: timed.length,
					from: Math.min(...times),
					last_at: Math.max(...times),
					openWindowMs: cfg.tuning.openWindowMs,
				},
				(windows) =>
					windows.flatMap((w) =>
						fromTranscript(
							w.id,
							sumByModel(timed.filter((m) => m.at >= w.start && m.at < w.end)),
							fields,
						),
					),
			);
		};

		return withStore(async (store) => {
			// Each event refreshes its agent window; handbacks are ignored above.
			const open = store.findOpenSuggestion(
				input.session_id,
				now,
				cfg.tuning.openWindowMs,
				...(input.agent_id ? [input.agent_id] : []),
			);
			if (open) store.touch(open, now);

			switch (input.hook_event_name) {
				case "PostToolUse":
				case "PostToolUseFailure": {
					if (
						input.hook_event_name === "PostToolUse" &&
						input.tool_name === "Agent"
					) {
						const r = input.tool_response as AgentToolResponse | null;
						if (!r?.resolvedModel || !r.agentId) return;
						const target = store.findOpenSuggestion(
							input.session_id,
							now,
							cfg.tuning.openWindowMs,
							r.agentId,
						);
						if (!target) return;
						// effort.level here is the main session's, not the subagent's: leave it empty.
						store.upsertUsage(
							usage(target, {
								model: canonical(r.resolvedModel),
								source: "agent_tool",
								scope_key: r.agentId,
								is_sidechain: true,
							}),
						);
						return;
					}
					if (input.tool_name !== "Bash") return;
					const command =
						(input.tool_input as BashToolInput | null)?.command ?? "";
					if (
						input.hook_event_name === "PostToolUse" &&
						detectCommandKind(command) === "spatz-suggest"
					) {
						const stdout =
							(input.tool_response as BashToolResponse | null)?.stdout ?? "";
						const id = extractSuggestionId(stdout);
						if (!id) return;
						const shrunk = store.linkSession(
							id,
							input.session_id,
							input.prompt_id ?? null,
							now,
							...(input.agent_id ? [input.agent_id] : []),
						);
						// A delayed link can shrink windows that Stop or SubagentStop already filled: rewrite those scopes.
						for (const scope of store.usageScopes(shrunk)) {
							const sub = scope.source === "subagent";
							// ponytail: subagent path derived from the Claude Code layout <session>/subagents/agent-<id>.jsonl
							const path = sub
								? `${input.transcript_path.replace(/\.jsonl$/, "")}/subagents/agent-${scope.scope_key}.jsonl`
								: input.transcript_path;
							const text = await Bun.file(path)
								.text()
								.catch(() => null);
							if (text === null) continue;
							writeWindowed(
								store,
								sub
									? subagentMessages(text)
									: mainTurnMessages(text, scope.scope_key),
								{ ...scope, is_sidechain: sub },
							);
						}
						return;
					}
					const signal = open && signalFromBashEvent(input, open, now);
					if (signal) store.insertSignal(signal);
					return;
				}
				case "Stop": {
					const promptId = input.prompt_id;
					if (!promptId) return;
					return writeWindowed(
						store,
						mainTurnMessages(
							await Bun.file(input.transcript_path).text(),
							promptId,
						),
						{
							source: "transcript",
							scope_key: promptId,
							is_sidechain: false,
							effort: effortFromHook(input),
						},
					);
				}
				case "SubagentStop":
					return writeWindowed(
						store,
						subagentMessages(
							await Bun.file(input.agent_transcript_path).text(),
						),
						{
							source: "subagent",
							scope_key: input.agent_id,
							is_sidechain: true,
							effort: effortFromHook(input),
						},
					);
			}
		});
	}

	async function onCodexHook(
		input: CodexHookInput,
		cfg: Config,
	): Promise<void> {
		const now = deps.clock.now();
		return withStore(async (store) => {
			const open = store.findOpenSuggestion(
				input.session_id,
				now,
				cfg.tuning.openWindowMs,
			);
			if (open) store.touch(open, now);
			if (input.hook_event_name === "PostToolUse") {
				if (input.tool_name !== "Bash") return;
				const command =
					(input.tool_input as BashToolInput | undefined)?.command ?? "";
				if (detectCommandKind(command) !== "spatz-suggest") return;
				const id = extractSuggestionId(
					typeof input.tool_response === "string" ? input.tool_response : "",
				);
				if (id) {
					const shrunk = store.linkSession(
						id,
						input.session_id,
						input.turn_id ?? null,
						now,
					);
					for (const scope of store.usageScopes(shrunk)) {
						if (scope.source !== "transcript") continue;
						const text = await Bun.file(input.transcript_path)
							.text()
							.catch(() => null);
						if (text === null) continue;
						const rollout = parseCodexRollout(text, scope.scope_key);
						if (!rollout) continue;
						store.rewriteScope(
							{
								session_id: input.session_id,
								source: "transcript",
								scope_key: scope.scope_key,
								message_count: 1,
								from: now,
								last_at: now,
								openWindowMs: cfg.tuning.openWindowMs,
							},
							(windows) =>
								windows.map((w) => ({
									suggestion_id: w.id,
									model: toCanonicalId(rollout.model, cfg.aliases),
									effort: EFFORTS.find((e) => e === rollout.effort) ?? null,
									source: "transcript",
									scope_key: scope.scope_key,
									is_sidechain: false,
									input_tokens: rollout.usage.input_tokens ?? 0,
									output_tokens: rollout.usage.output_tokens ?? 0,
									cache_read_tokens: rollout.usage.cache_read_input_tokens ?? 0,
									cache_creation_tokens:
										rollout.usage.cache_creation_input_tokens ?? 0,
									rounds: null,
									note: null,
									reported_at: now,
								})),
						);
					}
				}
				return;
			}
			if (input.hook_event_name !== "Stop" || !input.turn_id) return;
			const turnId = input.turn_id;
			const text = await Bun.file(input.transcript_path).text();
			const rollout = parseCodexRollout(text, turnId);
			if (!rollout) {
				debugHook(
					"Codex rollout has no matching turn context; check the rollout format.",
				);
				return;
			}
			if (open && rollout.calls.length === 0)
				debugHook("No completed shell exit codes found for this turn.");
			if (open)
				for (const call of rollout.calls) {
					const kind = detectCommandKind(call.command);
					if (kind !== "test" && kind !== "build") continue;
					store.insertSignal({
						suggestion_id: open,
						kind,
						value: call.exit_code === 0 ? 1 : 0,
						weight: SIGNAL_WEIGHTS[kind],
						source: "Stop",
						turn_id: turnId,
						observed_at: now,
					});
				}
			store.rewriteScope(
				{
					session_id: input.session_id,
					source: "transcript",
					scope_key: turnId,
					message_count: 1,
					from: now,
					last_at: now,
					openWindowMs: cfg.tuning.openWindowMs,
				},
				(windows) =>
					windows.map((w) => ({
						suggestion_id: w.id,
						model: toCanonicalId(rollout.model, cfg.aliases),
						effort: EFFORTS.find((e) => e === rollout.effort) ?? null,
						source: "transcript",
						scope_key: turnId,
						is_sidechain: false,
						input_tokens: rollout.usage.input_tokens ?? 0,
						output_tokens: rollout.usage.output_tokens ?? 0,
						cache_read_tokens: rollout.usage.cache_read_input_tokens ?? 0,
						cache_creation_tokens:
							rollout.usage.cache_creation_input_tokens ?? 0,
						rounds: null,
						note: null,
						reported_at: now,
					})),
			);
		});
	}

	return {
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
		}) {
			if (scope !== undefined && !(SCOPES as readonly string[]).includes(scope))
				throw new Error("invalid scope");
			if (
				source !== undefined &&
				!(AGENTS as readonly string[]).includes(source)
			)
				throw new Error("invalid source");
			for (const [name, value] of Object.entries({ session, turn, agentId })) {
				if (value !== undefined && !value.trim())
					throw new Error(`invalid ${name}`);
			}
			// A subagent's id exists only after its spawn: link it later with `link`.
			if (source === "claude-code-mod" && session && !turn && !agentId)
				throw new Error(
					"a mod suggestion with --session needs --turn or --agent-id",
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
			const options = {
				fetch: deps.fetch,
				env: deps.env,
				clock: deps.clock,
				ttlMs: cfg.tuning.openRouterCacheMs,
				timeoutMs: cfg.tuning.openRouterTimeoutMs,
			};
			const [harnessCatalog, openRouter] = await Promise.all([
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
				const d = recommend(
					{ classification: c, random: deps.random(), tuning: cfg.tuning },
					catalog,
					store.cellStats(c.task_type),
				);
				const id = deps.newId();
				const now = deps.clock.now();
				store.insertSuggestion({
					id,
					created_at: now,
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
			for (const n of [
				input.input,
				input.output,
				input.cacheRead,
				input.cacheCreation,
			]) {
				if (!Number.isSafeInteger(n) || n < 0)
					throw new Error("tokens must be non-negative safe integers");
			}
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
					input_tokens: input.input,
					output_tokens: input.output,
					cache_read_tokens: input.cacheRead,
					cache_creation_tokens: input.cacheCreation,
					is_sidechain: suggestion.agent_id !== null,
					rounds: null,
					note: null,
					reported_at: deps.clock.now(),
				};
				store.upsertUsage(record);
				return record;
			});
		},

		async report({
			suggestionId,
			model,
			effort,
			result,
			rounds,
			note,
			source,
			turn,
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
			const cfg = await getConfig();
			return withStore((store) => {
				const suggestion = store.getSuggestion(suggestionId);
				if (!suggestion)
					throw new Error(`unknown suggestion_id ${suggestionId}`);
				const now = deps.clock.now();
				store.upsertUsage({
					suggestion_id: suggestionId,
					model: toCanonicalId(model, cfg.aliases),
					effort: effort as Effort,
					source: "report",
					scope_key: turn ?? "",
					...(turn && {
						turn_id: turn,
						agent_id: suggestion.agent_id,
					}),
					...NO_TOKENS,
					is_sidechain: false,
					rounds: rounds ?? null,
					note: note ?? null,
					reported_at: now,
				});
				store.insertSignal({
					suggestion_id: suggestionId,
					kind: "report",
					value: REPORT_VALUES[result],
					weight: SIGNAL_WEIGHTS.report,
					source: source ?? "report",
					...(turn && {
						turn_id: turn,
						agent_id: suggestion.agent_id,
					}),
					observed_at: now,
				});
				store.closeSuggestion(suggestionId, now);
				return store.outcome(suggestionId);
			});
		},

		async handleHook(_event, stdin) {
			// Hooks must never block the session: every error is swallowed.
			try {
				if (_event.startsWith("codex:")) {
					const input = JSON.parse(stdin) as CodexHookInput;
					if (input && typeof input.hook_event_name === "string")
						await onCodexHook(input, await getConfig());
				} else {
					const input = parseHookInput(stdin);
					if (input) await onHook(input, await getConfig());
				}
			} catch {
				debugHook(
					"Recording failed; check hook input, transcript access and database permissions.",
				);
			}
		},

		async stats({ type, by }) {
			const cfg = await getConfig();
			// Opening the store runs migrations; the read-only DuckDB scan cannot.
			await withStore(() => {});
			const runStats =
				internals.runStats ?? (await import("../report/index.ts")).runStats;
			return runStats({
				dbPath: deps.dbPath,
				extensionDir: deps.duckdbExtensionDir,
				...(type && { type }),
				...(by && { by }),
				successQuality: cfg.tuning.successQuality,
			});
		},
	};
}
