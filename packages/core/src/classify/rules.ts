// classify: keyword rules used whenever Jev is not involved, and the local secret filter.
// Spec: "Fallback", "Privacy".
import type {
	Classification,
	Criticality,
	FallbackReason,
} from "../contracts/types.ts";

// ponytail: plain substring match, so "author" counts as auth; good enough for a fallback that only raises criticality.
const CRITICALITY_KEYWORDS: [Criticality, string[]][] = [
	[
		"security",
		[
			"auth",
			"login",
			"permission",
			"password",
			"token",
			"secret",
			"anmeld",
			"berechtigung",
			"passwort",
			"passwört",
			"kennwort",
			"kennwört",
			"geheim",
		],
	],
	[
		"data_integrity",
		[
			"migration",
			"delete",
			"backup",
			"data loss",
			"lösch",
			"sicherung",
			"datenverlust",
		],
	],
	[
		"business_logic",
		[
			"payment",
			"price",
			"billing",
			"invoice",
			"contract",
			"zahlung",
			"preis",
			"abrechnung",
			"rechnung",
			"vertrag",
			"verträg",
		],
	],
];

/** task_type other, difficulty mittel, criticality from keywords (auth, password, migration, payment, ...), best_candidate null, fallback_used true. */
export function classifyByRules(
	task: string,
	reason: FallbackReason,
): Classification {
	const text = task.toLowerCase();
	const hit = CRITICALITY_KEYWORDS.find(([, words]) =>
		words.some((w) => text.includes(w)),
	);
	return {
		task_type: "other",
		difficulty: "mittel",
		criticality: hit?.[0] ?? "none",
		best_candidate: null,
		probabilities: null,
		model_ref: null,
		fallback_used: true,
		fallback_reason: reason,
	};
}

const SECRET_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{20,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	// Token prefixes: GitHub, GitLab, Slack, Google, Stripe, npm, JWT.
	/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{36})/,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./,
	// password=x, DB_PASSWORD=x, password: "x", {"password":"x"}; an unquoted "password: x" is prose.
	/(?:password|passwd|pwd|secret|token|api[_-]?key)["']?\s*(?:=\s*\S|:\s*["'][^"'\s])/i,
];

/** true when the text looks like it contains a secret (API keys, private keys, password=). */
export function containsSecret(text: string): boolean {
	return SECRET_PATTERNS.some((p) => p.test(text));
}
