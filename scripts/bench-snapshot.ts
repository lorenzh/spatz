// Refreshes catalog/bench-snapshot.json, the offline fallback bundled into each build, from the latest
// spatz-measurements release. Run at release time: bun scripts/bench-snapshot.ts
import { join } from "node:path";
import { fetchSnapshot } from "../packages/core/src/catalog/snapshot.ts";
import type { FetchFn } from "../packages/core/src/contracts/deps.ts";

/** Writes the verified release bytes to outPath; throws (and writes nothing) on any failure. */
export async function refreshBundledSnapshot(
	fetch: FetchFn,
	outPath: string,
): Promise<string> {
	const { text, snapshot } = await fetchSnapshot(
		fetch,
		AbortSignal.timeout(30_000),
	);
	await Bun.write(outPath, text);
	return `bench snapshot ${snapshot.commit.slice(0, 7)} of ${snapshot.generated_at.slice(0, 10)}, ${snapshot.cells.length} cells`;
}

if (import.meta.main)
	console.log(
		await refreshBundledSnapshot(
			(input, init) => fetch(input, init),
			join(import.meta.dir, "..", "catalog", "bench-snapshot.json"),
		),
	);
