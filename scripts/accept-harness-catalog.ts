import {
	HARNESSES,
	type HarnessCatalog,
	parseHarnessCatalog,
} from "../packages/core/src/catalog/harness.ts";

/** Models in `current` that `next` no longer lists, as `harness/id`. */
export const droppedHarnessModels = (
	current: HarnessCatalog,
	next: HarnessCatalog,
): string[] =>
	HARNESSES.flatMap((h) =>
		current.harnesses[h].models
			.filter(({ id }) => !next.harnesses[h].models.some((m) => m.id === id))
			.map(({ id }) => `${h}/${id}`),
	);

export function assertNoDroppedModels(
	current: HarnessCatalog | null,
	next: HarnessCatalog,
) {
	const dropped = current ? droppedHarnessModels(current, next) : [];
	if (dropped.length)
		throw new Error(
			`Harness catalog drops current models: ${dropped.join(", ")}. Run bun scripts/harness-catalog.ts --allow-drop locally to accept this.`,
		);
}

/**
 * Copy a downloaded catalog over the checked-in one. Writes only the known
 * fields, so the artifact cannot add anything else, and refuses to drop models.
 */
export async function acceptHarnessCatalog(
	artifactPath: string,
	outputPath: string,
) {
	const file = Bun.file(artifactPath);
	const catalog =
		file.size <= 256 * 1024 ? parseHarnessCatalog(await file.json()) : null;
	if (!catalog) throw new Error("Invalid harness catalog artifact");
	assertNoDroppedModels(
		parseHarnessCatalog(
			await Bun.file(outputPath)
				.json()
				.catch(() => null),
		),
		catalog,
	);
	await Bun.write(outputPath, `${JSON.stringify(catalog, null, "\t")}\n`);
}

if (import.meta.main) {
	const [artifact, output] = process.argv.slice(2);
	if (!artifact || !output)
		throw new Error(
			"Usage: bun scripts/accept-harness-catalog.ts <artifact> <output>",
		);
	await acceptHarnessCatalog(artifact, output);
}
