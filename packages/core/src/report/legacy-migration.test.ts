import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, SCHEMA_VERSION } from "../store/index.ts";
import baseline from "./fixtures/v7-stats.json";
import { runStats } from "./index.ts";

// Captured with the unmodified v7 store/report at baseline.captured_from.
// Keep this snapshot independent of the current queries and migration code.
test("frozen previous-schema outcomes, learning and statistics survive migration", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spatz-legacy-stats-"));
	const dbPath = join(dir, "spatz.db");
	try {
		const previous = new Database(dbPath);
		try {
			previous.run(
				await Bun.file(
					join(import.meta.dir, "../store/fixtures/v7.sql"),
				).text(),
			);
			expect(previous.query("PRAGMA user_version").get()).toEqual({
				user_version: 7,
			});
			expect(
				previous.query("SELECT * FROM outcomes ORDER BY suggestion_id").all(),
			).toEqual(baseline.outcomes);
		} finally {
			previous.close();
		}
		const store = openStore(dbPath);
		try {
			for (const type of [
				"code.bugfix",
				"code.feature",
				"review",
				"other",
			] as const) {
				const cells = store
					.cellStats(type)
					// The baseline predates binary success counts.
					.map(({ successes: _, ...c }) => c)
					.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
				expect(baseline.learning[type]).toEqual(cells);
			}
			const proof = store.cellStats("code.feature")[0];
			if (!proof) throw new Error("missing legacy proof outcome");
			expect((1 + proof.sum_quality) / (2 + proof.n)).toBe(2 / 3);
			expect(proof.successes).toBe(1);
		} finally {
			store.dispose();
		}
		const migrated = new Database(dbPath, { readonly: true });
		try {
			expect(migrated.query("PRAGMA user_version").get()).toEqual({
				user_version: SCHEMA_VERSION,
			});
			expect(
				migrated.query("SELECT * FROM outcomes ORDER BY suggestion_id").all(),
			).toEqual(baseline.outcomes);
			expect(
				migrated
					.query(
						"SELECT suggestion_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_creation_tokens) AS cache_creation_tokens FROM usage_totals GROUP BY suggestion_id ORDER BY suggestion_id",
					)
					.all(),
			).toEqual(baseline.tokens);
			expect(
				migrated
					.query(
						"SELECT tokens_complete,cost_usd,lower_bound FROM usage_totals WHERE suggestion_id='r' AND model='m/a'",
					)
					.get(),
			).toEqual({ tokens_complete: 0, cost_usd: null, lower_bound: 0 });
			expect(
				migrated
					.query(
						"SELECT COUNT(*) AS n FROM suggestions WHERE is_legacy <> 1 OR closed_at IS NULL",
					)
					.get(),
			).toEqual({ n: 0 });
		} finally {
			migrated.close();
		}
		const result = await runStats({
			dbPath,
			successQuality: 0.8,
			by: "scope",
		});
		// Unknown legacy completeness stays unpriced without a lower-bound warning.
		expect(
			result.by_type.find((row) => row.task_type === "review"),
		).toMatchObject({ incomplete: 0 });
		// Preserve the frozen statistics; lower-bound counts are new in v9, fallback_success is newer.
		expect<unknown>(result).toMatchObject({
			...baseline.stats,
			fallback_success: null,
			// New in v11: per-source coverage.
			coverage_by_source: result.coverage_by_source,
			by_scope: baseline.stats.by_scope.map((row) => ({
				...row,
				incomplete: 0,
			})),
			by_type: baseline.stats.by_type.map((row) => {
				const cache = baseline.caches.find(
					(c) => c.task_type === row.task_type,
				);
				if (!cache)
					throw new Error(`missing frozen cache totals for ${row.task_type}`);
				return {
					...row,
					incomplete: 0,
					cache_read_tokens: cache.cache_read_tokens,
					cache_creation_tokens: cache.cache_creation_tokens,
				};
			}),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
