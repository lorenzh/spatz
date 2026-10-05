import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	HARNESSES,
	type HarnessCatalog,
	type HarnessModel,
	parseHarnessCatalog,
} from "../packages/core/src/catalog/harness.ts";
import { EFFORTS, type Effort } from "../packages/core/src/contracts/types.ts";
import { assertNoDroppedModels } from "./accept-harness-catalog.ts";

const efforts = (values: unknown): Effort[] =>
	Array.isArray(values)
		? EFFORTS.filter((effort) => values.includes(effort))
		: [];
const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Read the embedded picker data, never execute JavaScript from the package. */
export function parseClaudeModelCatalog(source: string): HarnessModel[] {
	const marker =
		'{$schema:"https://downloads.claude.ai/model-catalog/v1/schema.json"';
	const start = source.indexOf(marker);
	if (start < 0)
		throw new Error("Claude Code embedded picker catalog is missing");
	let depth = 0;
	let literal = "";
	for (const token of source.slice(start).matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)) {
		if (token[0] === "{") depth++;
		if (token[0] === "}") depth--;
		if (depth === 0) {
			literal = source.slice(start, start + token.index + 1);
			break;
		}
	}
	// The generated data uses unquoted keys and !0/!1 booleans. Strings stay untouched.
	const json = literal.replace(
		/"(?:\\.|[^"\\])*"|([A-Za-z_$][\w$]*)(?=\s*:)|!([01])/g,
		(token, key, bool) =>
			key
				? JSON.stringify(key)
				: bool
					? bool === "0"
						? "true"
						: "false"
					: token,
	);
	const data = object(JSON.parse(json));
	if (data.schema_version !== 1)
		throw new Error("Unknown Claude Code picker schema");
	const configs = object(object(data.surfaces).cc).model_selector_config;
	if (!Array.isArray(configs))
		throw new Error("Claude Code picker configurations are missing");
	const rows = object(configs.find((row) => object(row).id === "cc")).models;
	if (!Array.isArray(rows))
		throw new Error("Claude Code picker models are missing");
	const models = rows
		.map(object)
		.filter(
			(row) =>
				row.section === "main" &&
				row.disabled !== true &&
				Array.isArray(row.offered_on) &&
				row.offered_on.includes("first_party"),
		)
		.map((row) => {
			if (
				typeof row.id !== "string" ||
				!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.id)
			)
				throw new Error(
					`Claude Code main picker has unsafe model id: ${String(row.id)}`,
				);
			const options = object(row.thinking).effort_options;
			const levels = object(row.runtime).effort_levels;
			const empty = (v: unknown) =>
				v === undefined || (Array.isArray(v) && !v.length);
			if (empty(options) && empty(levels))
				return { id: String(row.id), efforts: ["none"] as Effort[] };
			if (!Array.isArray(options))
				throw new Error(`Claude Code ${row.id} has invalid effort options`);
			const runtime = efforts(levels);
			const supported = efforts(
				options.map((option) => object(option).id),
			).filter((e) => runtime.includes(e));
			if (!supported.length)
				throw new Error(`Claude Code ${row.id} has no supported efforts`);
			return { id: String(row.id), efforts: supported };
		})
		.sort((a, b) => a.id.localeCompare(b.id, "en"));
	if (!models.length)
		throw new Error("Claude Code picker extraction returned no current models");
	return models;
}

/** Keep visible Codex picker entries from its newest GPT major generation. */
export function parseCodexModelCatalog(value: unknown): HarnessModel[] {
	const rows = object(value).models;
	if (!Array.isArray(rows)) throw new Error("Codex picker models are missing");
	const visible = rows
		.map(object)
		.filter((model) => model.visibility === "list");
	const major = Math.max(
		...visible.map((model) =>
			Number(/^gpt-(\d+)/.exec(String(model.slug))?.[1] ?? 0),
		),
	);
	const models = visible
		.filter((model) =>
			new RegExp(`^gpt-${major}(?:\\.|-|$)`).test(String(model.slug)),
		)
		.map((model) => {
			const supported = efforts(
				Array.isArray(model.supported_reasoning_levels)
					? model.supported_reasoning_levels.map((item) => object(item).effort)
					: [],
			).filter((effort) => effort !== "none");
			if (!supported.length)
				throw new Error(`Codex ${model.slug} has no supported efforts`);
			return { id: String(model.slug), efforts: supported };
		})
		.sort((a, b) => a.id.localeCompare(b.id, "en"));
	if (!models.length)
		throw new Error("Codex picker extraction returned no current models");
	return models;
}

function run(command: string, args: string[], cwd: string): string {
	const result = Bun.spawnSync([command, ...args], {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: cwd,
			CODEX_HOME: join(cwd, ".codex"),
			CLAUDE_CONFIG_DIR: join(cwd, ".claude"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`,
		);
	return new TextDecoder().decode(result.stdout);
}

async function install(pkg: string, dir: string): Promise<string> {
	run(
		"npm",
		[
			"install",
			"--no-save",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			pkg,
		],
		dir,
	);
	const nodeModules = join(dir, "node_modules");
	const packageName = pkg.slice(0, pkg.lastIndexOf("@"));
	const metadata = JSON.parse(
		await readFile(join(nodeModules, packageName, "package.json"), "utf8"),
	);
	return metadata.version as string;
}

async function extractClaude(dir: string) {
	const version = await install("@anthropic-ai/claude-code@latest", dir);
	const platform = process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const binary = join(
		dir,
		`node_modules/@anthropic-ai/claude-code-${platform}-${arch}/claude`,
	);
	const bytes = await Bun.file(binary).arrayBuffer();
	const strings = new TextDecoder("latin1").decode(bytes);
	return { version, models: parseClaudeModelCatalog(strings) };
}

async function extractCodex(dir: string) {
	const version = await install("@openai/codex@latest", dir);
	await mkdir(join(dir, ".codex"));
	const binary = join(dir, "node_modules/@openai/codex/bin/codex.js");
	const output = run(
		process.execPath,
		[binary, "debug", "models", "--bundled"],
		dir,
	);
	return { version, models: parseCodexModelCatalog(JSON.parse(output)) };
}

/**
 * Keep the file and source versions unchanged until the model data changes.
 * Refuse to drop a current model unless `allowDrop` is set.
 */
export async function writeHarnessCatalog(
	outputPath: string,
	harnesses: HarnessCatalog["harnesses"],
	allowDrop = false,
): Promise<HarnessCatalog> {
	const catalog: HarnessCatalog = {
		schema: 1,
		updated: new Date().toISOString().slice(0, 10),
		harnesses,
	};
	if (!parseHarnessCatalog(catalog))
		throw new Error("Extracted harness catalog failed schema validation");
	const old = parseHarnessCatalog(
		await Bun.file(outputPath)
			.json()
			.catch(() => null),
	);
	if (!allowDrop) assertNoDroppedModels(old, catalog);
	if (
		old &&
		HARNESSES.every(
			(h) =>
				JSON.stringify(old.harnesses[h].models) ===
				JSON.stringify(harnesses[h].models),
		)
	)
		return old;
	await mkdir(resolve(outputPath, ".."), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify(catalog, null, "\t")}\n`);
	return catalog;
}

export async function extractHarnessCatalog(
	outputPath = resolve(import.meta.dir, "../catalog/harness-models.json"),
	allowDrop = false,
) {
	const temp = await mkdtemp(join(tmpdir(), "spatz-harness-catalog-"));
	try {
		await Promise.all([
			mkdir(join(temp, "claude")),
			mkdir(join(temp, "codex")),
		]);
		const [claude, codex] = await Promise.all([
			extractClaude(join(temp, "claude")),
			extractCodex(join(temp, "codex")),
		]);
		return await writeHarnessCatalog(
			outputPath,
			{ "claude-code": claude, codex },
			allowDrop,
		);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2);
		const catalog = await extractHarnessCatalog(
			args.find((arg) => arg !== "--allow-drop"),
			args.includes("--allow-drop"),
		);
		console.log(JSON.stringify(catalog, null, 2));
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
