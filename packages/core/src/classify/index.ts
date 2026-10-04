// classify: Jev adapter (4 questions in one request) and fallback orchestration.
// Spec: "Klassifikation mit Jev", "Zugang", "Fallback", "Privacy".
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevClient, JevRequest, JevResult } from "../contracts/deps.ts";
import {
	type Catalog,
	type Classification,
	type Config,
	type Criticality,
	DIFFICULTIES,
	type Difficulty,
	type FallbackReason,
	JEV_MODEL,
	type TaskType,
	type Tuning,
} from "../contracts/types.ts";
import { classifyByRules, containsSecret } from "./rules.ts";

/** Wraps @typesafe-ai/sdk TypeSafeClient: apiKey passed explicitly (from TYPESAFE_AI_API_KEY), logLevel "off", retry.maxRetries 0, defaultModel JEV_MODEL. Never logs the key. */
export function createJevClient(apiKey: string): JevClient {
	return new TypeSafeClient({
		apiKey,
		defaultModel: JEV_MODEL,
		logLevel: "off",
		retry: { maxRetries: 0 },
	});
}

/** One-line descriptions per option, verbatim from the spec tables (Jev uses them as option boundaries). */
export const TASK_TYPE_DESCRIPTIONS: Record<TaskType, string> = {
	"code.bugfix": "Ein Fehler im bestehenden Code wird gefunden und behoben.",
	"code.feature": "Neuer Code fügt eine Funktion hinzu.",
	"code.refactor":
		"Der Code ändert seine Struktur, das Verhalten bleibt gleich.",
	"code.explain": "Der Agent erklärt Code und ändert nichts.",
	review: "Der Agent prüft fremde Arbeit: ein Review oder eine Verifikation.",
	spec: "Der Agent schreibt oder ändert eine Spezifikation.",
	planning: "Der Agent plant Schritte, Architektur oder Vorgehen ohne Code.",
	other: "Keine der anderen Optionen passt.",
};

const DIFFICULTY_RUBRIC = [
	"leicht: Klarer Auftrag mit wenig Kontext. Ein Ort oder ein Thema.",
	"mittel: Mehrere Stellen oder Themen. Der Weg braucht etwas Analyse.",
	"schwer: Viele Teile, eine unklare Ursache, eine Entwurfsentscheidung oder viel Kontext.",
] as const;

const CRITICALITY_DESCRIPTIONS: Record<Criticality, string> = {
	none: "Normale Änderung ohne die Risiken unten. Auch sichtbare Fehler gehören hierher.",
	business_logic: "Geld, Preise, Abrechnung, Verträge oder rechtliche Regeln.",
	security: "Anmeldung, Berechtigungen, Geheimnisse oder Schwachstellen.",
	data_integrity:
		"Gespeicherte Daten: Migrationen, Löschen oder Schutz vor Datenverlust.",
};

export function buildJevRequest(task: string, catalog: Catalog): JevRequest {
	return {
		model: JEV_MODEL,
		state: task,
		questions: {
			task_type: {
				type: "choice",
				instructions:
					"Welche Art von Aufgabe für einen Coding-Agenten ist das?",
				criteria: TASK_TYPE_DESCRIPTIONS,
			},
			difficulty: {
				type: "score",
				instructions: "Wie schwer ist die Aufgabe?",
				criteria: DIFFICULTY_RUBRIC,
			},
			criticality: {
				type: "choice",
				instructions: "Welches Risiko trägt die Änderung?",
				criteria: CRITICALITY_DESCRIPTIONS,
			},
			best_candidate: {
				type: "choice",
				instructions:
					"Wähle das günstigste Paar aus Modell und Effort, das die Aufgabe zuverlässig löst.",
				criteria: Object.fromEntries(
					catalog.map((c) => [`${c.model}:${c.effort}`, c.description]),
				),
			},
		},
	};
}

/** Maps Jev answers to a Classification (score keys "0","1","2" -> leicht, mittel, schwer) and applies the round-up rule. */
export function parseJevResult(
	result: JevResult,
	catalog: Catalog,
	tuning: Tuning,
): Classification {
	const { task_type, difficulty, criticality, best_candidate } = result.answers;
	const difficultyProbabilities = Object.fromEntries(
		DIFFICULTIES.map((d, i) => [d, difficulty.probabilities[String(i)] ?? 0]),
	) as Record<Difficulty, number>;
	const keys = new Set(catalog.map((c) => `${c.model}:${c.effort}`));
	return {
		task_type: task_type.choice as TaskType,
		difficulty: roundUpDifficulty(
			difficultyProbabilities,
			tuning.difficultyMinProbability,
		),
		criticality: criticality.choice as Criticality,
		best_candidate: keys.has(best_candidate.choice)
			? best_candidate.choice
			: null,
		probabilities: {
			task_type: task_type.probabilities,
			difficulty: difficultyProbabilities,
			criticality: criticality.probabilities,
			best_candidate: best_candidate.probabilities,
		},
		model_ref: result.model,
		fallback_used: false,
		fallback_reason: null,
	};
}

/** Top-probability level; if that probability < minProbability, one level up (schwer stays schwer). */
export function roundUpDifficulty(
	probabilities: Record<Difficulty, number>,
	minProbability: number,
): Difficulty {
	let top = 0;
	DIFFICULTIES.forEach((d, i) => {
		if (probabilities[d] > probabilities[DIFFICULTIES[top] as Difficulty])
			top = i;
	});
	const level =
		probabilities[DIFFICULTIES[top] as Difficulty] < minProbability
			? Math.min(top + 1, DIFFICULTIES.length - 1)
			: top;
	return DIFFICULTIES[level] as Difficulty;
}

/** Maps SDK errors by name: APITimeoutError -> timeout, AuthenticationError -> auth, RateLimitError -> rate_limit, else error. */
export function fallbackReasonFor(error: unknown): FallbackReason {
	const name = error instanceof Error ? error.name : "";
	if (name === "APITimeoutError") return "timeout";
	if (name === "AuthenticationError") return "auth";
	if (name === "RateLimitError") return "rate_limit";
	return "error";
}

/** Never throws. Opt-out, secret in text, no client, or any Jev error -> rules fallback. */
export async function classify(
	task: string,
	catalog: Catalog,
	jev: JevClient | null,
	config: Config,
): Promise<Classification> {
	if (!config.jevEnabled) return classifyByRules(task, "opt_out");
	if (containsSecret(task)) return classifyByRules(task, "secret");
	if (!jev) return classifyByRules(task, "no_key");
	try {
		const result = await jev.systemOne(buildJevRequest(task, catalog), {
			timeout: config.tuning.jevTimeoutMs,
		});
		return parseJevResult(result, catalog, config.tuning);
	} catch (error) {
		return classifyByRules(task, fallbackReasonFor(error));
	}
}
