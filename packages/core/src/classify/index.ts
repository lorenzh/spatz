// classify: Jev adapter (4 questions in one request) and fallback orchestration.
// Spec: "Classification with Jev", "Access", "Fallback", "Privacy".
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevClient, JevRequest, JevResult } from "../contracts/deps.ts";
import { difficultyProbabilities } from "../contracts/difficulty.ts";
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

/** One-line descriptions per option, translated from the spec tables (Jev uses them as option boundaries). */
export const TASK_TYPE_DESCRIPTIONS: Record<TaskType, string> = {
	"code.bugfix": "Find and fix a bug in existing code.",
	"code.feature": "Add a feature with new code.",
	"code.refactor": "Change the code structure without changing its behavior.",
	"code.explain": "Explain code without changing it.",
	review: "Review or verify someone else's work.",
	spec: "Write or change a specification.",
	planning: "Plan steps, architecture or an approach without writing code.",
	other: "None of the other options fits.",
};

const DIFFICULTY_RUBRIC = [
	"easy: A clear task with little context. One place or one topic.",
	"medium: Several places or topics. The approach needs some analysis.",
	"hard: Many parts, an unclear cause, a design decision or much context.",
] as const;

const CRITICALITY_DESCRIPTIONS: Record<Criticality, string> = {
	none: "A normal change without the risks below. Visible bugs also belong here.",
	business_logic: "Money, prices, billing, contracts or legal rules.",
	security: "Login, permissions, secrets or vulnerabilities.",
	data_integrity:
		"Stored data: migrations, deletion or protection against data loss.",
};

export function buildJevRequest(task: string, catalog: Catalog): JevRequest {
	return {
		model: JEV_MODEL,
		state: task,
		questions: {
			task_type: {
				type: "choice",
				instructions: "What kind of task is this for a coding agent?",
				criteria: TASK_TYPE_DESCRIPTIONS,
			},
			difficulty: {
				type: "score",
				instructions: "How difficult is the task?",
				criteria: DIFFICULTY_RUBRIC,
			},
			criticality: {
				type: "choice",
				instructions: "What risk does the change carry?",
				criteria: CRITICALITY_DESCRIPTIONS,
			},
			best_candidate: {
				type: "choice",
				instructions:
					"Choose the cheapest model and effort pair that can reliably solve the task.",
				criteria: Object.fromEntries(
					catalog.map((c) => [`${c.model}:${c.effort}`, c.description]),
				),
			},
		},
	};
}

/** Maps Jev answers to a Classification (score keys "0","1","2" -> easy, medium, hard) and applies the round-up rule. */
export function parseJevResult(
	result: JevResult,
	catalog: Catalog,
	tuning: Tuning,
): Classification {
	const { task_type, difficulty, criticality, best_candidate } = result.answers;
	const probabilities = difficultyProbabilities(difficulty.probabilities);
	const keys = new Set(catalog.map((c) => `${c.model}:${c.effort}`));
	return {
		task_type: task_type.choice as TaskType,
		difficulty: roundUpDifficulty(
			probabilities,
			tuning.difficultyMinProbability,
		),
		criticality: criticality.choice as Criticality,
		best_candidate: keys.has(best_candidate.choice)
			? best_candidate.choice
			: null,
		probabilities: {
			task_type: task_type.probabilities,
			difficulty: probabilities,
			criticality: criticality.probabilities,
			best_candidate: best_candidate.probabilities,
		},
		model_ref: result.model,
		fallback_used: false,
		fallback_reason: null,
	};
}

/** Top-probability level; if that probability < minProbability, one level up (hard stays hard). */
export function roundUpDifficulty(
	values: Record<string, number>,
	minProbability: number,
): Difficulty {
	const probabilities = difficultyProbabilities(values);
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
