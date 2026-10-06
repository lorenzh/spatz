import type { Database } from "bun:sqlite";
import type {
	AttemptBinding,
	AttemptContext,
	AttemptEvent,
	AttemptRecord,
	AttemptStore,
} from "../contracts/attempts.ts";
import type { Store } from "../contracts/deps.ts";
import {
	DEFAULT_TUNING,
	EFFORTS,
	type Outcome,
	REPORT_VALUES,
} from "../contracts/types.ts";

import { lowerBoundSql } from "./attempt-schema.ts";

const tokenKeys = [
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_creation_tokens",
] as const;
type Row = Required<Omit<AttemptEvent, "cost_source">> & {
	binding: "pending" | "window" | "bound";
	source: string;
	cost_source: string;
	requested_attempt_id: string | null;
	requested_suggestion_id: string | null;
	suggestion_only: boolean;
};
export function attemptStore(
	db: Database,
	store: () => Store,
	noneOnly: Set<string> = new Set(),
): AttemptStore & {
	initialize(id: string, retryOf?: string): void;
	link(id: string): void;
} {
	const lowerBound = db.query<
		{ lower_bound: number },
		[string, string, string]
	>(
		`SELECT ${lowerBoundSql("?1", "?2='claude-code'", "?3<>''")} AS lower_bound`,
	);
	const get = (id: string) =>
		db
			.query<AttemptRecord, [string]>("SELECT * FROM attempts WHERE id=?")
			.get(id);
	const latest = (id: string) =>
		db
			.query<AttemptRecord, [string]>(
				"SELECT * FROM attempts WHERE suggestion_id=? ORDER BY ordinal DESC LIMIT 1",
			)
			.get(id);
	const checkPair = (
		model: string | null | undefined,
		effort: string | null | undefined,
	) => {
		if (model != null && (!model.trim() || model.length > 300))
			throw new Error("invalid model");
		if (effort != null && !EFFORTS.includes(effort as never))
			throw new Error("invalid effort");
	};
	const compatible = (
		a: AttemptRecord,
		e: Pick<AttemptEvent, "model" | "effort">,
	) =>
		(!e.model || !a.model || a.model === e.model) &&
		(!e.effort || !a.effort || a.effort === e.effort);
	const context = (id: string): AttemptContext => {
		const s = store().getSuggestion(id);
		if (!s) throw new Error("unknown suggestion");
		return {
			harness: s.agent === "codex" ? "codex" : "claude-code",
			session_key: s.session_id ?? `suggestion:${id}`,
			agent_key: s.agent_id ?? "",
		};
	};
	const assertSuggestion = (id: string) => {
		const s = store().getSuggestion(id);
		if (!s) throw new Error("unknown suggestion");
		if (s.is_legacy) throw new Error("legacy suggestion is frozen");
		return s;
	};
	const add = (
		id: string,
		key: string,
		model: string | null,
		effort: AttemptRecord["effort"],
		at: number,
		c: AttemptContext,
		root?: string,
	) => {
		const previous = latest(id);
		const priorContext = db
			.query<AttemptRecord, [string, string, string, string]>(
				"SELECT * FROM attempts WHERE suggestion_id=? AND harness=? AND session_key=? AND agent_key=? ORDER BY ordinal DESC LIMIT 1",
			)
			.get(id, c.harness, c.session_key, c.agent_key);
		const uuid = crypto.randomUUID();
		if (priorContext)
			db.query(
				"UPDATE attempts SET closed_at=COALESCE(closed_at,?) WHERE id=? AND harness=? AND session_key=? AND agent_key=?",
			).run(at, priorContext.id, c.harness, c.session_key, c.agent_key);
		db.query(
			"INSERT INTO attempts(id,suggestion_id,ordinal,execution_key,model,effort,root_id,opened_at,harness,session_key,agent_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
		).run(
			uuid,
			id,
			(previous?.ordinal ?? 0) + 1,
			key,
			model,
			effort,
			root ?? previous?.root_id ?? uuid,
			at,
			c.harness,
			c.session_key,
			c.agent_key,
		);
		const attempt = get(uuid);
		if (!attempt) throw new Error("missing inserted attempt");
		return attempt;
	};
	const alias = (b: AttemptBinding, provisional = 0) => {
		const a = get(b.attempt_id);
		if (!a) throw new Error("unknown attempt");
		if (!provisional)
			db.query(
				"DELETE FROM attempt_bindings WHERE harness=? AND session_key=? AND agent_key=? AND id_kind=? AND external_id=? AND provisional=1",
			).run(b.harness, b.session_key, b.agent_key, b.id_kind, b.external_id);

		const owner = db
			.query<
				{ harness: string; session_key: string; agent_key: string },
				[string]
			>("SELECT harness,session_key,agent_key FROM attempts WHERE id=?")
			.get(a.id);
		if (
			!owner ||
			owner.harness !== b.harness ||
			owner.session_key !== b.session_key ||
			owner.agent_key !== b.agent_key
		)
			throw new Error("binding context does not own attempt");
		db.query(
			"INSERT INTO attempt_bindings VALUES(?,?,?,?,?,?,?) ON CONFLICT(harness,session_key,agent_key,id_kind,external_id,attempt_id) DO UPDATE SET provisional=MIN(provisional,excluded.provisional)",
		).run(
			b.harness,
			b.session_key,
			b.agent_key,
			b.id_kind,
			b.external_id,
			b.attempt_id,
			provisional,
		);
	};
	const fill = (
		a: AttemptRecord,
		e: Pick<AttemptEvent, "model" | "effort">,
	) => {
		if (!compatible(a, e)) throw new Error("attempt pair conflict");
		db.query(
			"UPDATE attempts SET model=COALESCE(model,?),effort=COALESCE(effort,?) WHERE id=?",
		).run(e.model ?? null, e.effort ?? null, a.id);
	};
	const chain = (root: string) => {
		const success = db
			.query<{ at: number }, [string]>(
				"SELECT MIN(a.finalized_at) AS at FROM attempts a JOIN attempts r ON r.id=a.root_id WHERE a.root_id=? AND a.finalized_at IS NOT NULL AND (SELECT quality FROM attempt_quality WHERE attempt_id=a.id)>=r.success_quality",
			)
			.get(root);
		const failed = db
			.query<{ at: number | null }, [string]>(
				`SELECT MIN(n.created_at) AS at FROM attempts a JOIN suggestions s ON s.id=a.suggestion_id JOIN suggestions n ON n.session_id=s.session_id AND n.agent_id IS s.agent_id AND n.created_at>s.created_at JOIN attempts na ON na.suggestion_id=n.id AND na.ordinal=1 WHERE a.root_id=? AND na.root_id<>a.root_id`,
			)
			.get(root);
		db.query("UPDATE attempts SET chain_closed_at=? WHERE id=?").run(
			success?.at ?? failed?.at ?? null,
			root,
		);
	};
	const outcome = (a: AttemptRecord): Outcome => {
		const row = db
			.query<{ quality: number | null }, [string]>(
				"SELECT quality FROM attempt_quality WHERE attempt_id=?",
			)
			.get(a.id);
		const tokens = db
			.query<Record<(typeof tokenKeys)[number], number | null>, [string]>(
				`SELECT ${tokenKeys.map((t) => `SUM(${t}) AS ${t}`).join(",")} FROM attempt_usage WHERE attempt_id=?`,
			)
			.get(a.id);
		if (!tokens) throw new Error("missing usage totals");
		return {
			suggestion_id: a.suggestion_id,
			attempt_id: a.id,
			ordinal: a.ordinal,
			root_id: a.root_id,
			model: a.model,
			effort: a.effort,
			quality: row?.quality ?? null,
			...tokens,
		};
	};
	const resolve = (e: Row, idle: number, roots: Set<string>) => {
		const occurredAt = e.occurred_at;
		const sourceSeq = e.source_seq;
		if (
			e.requested_suggestion_id &&
			store().getSuggestion(e.requested_suggestion_id)?.is_legacy
		) {
			console.error("spatz: dropped late legacy event");
			return;
		}
		// An exact mod tool call supplies the explicit bridge between hook prompt UUIDs and mod turn UUIDs.
		if (e.call_id && e.prompt_id) {
			const segments = db
				.query<{ attempt_id: string }, [string, string, string, string]>(
					`SELECT DISTINCT turn.attempt_id FROM attempt_bindings call JOIN attempts a ON a.id=call.attempt_id JOIN attempt_bindings own ON own.attempt_id=a.id AND own.id_kind='turn' JOIN attempt_bindings turn ON turn.harness=own.harness AND turn.session_key=own.session_key AND turn.agent_key=own.agent_key AND turn.id_kind='turn' AND turn.external_id=own.external_id WHERE call.harness=? AND call.session_key=? AND call.agent_key=? AND call.id_kind='call' AND call.external_id=? AND call.provisional=0 AND a.owns_usage=1`,
				)
				.all(e.harness, e.session_key, e.agent_key, e.call_id);
			for (const segment of segments)
				alias({
					...e,
					attempt_id: segment.attempt_id,
					id_kind: "prompt",
					external_id: e.prompt_id,
				});
		}
		if (
			db
				.query(
					"SELECT 1 FROM suggestions WHERE is_legacy=1 AND session_id=? AND agent_id IS ? AND ((prompt_id IS NOT NULL AND prompt_id=?) OR (turn_id IS NOT NULL AND turn_id=?)) LIMIT 1",
				)
				.get(e.session_key, e.agent_key || null, e.prompt_id, e.turn_id)
		) {
			console.error("spatz: dropped late legacy identity");
			return;
		}
		let candidates: Set<string> | null = null;
		let exact = false;
		let conflict = false;
		if (e.requested_attempt_id) {
			const a = get(e.requested_attempt_id);
			if (!a) throw new Error("unknown attempt");
			candidates = new Set([a.id]);
			exact = true;
		}
		for (const [kind, id] of [
			["prompt", e.prompt_id],
			["turn", e.turn_id],
			["call", e.call_id],
			["message", e.message_id],
		] as const) {
			if (!id) continue;
			const ids = db
				.query<
					{ attempt_id: string },
					[string, string, string, string, string]
				>(
					"SELECT attempt_id FROM attempt_bindings WHERE harness=? AND session_key=? AND agent_key=? AND id_kind=? AND external_id=? AND provisional=0",
				)
				.all(e.harness, e.session_key, e.agent_key, kind, id)
				.map((x) => x.attempt_id);
			if (ids.length) {
				const previous = candidates;
				candidates = previous
					? new Set(ids.filter((id) => previous.has(id)))
					: new Set(ids);
				if (kind === "call" || kind === "message") exact = true;
				if (!candidates.size) conflict = true;
			}
		}
		let choices: AttemptRecord[] = [];
		if (candidates) {
			choices = [...candidates].map((id) => {
				const attempt = get(id);
				if (!attempt) throw new Error("unknown bound attempt");
				return attempt;
			});
			if (e.requested_suggestion_id)
				choices = choices.filter(
					(a) => a.suggestion_id === e.requested_suggestion_id,
				);
		} else if (e.occurred_at != null) {
			choices = db
				.query<
					AttemptRecord,
					[string, string, string, string, number, number, number]
				>(
					`SELECT a.* FROM attempts a JOIN suggestions s ON s.id=a.suggestion_id WHERE a.harness=? AND a.session_key=? AND (a.agent_key=? OR (?='' AND s.agent_id IS NULL AND EXISTS(SELECT 1 FROM dispatches d WHERE d.attempt_id=a.id))) AND s.created_at<=? AND COALESCE(s.closed_at,s.last_event_at+?)>? AND s.is_legacy=0`,
				)
				.all(
					e.harness,
					e.session_key,
					e.agent_key,
					e.agent_key,
					e.occurred_at,
					idle,
					e.occurred_at,
				);
			if (e.requested_suggestion_id)
				choices = choices.filter(
					(a) => a.suggestion_id === e.requested_suggestion_id,
				);
		} else if (e.requested_suggestion_id) {
			// Explicit import/report links are source identity, not receipt-time fallback.
			const a = latest(e.requested_suggestion_id);
			if (a) {
				choices = [a];
				exact = true;
			}
		}
		if (
			!e.suggestion_only &&
			!exact &&
			choices.length > 1 &&
			occurredAt == null &&
			sourceSeq != null &&
			(e.turn_id || e.prompt_id)
		) {
			const ordered = choices
				.map((a) => ({
					a,
					seq: db
						.query<
							{ seq: number | null },
							[string, string, string, string, string | null, string | null]
						>(
							"SELECT MIN(source_seq) AS seq FROM latest_attempt_events WHERE attempt_id=? AND harness=? AND session_key=? AND agent_key=? AND (turn_id=? OR prompt_id=?)",
						)
						.get(
							a.id,
							e.harness,
							e.session_key,
							e.agent_key,
							e.turn_id,
							e.prompt_id,
						)?.seq,
				}))
				.flatMap((x) => {
					const seq = x.seq;
					return seq != null && seq <= sourceSeq ? [{ a: x.a, seq }] : [];
				});
			const seq = Math.max(...ordered.map((x) => x.seq));
			choices = ordered.filter((x) => x.seq === seq).map((x) => x.a);
		}
		if (
			!e.suggestion_only &&
			!exact &&
			(!candidates || choices.length > 1) &&
			occurredAt != null
		)
			choices = choices.filter((a) => {
				if (a.opened_at != null && a.opened_at > occurredAt) return false;
				if (a.closed_at == null || occurredAt < a.closed_at) return true;
				const stopped = db
					.query(
						"SELECT 1 FROM attempts a JOIN suggestions s ON s.id=a.suggestion_id WHERE a.id=? AND a.finalized_at IS NOT NULL AND s.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM attempts n WHERE n.suggestion_id=a.suggestion_id AND n.harness=a.harness AND n.session_key=a.session_key AND n.agent_key=a.agent_key AND n.ordinal>a.ordinal)",
					)
					.get(a.id);
				return !!stopped && compatible(a, e);
			});
		let target =
			choices.length === 1 ||
			(e.suggestion_only &&
				choices.length > 0 &&
				new Set(choices.map((a) => a.suggestion_id)).size === 1)
				? choices[0]
				: undefined;
		if (
			target &&
			e.agent_key === "" &&
			e.source !== "claude-code-mod" &&
			db
				.query("SELECT 1 FROM attempts WHERE id=? AND owns_usage=1")
				.get(target.id)
		)
			e = { ...e, effort: null };
		let suggestion = target?.suggestion_id ?? null;
		if (e.kind === "delegate" && target && e.call_id) {
			const dispatch = db
				.query<
					{
						agent_id: string;
						answered_model: string | null;
						attempt_id: string | null;
					},
					[string, string]
				>(
					"SELECT agent_id,answered_model,attempt_id FROM dispatches WHERE session_id=? AND tool_use_id=?",
				)
				.get(e.session_key, e.call_id);
			if (dispatch) {
				let child = dispatch.attempt_id ? get(dispatch.attempt_id) : null;
				if (!child) {
					const c = {
						harness: e.harness,
						session_key: e.session_key,
						agent_key: dispatch.agent_id,
					};
					if (target.execution_key === "implicit") {
						db.query(
							"UPDATE attempts SET execution_key=?,agent_key=?,model=? WHERE id=?",
						).run(
							`dispatch:${dispatch.agent_id}`,
							dispatch.agent_id,
							dispatch.answered_model,
							target.id,
						);
						child = get(target.id);
					} else
						child = add(
							target.suggestion_id,
							`dispatch:${dispatch.agent_id}`,
							dispatch.answered_model,
							null,
							e.occurred_at ?? target.opened_at ?? 0,
							c,
						);
					if (!child) throw new Error("missing dispatch attempt");
					alias({
						...c,
						attempt_id: child.id,
						id_kind: "start",
						external_id: `dispatch:${dispatch.agent_id}`,
					});
					db.query(
						"UPDATE dispatches SET suggestion_id=COALESCE(suggestion_id,?),attempt_id=? WHERE session_id=? AND agent_id=?",
					).run(
						target.suggestion_id,
						child.id,
						e.session_key,
						dispatch.agent_id,
					);
				}
				target = child ?? target;
			}
		}
		let orchestration = false;
		let verification = false;
		if (!e.requested_attempt_id && e.agent_key === "" && suggestion) {
			const delegates = db
				.query<AttemptRecord, [string]>(
					`SELECT DISTINCT a.* FROM attempts a JOIN dispatches d ON d.attempt_id=a.id WHERE a.suggestion_id=? ORDER BY a.closed_at DESC`,
				)
				.all(suggestion);
			const delegateEvidence = db
				.query(
					"SELECT 1 FROM latest_attempt_events WHERE suggestion_id=? AND kind='delegate' AND (source_seq<=? OR occurred_at<=?) LIMIT 1",
				)
				.get(suggestion, e.source_seq, e.occurred_at);
			if (e.kind === "usage" && delegates.length) orchestration = true;
			if (delegateEvidence) {
				if (e.kind === "usage") orchestration = true;
				else if (e.kind !== "delegate") {
					target = delegates.find((a) => a.closed_at != null);
					verification = true;
				}
			}
		}
		if (target && !orchestration && !verification && e.kind !== "delegate") {
			const owner = db
				.query<AttemptContext, [string]>(
					"SELECT harness,session_key,agent_key FROM attempts WHERE id=?",
				)
				.get(target.id);
			if (
				owner?.harness !== e.harness ||
				owner?.session_key !== e.session_key ||
				owner?.agent_key !== e.agent_key
			)
				target = undefined;
		}
		if (
			target &&
			e.kind !== "delegate" &&
			!orchestration &&
			!verification &&
			!e.suggestion_only &&
			!compatible(target, e)
		) {
			if (exact) {
				target = undefined;
				conflict = true;
			} else if (
				e.model &&
				(e.occurred_at != null || (e.source_seq != null && candidates))
			) {
				target = add(
					target.suggestion_id,
					`event:${e.harness}:${e.session_key}:${e.agent_key}:${e.event_id}`,
					e.model,
					e.effort,
					e.occurred_at ?? target.opened_at ?? 0,
					e,
				);
				if (candidates)
					for (const [kind, id] of [
						["prompt", e.prompt_id],
						["turn", e.turn_id],
					] as const)
						if (id)
							alias({
								...e,
								attempt_id: target.id,
								id_kind: kind,
								external_id: id,
							});
			} else target = undefined;
		}
		if (
			target &&
			e.kind !== "delegate" &&
			!orchestration &&
			!verification &&
			!e.suggestion_only
		)
			fill(target, e);
		suggestion = target?.suggestion_id ?? (orchestration ? suggestion : null);
		const binding = target
			? exact || verification
				? "bound"
				: "window"
			: "pending";
		if (conflict)
			console.error("spatz: conflicting attempt identity; event pending");
		db.query(
			"UPDATE attempt_events SET suggestion_id=?,attempt_id=?,binding=? WHERE harness=? AND session_key=? AND agent_key=? AND event_id=? AND revision=?",
		).run(
			suggestion,
			target && !orchestration && !e.suggestion_only ? target.id : null,
			binding,
			e.harness,
			e.session_key,
			e.agent_key,
			e.event_id,
			e.revision,
		);
		if (e.kind === "usage" && e.cost_source !== "reported") {
			let cost: number | null = null;
			const price =
				suggestion && e.model
					? store().getSuggestion(suggestion)?.price_snapshot?.[e.model]
					: null;
			if (price) {
				const rates = [
					price.price_prompt,
					price.price_completion,
					price.price_cache_read,
					price.price_cache_write,
				];
				const counts = tokenKeys.map((k) => e[k]);
				if (
					counts.some((n) => n != null) &&
					counts.every((n, i) => {
						const rate = rates[i];
						return !n || (rate != null && Number.isFinite(rate) && rate >= 0);
					})
				) {
					const sum = counts.reduce<number>(
						(sum, n, i) => sum + (n ?? 0) * (rates[i] ?? 0),
						0,
					);
					if (Number.isFinite(sum)) cost = sum;
				}
			}
			db.query(
				"UPDATE attempt_events SET cost_usd=?,cost_source=? WHERE harness=? AND session_key=? AND agent_key=? AND event_id=? AND revision=?",
			).run(
				cost,
				cost === null ? "unavailable" : "priced",
				e.harness,
				e.session_key,
				e.agent_key,
				e.event_id,
				e.revision,
			);
		}
		if (target && !orchestration && !verification && e.kind !== "delegate") {
			if (e.occurred_at != null)
				db.query(
					"UPDATE attempts SET finalized_at=NULL,closed_at=NULL WHERE id=? AND finalized_at<? AND NOT EXISTS(SELECT 1 FROM latest_attempt_events WHERE attempt_id=? AND kind='report')",
				).run(target.id, e.occurred_at, target.id);
			for (const [kind, id] of [
				["prompt", e.prompt_id],
				["turn", e.turn_id],
				["message", e.message_id],
				["call", e.call_id],
			] as const)
				if (id)
					alias(
						{ ...e, attempt_id: target.id, id_kind: kind, external_id: id },
						exact ? 0 : 1,
					);
		}
		if (suggestion && e.occurred_at != null)
			db.query(
				"UPDATE suggestions SET last_event_at=MAX(last_event_at,?) WHERE id=?",
			).run(e.occurred_at, suggestion);
		if (e.attempt_id) {
			const old = get(e.attempt_id);
			if (old) roots.add(old.root_id);
		}
		if (target) roots.add(target.root_id);
	};
	const reconcile = (
		c: AttemptContext,
		idle: number,
		roots: Set<string>,
		pendingOnly = false,
	) => {
		if (!pendingOnly)
			db.query(
				"DELETE FROM attempt_bindings WHERE harness=? AND session_key=? AND agent_key=? AND provisional=1",
			).run(c.harness, c.session_key, c.agent_key);
		const events = db
			.query<Row, [string, string, string]>(
				`SELECT * FROM latest_attempt_events WHERE harness=? AND session_key=? AND agent_key=? AND ${pendingOnly ? "binding='pending'" : "binding<>'bound'"} ORDER BY CASE WHEN kind='delegate' THEN 0 ELSE 1 END,occurred_at,source_seq,event_id`,
			)
			.all(c.harness, c.session_key, c.agent_key);
		for (const e of events) resolve(e, idle, roots);
	};
	const repair = (c: AttemptContext, idle: number) => {
		const roots = new Set<string>();
		reconcile(c, idle, roots);
		for (const root of roots) chain(root);
	};
	const api: ReturnType<typeof attemptStore> = {
		initialize(id, retryOf) {
			const s = assertSuggestion(id);
			let root: string | undefined;
			if (retryOf) {
				assertSuggestion(retryOf);
				root = latest(retryOf)?.root_id;
				if (!root) throw new Error("retry target has no attempt");
			}
			const a = add(
				id,
				"implicit",
				null,
				null,
				s.created_at,
				context(id),
				root,
			);
			if (s.prompt_id)
				alias({
					...context(id),
					attempt_id: a.id,
					id_kind: "prompt",
					external_id: s.prompt_id,
				});
			if (s.turn_id)
				alias({
					...context(id),
					attempt_id: a.id,
					id_kind: "turn",
					external_id: s.turn_id,
				});
		},
		link(id) {
			const s = assertSuggestion(id);
			const c = context(id);
			db.query(
				"UPDATE attempts SET harness=?,session_key=?,agent_key=? WHERE suggestion_id=?",
			).run(c.harness, c.session_key, c.agent_key, id);
			db.query(
				"UPDATE attempt_bindings SET harness=?,session_key=?,agent_key=? WHERE attempt_id IN(SELECT id FROM attempts WHERE suggestion_id=?)",
			).run(c.harness, c.session_key, c.agent_key, id);
			const first = db
				.query<AttemptRecord, [string]>(
					"SELECT * FROM attempts WHERE suggestion_id=? ORDER BY ordinal LIMIT 1",
				)
				.get(id);
			if (first && s.prompt_id)
				alias({
					...c,
					attempt_id: first.id,
					id_kind: "prompt",
					external_id: s.prompt_id,
				});
			if (first && s.turn_id)
				alias({
					...c,
					attempt_id: first.id,
					id_kind: "turn",
					external_id: s.turn_id,
				});
			repair(c, DEFAULT_TUNING.openWindowMs);
			for (const { root_id } of db
				.query<{ root_id: string }, [string | null, string | null, string]>(
					"SELECT DISTINCT a.root_id FROM attempts a JOIN suggestions s ON s.id=a.suggestion_id WHERE s.session_id=? AND s.agent_id IS ? AND a.harness=?",
				)
				.all(s.session_id, s.agent_id, c.harness))
				chain(root_id);
		},
		startAttempt(input) {
			if (
				!input.key ||
				!input.harness ||
				!input.session_key ||
				!Number.isSafeInteger(input.at) ||
				input.at < 0
			)
				throw new Error("invalid start identity/time");
			if (input.model && noneOnly.has(input.model))
				input = { ...input, effort: "none" };
			return db
				.transaction(() => {
					assertSuggestion(input.suggestion_id);
					checkPair(input.model, input.effort);
					let a = db
						.query<AttemptRecord, [string, string]>(
							"SELECT * FROM attempts WHERE suggestion_id=? AND execution_key=?",
						)
						.get(input.suggestion_id, input.key);
					if (a) {
						const owner = db
							.query<AttemptContext, [string]>(
								"SELECT harness,session_key,agent_key FROM attempts WHERE id=?",
							)
							.get(a.id);
						if (
							owner?.harness !== input.harness ||
							owner?.session_key !== input.session_key ||
							owner?.agent_key !== input.agent_key
						)
							throw new Error("start replay ownership conflict");
						if (!compatible(a, input))
							throw new Error("start replay pair conflict");
						return a;
					}
					a = latest(input.suggestion_id);
					if (
						a?.execution_key === "implicit" &&
						(a.model === null ||
							(input.owns_usage &&
								compatible(
									a,
									input.agent_key
										? input
										: { model: input.model, effort: null },
								))) &&
						a.closed_at === null
					) {
						db.query(
							"UPDATE attempts SET execution_key=?,model=?,effort=?,opened_at=?,harness=?,session_key=?,agent_key=?,owns_usage=? WHERE id=?",
						).run(
							input.key,
							input.model,
							input.effort,
							a.model ? Math.min(a.opened_at ?? input.at, input.at) : input.at,
							input.harness,
							input.session_key,
							input.agent_key,
							Number(input.owns_usage ?? false),
							a.id,
						);
						a = get(a.id);
					} else
						a = add(
							input.suggestion_id,
							input.key,
							input.model,
							input.effort,
							input.at,
							input,
						);
					if (!a) throw new Error("missing started attempt");
					if (input.owns_usage)
						db.query("UPDATE attempts SET owns_usage=1 WHERE id=?").run(a.id);
					for (const [kind, id] of [
						["start", input.key],
						["turn", input.turn_id],
						["prompt", input.prompt_id],
						["call", input.call_id],
					] as const)
						if (id)
							alias({
								...input,
								attempt_id: a.id,
								id_kind: kind,
								external_id: id,
							});
					if (input.agent_key)
						db.query(
							"UPDATE dispatches SET attempt_id=COALESCE(attempt_id,?) WHERE session_id=? AND agent_id=?",
						).run(a.id, input.session_key, input.agent_key);
					repair(input, DEFAULT_TUNING.openWindowMs);
					const started = get(a.id);
					if (!started) throw new Error("missing started attempt");
					return started;
				})
				.immediate();
		},
		bindAttempt(input) {
			db.transaction(() => {
				alias(input);
				repair(input, DEFAULT_TUNING.openWindowMs);
			}).immediate();
		},
		recordAttemptEvents(events, idle = DEFAULT_TUNING.openWindowMs) {
			db.transaction(() => {
				const roots = new Set<string>();
				const contexts = new Map<string, AttemptContext>();
				const delegates = new Map<string, AttemptEvent>();
				// ponytail: prune 256 event identities per batch, including their revisions; use maintenance for a historic backlog.
				const received = Math.max(...events.map((e) => e.received_at));
				if (Number.isFinite(received))
					db.query(
						"DELETE FROM attempt_events WHERE (harness,session_key,agent_key,event_id) IN (SELECT harness,session_key,agent_key,event_id FROM latest_attempt_events WHERE binding='pending' AND received_at<? ORDER BY received_at LIMIT 256)",
					).run(received - idle);
				for (let input of [...events].sort(
					(a, b) =>
						Number(b.kind === "delegate") - Number(a.kind === "delegate"),
				)) {
					if (input.model && noneOnly.has(input.model))
						input = { ...input, effort: "none" };
					checkPair(input.model, input.effort);
					if (
						!["report", "test", "build", "usage", "delegate"].includes(
							input.kind,
						)
					)
						throw new Error("invalid event kind");
					if (
						input.value != null &&
						(!Number.isFinite(input.value) ||
							input.value < 0 ||
							input.value > 1)
					)
						throw new Error("quality must be between zero and one");
					if (
						input.weight != null &&
						(!Number.isFinite(input.weight) || input.weight <= 0)
					)
						throw new Error("weight must be positive");
					for (const n of [
						input.occurred_at,
						input.received_at,
						input.source_seq,
					])
						if (n != null && (!Number.isSafeInteger(n) || n < 0))
							throw new Error("invalid source time/order");
					if (
						input.source === "claude-code-mod" &&
						input.harness !== "claude-code"
					)
						throw new Error("invalid mod source ownership");
					if (
						!input.harness ||
						!input.session_key ||
						!input.event_id ||
						!Number.isSafeInteger(input.revision) ||
						input.revision < 0
					)
						throw new Error("invalid event identity");
					for (const key of tokenKeys) {
						const count = input[key];
						if (count != null && (!Number.isSafeInteger(count) || count < 0))
							throw new Error(
								"tokens must be null or non-negative safe integers",
							);
					}
					if (
						input.cost_usd != null &&
						(!Number.isFinite(input.cost_usd) || input.cost_usd < 0)
					)
						throw new Error("cost must be finite and non-negative");
					if (
						input.suggestion_id &&
						store().getSuggestion(input.suggestion_id)?.is_legacy
					) {
						console.error("spatz: dropped late legacy event");
						continue;
					}
					if (input.attempt_id) {
						const a = get(input.attempt_id);
						if (
							!a ||
							(input.suggestion_id && a.suggestion_id !== input.suggestion_id)
						)
							throw new Error("suggestion/attempt mismatch");
						const owner = db
							.query<AttemptContext, [string]>(
								"SELECT harness,session_key,agent_key FROM attempts WHERE id=?",
							)
							.get(a.id);
						if (
							!owner ||
							owner.harness !== input.harness ||
							owner.session_key !== input.session_key ||
							owner.agent_key !== input.agent_key
						)
							throw new Error("event context does not own attempt");
					}
					const e: Record<string, string | number | null> = {
						harness: input.harness,
						session_key: input.session_key,
						agent_key: input.agent_key,
						event_id: input.event_id,
						revision: input.revision,
						suggestion_id: null,
						attempt_id: null,
						binding: "pending",
						prompt_id: input.prompt_id ?? null,
						turn_id: input.turn_id ?? null,
						call_id: input.call_id ?? null,
						message_id: input.message_id ?? null,
						source_seq: input.source_seq ?? null,
						occurred_at: input.occurred_at ?? null,
						received_at: input.received_at,
						rounds: input.rounds ?? null,
						note: input.note ?? null,
						model: input.model ?? null,
						effort: input.effort ?? null,
						kind: input.kind,
						source: input.source ?? input.harness,
						value: input.value ?? null,
						weight: input.weight ?? null,
						input_tokens: input.input_tokens ?? null,
						output_tokens: input.output_tokens ?? null,
						cache_read_tokens: input.cache_read_tokens ?? null,
						cache_creation_tokens: input.cache_creation_tokens ?? null,
						cost_usd:
							input.cost_source === "reported"
								? (input.cost_usd ?? null)
								: null,
						cost_source:
							input.cost_source === "reported" ? "reported" : "unavailable",
						tokens_complete: Number(
							input.tokens_complete !== 0 &&
								tokenKeys.every((k) => input[k] != null) &&
								!lowerBound.get(
									input.source ?? input.harness,
									input.harness,
									input.agent_key,
								)?.lower_bound,
						),
						tokens_schema: input.tokens_schema ?? 2,
						suggestion_only: Number(input.suggestion_only ?? false),
						requested_attempt_id: input.attempt_id ?? null,
						requested_suggestion_id: input.suggestion_id ?? null,
					};
					if (input.kind === "delegate")
						delegates.set(
							JSON.stringify([
								input.harness,
								input.session_key,
								input.agent_key,
								input.call_id,
							]),
							input,
						);
					const previous = db
						.query<
							Record<string, string | number | null>,
							[string, string, string, string, number]
						>(
							"SELECT * FROM attempt_events WHERE harness=? AND session_key=? AND agent_key=? AND event_id=? AND revision=?",
						)
						.get(
							input.harness,
							input.session_key,
							input.agent_key,
							input.event_id,
							input.revision,
						);
					if (previous) {
						if (
							Object.keys(e).some(
								(k) =>
									![
										"suggestion_id",
										"attempt_id",
										"binding",
										"received_at",
										...(input.cost_source === "reported"
											? []
											: ["cost_usd", "cost_source"]),
									].includes(k) && previous[k] !== e[k],
							)
						)
							throw new Error("event identity/revision payload conflict");
						continue;
					}
					db.query(
						`INSERT INTO attempt_events(${Object.keys(e).join(",")}) VALUES(${Object.keys(
							e,
						)
							.map((k) => `$${k}`)
							.join(",")})`,
					).run(e);
					const newest = db
						.query<{ revision: number }, [string, string, string, string]>(
							"SELECT MAX(revision) AS revision FROM attempt_events WHERE harness=? AND session_key=? AND agent_key=? AND event_id=?",
						)
						.get(
							input.harness,
							input.session_key,
							input.agent_key,
							input.event_id,
						);
					if (newest?.revision === input.revision) {
						resolve(e as unknown as Row, idle, roots);
						contexts.set(
							JSON.stringify([
								input.harness,
								input.session_key,
								input.agent_key,
							]),
							input,
						);
					}
				}
				for (const input of delegates.values()) {
					reconcile(input, idle, roots);
					const child = db
						.query<{ agent_id: string }, [string, string]>(
							"SELECT agent_id FROM dispatches WHERE session_id=? AND tool_use_id=?",
						)
						.get(input.session_key, input.call_id ?? "");
					if (child)
						reconcile({ ...input, agent_key: child.agent_id }, idle, roots);
				}
				for (const c of contexts.values()) reconcile(c, idle, roots, true);
				for (const root of roots) chain(root);
			}).immediate();
		},
		reconcileAttempts(c, idle = DEFAULT_TUNING.openWindowMs) {
			db.transaction(() => repair(c, idle)).immediate();
		},
		reportAttempt(input) {
			if (input.confirm && !input.attempt_id)
				throw new Error("--confirm requires --attempt");
			if (input.confirm && input.correct)
				throw new Error("--confirm cannot be combined with --correct");
			if (
				input.rounds != null &&
				(!Number.isSafeInteger(input.rounds) || input.rounds < 0)
			)
				throw new Error("rounds must be a non-negative safe integer");
			if (
				!Object.hasOwn(REPORT_VALUES, input.result) ||
				!Number.isSafeInteger(input.at) ||
				input.at < 0
			)
				throw new Error("invalid report result/time");
			return db
				.transaction(() => {
					assertSuggestion(input.suggestion_id);
					checkPair(input.model, input.effort);
					let a = input.attempt_id
						? get(input.attempt_id)
						: db
								.query<AttemptRecord, [string, string, string]>(
									"SELECT * FROM attempts WHERE suggestion_id=? AND (model=? OR model IS NULL) AND (effort=? OR effort IS NULL) ORDER BY ordinal DESC LIMIT 1",
								)
								.get(input.suggestion_id, input.model, input.effort);
					if (
						input.attempt_id &&
						(!a ||
							a.suggestion_id !== input.suggestion_id ||
							!compatible(a, input))
					)
						throw new Error("report attempt ownership/pair conflict");
					const report = a
						? db
								.query<{ value: number; revision: number }, [string]>(
									"SELECT value,revision FROM latest_attempt_events WHERE attempt_id=? AND kind='report'",
								)
								.get(a.id)
						: null;
					if (input.correct && !report)
						throw new Error("--correct requires a prior report");
					if (
						input.confirm &&
						report &&
						report.value !== REPORT_VALUES[input.result]
					)
						throw new Error(
							"--confirm cannot change a prior verdict; use --correct",
						);
					if (
						!input.correct &&
						a &&
						report &&
						report.value === REPORT_VALUES[input.result]
					)
						return outcome(a);
					if (!a || (report && !input.correct))
						a = add(
							input.suggestion_id,
							`report:${crypto.randomUUID()}`,
							input.model,
							input.effort,
							input.at,
							context(input.suggestion_id),
						);
					fill(a, input);
					const c = db
						.query<AttemptContext, [string]>(
							"SELECT harness,session_key,agent_key FROM attempts WHERE id=?",
						)
						.get(a.id);
					if (!c) throw new Error("missing report context");
					if (input.turn_id)
						alias({
							...c,
							attempt_id: a.id,
							id_kind: "turn",
							external_id: input.turn_id,
						});
					api.recordAttemptEvents([
						{
							...c,
							event_id: `report:${a.id}`,
							revision: input.correct && report ? report.revision + 1 : 0,
							attempt_id: a.id,
							suggestion_id: input.suggestion_id,
							kind: "report",
							source: "report",
							rounds: input.rounds,
							note: input.note,
							turn_id: input.turn_id,
							model: input.model,
							effort: input.effort,
							value: REPORT_VALUES[input.result],
							weight: 1,
							occurred_at: input.at,
							received_at: input.at,
						},
					]);
					db.query(
						"UPDATE attempts SET closed_at=?,finalized_at=? WHERE id=?",
					).run(input.at, input.at, a.id);
					store().closeSuggestion(input.suggestion_id, input.at);
					chain(a.root_id);
					const reported = get(a.id);
					if (!reported) throw new Error("missing reported attempt");
					return outcome(reported);
				})
				.immediate();
		},
		finalizeAttempts(c, at, successQuality = DEFAULT_TUNING.successQuality) {
			db.transaction(() => {
				const attempts = db
					.query<AttemptRecord, [string, string, string, number]>(
						"SELECT * FROM attempts WHERE harness=? AND session_key=? AND agent_key=? AND opened_at<=?",
					)
					.all(c.harness, c.session_key, c.agent_key, at);
				for (const a of attempts) {
					db.query(
						"UPDATE attempts SET finalized_at=?,closed_at=COALESCE(closed_at,? + 1) WHERE id=?",
					).run(at, at, a.id);
					db.query("UPDATE attempts SET success_quality=? WHERE id=?").run(
						successQuality,
						a.root_id,
					);
					chain(a.root_id);
				}
			}).immediate();
		},
		attemptOwnsUsage(c) {
			return !!db
				.query(
					"SELECT 1 FROM attempts WHERE harness=? AND session_key=? AND agent_key=? AND owns_usage=1 LIMIT 1",
				)
				.get(c.harness, c.session_key, c.agent_key);
		},
	};
	return api;
}
