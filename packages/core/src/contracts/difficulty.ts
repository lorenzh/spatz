import {
	DIFFICULTIES,
	type Difficulty,
	type JevProbabilities,
} from "./types.ts";

/** Input aliases for clients and rows written before schema v4. */
export const LEGACY_DIFFICULTIES = {
	leicht: "easy",
	mittel: "medium",
	schwer: "hard",
} as const;
export type DifficultyInput = Difficulty | keyof typeof LEGACY_DIFFICULTIES;

export function normalizeDifficulty(value: DifficultyInput): Difficulty {
	return value in LEGACY_DIFFICULTIES
		? LEGACY_DIFFICULTIES[value as keyof typeof LEGACY_DIFFICULTIES]
		: (value as Difficulty);
}

/** English keys take precedence if both spellings exist. */
export function difficultyProbabilities(
	values: Record<string, number>,
): Record<Difficulty, number> {
	return Object.fromEntries(
		DIFFICULTIES.map((d, i) => [
			d,
			values[d] ??
				values[Object.keys(LEGACY_DIFFICULTIES)[i] as string] ??
				values[String(i)] ??
				0,
		]),
	) as Record<Difficulty, number>;
}

export function normalizeProbabilities(
	values: JevProbabilities | null,
): JevProbabilities | null {
	return (
		values && {
			...values,
			difficulty: difficultyProbabilities(values.difficulty),
		}
	);
}

/** Only these generated pooling labels contained German; model IDs stay intact. */
export function normalizeReason(reason: string): string {
	return reason
		.replaceAll("leicht+mittel+schwer level", "easy+medium+hard level")
		.replaceAll("mittel+schwer level", "medium+hard level");
}

/** Internal SQL column expression, shared by SQLite and DuckDB reads. */
export function difficultySql(column: string): string {
	return `CASE ${column} WHEN 'leicht' THEN 'easy' WHEN 'mittel' THEN 'medium' WHEN 'schwer' THEN 'hard' ELSE ${column} END`;
}
