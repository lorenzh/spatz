import {
	type Decision,
	MODES,
	type Mode,
	SCOPES,
	type Scope,
} from "./bridge.ts";

export const RECORDS = ["auto", "on", "off"] as const;
export type RecordSetting = (typeof RECORDS)[number];

export interface Settings {
	mode: Mode;
	scope: Scope;
	/** Main-session rewrites in apply mode need this explicit opt-in: a model switch drops the prompt cache. */
	main: boolean;
	record: RecordSetting;
	/** turn and escalate skip prompts shorter than this and keep the last decision. */
	minPromptChars: number;
	/** escalate switches to the next stronger pair after this many failing test/build results. */
	escalateAfter: number;
	/** Leave a spawn alone when it names a model or an agent type other than general-purpose (the hook cannot see whether a type pins a model). */
	respectPinned: boolean;
	/** Allow exploration picks (a cheaper pair to collect data) on hard or critical tasks. */
	exploreHard: boolean;
	spatz: string;
	models: string[];
}

type Options = Readonly<Record<string, unknown>>;

const oneOf = <T extends string>(
	list: readonly T[],
	value: unknown,
	fallback: T,
): T => (list.includes(value as T) ? (value as T) : fallback);

const count = (value: unknown, fallback: number) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: fallback;

export function readSettings(options: Options): Settings {
	const text = (key: string, fallback: string) =>
		typeof options[key] === "string" && options[key]
			? (options[key] as string)
			: fallback;
	return {
		mode: oneOf(MODES, options.mode, "show"),
		scope: oneOf(SCOPES, options.scope, "subagent"),
		main: options.main === true || options.main === "true",
		record: oneOf(RECORDS, options.record, "auto"),
		minPromptChars: count(options.minPromptChars, 20),
		escalateAfter: Math.max(1, count(options.escalateAfter, 2)),
		respectPinned: !(
			options.respectPinned === false || options.respectPinned === "false"
		),
		exploreHard: options.exploreHard === true || options.exploreHard === "true",
		spatz: text("spatz", "spatz"),
		models: text("models", "")
			.split(",")
			.map((model) => model.trim())
			.filter(Boolean),
	};
}

export const USAGE =
	"usage: /spatz [status] | mode <off|show|apply> | scope <step|turn|subagent|session|escalate> | record <auto|on|off> | main <on|off>";

export function describeDecision(d: Decision | undefined): string {
	return d
		? `${d.model}:${d.effort} (${d.scope}${d.escalated ? ", escalated" : ""})`
		: "none yet";
}

/** The band text: the last recommendation with its scope; undefined clears it. */
export function band(s: Settings, d: Decision | undefined): string | undefined {
	if (s.mode === "off" || !d) return undefined;
	return `spatz ${s.mode}: ${describeDecision(d)}`;
}

/** Runs one `/spatz` argument line against the settings and returns the answer. `status` is the caller's job. */
export function change(s: Settings, args: string): string | null {
	const [key, value, extra] = args.trim().split(/\s+/);
	if (extra !== undefined) return null;
	if (key === "mode" && (MODES as readonly string[]).includes(value ?? "")) {
		s.mode = value as Mode;
	} else if (
		key === "scope" &&
		(SCOPES as readonly string[]).includes(value ?? "")
	) {
		s.scope = value as Scope;
	} else if (
		key === "record" &&
		(RECORDS as readonly string[]).includes(value ?? "")
	) {
		s.record = value as RecordSetting;
	} else if (key === "main" && (value === "on" || value === "off")) {
		s.main = value === "on";
	} else return null;
	return `spatz: ${key} is now ${value}`;
}
