import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRow } from "../contracts/eval-row.ts";
import type { SuggestionRecord } from "../contracts/types.ts";
import { openStore } from "./index.ts";

const row = (over: Partial<EvalRow> = {}): EvalRow => ({
	schema: "spatz-eval-row/1",
	run_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
	bench_version: "1",
	task_id: "sample/e1",
	task_version: 1,
	task_type: "code.bugfix",
	difficulty: "easy",
	criticality: "none",
	harness: "claude-code",
	agent_version: "2.1.289",
	model: "anthropic/claude-opus-5.5",
	effort: "high",
	answered_model: "claude-opus-5-5",
	model_version: null,
	attempt: 1,
	result: "pass",
	check: "tests",
	judge: null,
	duration_s: 41.2,
	tokens: {
		input: 6,
		output: 1095,
		cache_read: 43895,
		cache_write: 4490,
		reasoning: 169,
	},
	cost_usd: 0.31,
	estimated_cost_usd: 0.066623,
	started_at: "2026-10-06T09:00:00.000Z",
	contributor: "anon-01234567",
	verified: true,
	...over,
});
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noUsage = {
	tokens: {
		input: null,
		output: null,
		cache_read: null,
		cache_write: null,
		reasoning: null,
	},
	cost_usd: null,
	estimated_cost_usd: null,
} as const;

let stored: () => Record<string, unknown>[];

function withStore(fn: (store: ReturnType<typeof openStore>) => void) {
	const dir = mkdtempSync(join(tmpdir(), "spatz-bench-"));
	const path = join(dir, "spatz.db");
	const store = openStore(path);
	stored = () => {
		const db = new Database(path, { readonly: true });
		try {
			return db
				.query("SELECT * FROM bench_attempts ORDER BY run_id")
				.all() as Record<string, unknown>[];
		} finally {
			db.close();
		}
	};
	try {
		fn(store);
	} finally {
		store.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("importEvalRows stores each run_id once and reports which rows are new", () => {
	withStore((store) => {
		const rows = [
			{ row: row({ run_id: id(1) }), task_hash: "hmac-sha256:aa" },
			{ row: row({ run_id: id(2) }), task_hash: null },
			{ row: row({ run_id: id(1) }), task_hash: "hmac-sha256:aa" },
		];
		expect(store.importEvalRows(rows, 1000, false)).toEqual([
			true,
			true,
			false,
		]);
		expect(store.importEvalRows(rows, 2000, false)).toEqual([
			false,
			false,
			false,
		]);
		expect(stored().map((r) => r.run_id)).toEqual([id(1), id(2)]);
	});
});

test("a dry run reports the same counts and stores nothing", () => {
	withStore((store) => {
		const rows = [
			{ row: row({ run_id: id(1) }), task_hash: null },
			{ row: row({ run_id: id(1) }), task_hash: null },
		];
		expect(store.importEvalRows(rows, 1000, true)).toEqual([true, false]);
		expect(stored()).toEqual([]);
	});
});

test("cost_source: reported cost, list-price estimate, or unavailable without usage", () => {
	withStore((store) => {
		store.importEvalRows(
			[
				{ row: row({ run_id: id(1) }), task_hash: "h1" },
				{
					row: row({
						run_id: id(2),
						harness: "codex",
						model: "openai/gpt-6.1-sol",
						tokens: {
							input: 4539,
							output: 1223,
							cache_read: 56320,
							cache_write: null,
							reasoning: 197,
						},
						cost_usd: null,
						estimated_cost_usd: 0.02694,
					}),
					task_hash: null,
				},
				{ row: row({ run_id: id(3), ...noUsage }), task_hash: null },
			],
			1000,
			false,
		);
		expect(stored()).toEqual([
			expect.objectContaining({
				run_id: id(1),
				cost_usd: 0.31,
				cost_source: "reported",
				estimated_cost_usd: 0.066623,
				tokens_complete: 1,
				task_hash: "h1",
				bench_version: "1",
			}),
			expect.objectContaining({
				run_id: id(2),
				cost_usd: 0.02694,
				cost_source: "priced",
				cache_creation_tokens: null,
				tokens_complete: 0,
			}),
			expect.objectContaining({
				run_id: id(3),
				cost_usd: null,
				cost_source: "unavailable",
				estimated_cost_usd: null,
				input_tokens: null,
				tokens_complete: 0,
			}),
		]);
	});
});

test("bench rows never enter live cell stats", () => {
	withStore((store) => {
		store.importEvalRows(
			[{ row: row({ run_id: id(1) }), task_hash: null }],
			1000,
			false,
		);
		expect(store.cellStats("code.bugfix")).toEqual([]);
		expect(store.pending(0, 2000)).toEqual([]);
	});
});

test("benchPriors weighs rubric rows 0.5 and counts passes as successes", () => {
	withStore((store) => {
		store.importEvalRows(
			[
				{ row: row({ run_id: id(1) }), task_hash: null },
				{ row: row({ run_id: id(2), result: "partial" }), task_hash: null },
				{
					row: row({
						run_id: id(3),
						check: "rubric",
						judge: "anthropic/claude-opus-5.5:2026-10",
					}),
					task_hash: null,
				},
			],
			1000,
			false,
		);
		expect(store.benchPriors()).toEqual([
			{
				task_type: "code.bugfix",
				difficulty: "easy",
				model: "anthropic/claude-opus-5.5",
				effort: "high",
				n_eff: 2.5,
				s_eff: 1.5,
				n_bench: 3,
				version_match: "unknown",
			},
		]);
	});
});

const suggestion = (sid: string): SuggestionRecord => ({
	id: sid,
	created_at: 1000,
	session_id: null,
	prompt_id: null,
	task_type: "code.bugfix",
	difficulty: "easy",
	criticality: "none",
	probabilities: null,
	model_ref: null,
	strategy: "rules",
	ranking: [],
	reason: "test",
	explored: false,
	control: false,
	fallback_used: true,
	fallback_reason: null,
	is_test: false,
	last_event_at: 1000,
	closed_at: null,
	scope: null,
	agent: null,
	turn_id: null,
	agent_id: null,
});

test("a bench row of another known model version seeds no prior", () => {
	withStore((store) => {
		store.insertSuggestion(suggestion("s1"));
		store.reportAttempt({
			suggestion_id: "s1",
			model: "anthropic/claude-opus-5.5",
			effort: "high",
			result: "pass",
			at: 1000,
			model_version: "20261001",
		});
		store.importEvalRows(
			[
				{
					row: row({ run_id: id(1), model_version: "20260901" }),
					task_hash: null,
				},
				{
					row: row({ run_id: id(2), model_version: "20261001" }),
					task_hash: null,
				},
			],
			1000,
			false,
		);
		expect(store.benchPriors()).toEqual([
			expect.objectContaining({ n_bench: 1, version_match: "exact" }),
		]);
	});
});
