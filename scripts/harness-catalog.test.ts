import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_HARNESS_CATALOG } from "../packages/core/src/catalog/harness.ts";
import {
	parseClaudeModelCatalog,
	parseCodexModelCatalog,
	writeHarnessCatalog,
} from "./harness-catalog.ts";

describe("harness picker parsers", () => {
	test("selects every enabled first-party main model regardless of family", async () => {
		const fixture = await readFile(
			new URL("./fixtures/claude-picker-strings.txt", import.meta.url),
			"utf8",
		);
		expect(parseClaudeModelCatalog(fixture)).toEqual([
			{ id: "claude-fable-5-1", efforts: ["high", "max"] },
			{ id: "claude-haiku-4-5-20251001", efforts: ["none"] },
			{
				id: "claude-opus-5",
				efforts: ["low", "medium", "high", "xhigh", "max"],
			},
			{
				id: "claude-opus-5-5",
				efforts: ["low", "medium", "high", "xhigh", "max"],
			},
			{
				id: "claude-sonnet-5-5",
				efforts: ["low", "medium", "high", "xhigh", "max"],
			},
		]);
		expect(() => parseClaudeModelCatalog("no model strings")).toThrow();
		expect(() =>
			parseClaudeModelCatalog(
				fixture.replace("schema_version:1", "schema_version:2"),
			),
		).toThrow();
		expect(
			parseClaudeModelCatalog(
				fixture.replace('family:"sonnet"', 'family:"missing"'),
			),
		).toEqual(parseClaudeModelCatalog(fixture));
		expect(() =>
			parseClaudeModelCatalog(
				fixture.replaceAll('section:"main"', 'section:"overflow"'),
			),
		).toThrow();
		expect(() =>
			parseClaudeModelCatalog(
				fixture.replaceAll(
					'effort_levels:["low","medium","high","xhigh","max"]',
					"effort_levels:[]",
				),
			),
		).toThrow();
	});

	test("selects visible models from Codex's newest generation and intersects efforts", async () => {
		const fixture = JSON.parse(
			await readFile(
				new URL("./fixtures/codex-picker.json", import.meta.url),
				"utf8",
			),
		);
		expect(parseCodexModelCatalog(fixture)).toEqual([
			{ id: "gpt-6-astra", efforts: ["low", "medium", "high", "ultra"] },
			{
				id: "gpt-6.1-sol",
				efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
			},
		]);
		fixture.models.push({ ...fixture.models[1], slug: "gpt-6-sol" });
		expect(parseCodexModelCatalog(fixture).map((m) => m.id)).toEqual([
			"gpt-6-astra",
			"gpt-6-sol",
			"gpt-6.1-sol",
		]);
		expect(() => parseCodexModelCatalog({ models: [] })).toThrow();
		expect(() =>
			parseCodexModelCatalog({
				models: [
					{
						slug: "gpt-7-test",
						visibility: "list",
						supported_reasoning_levels: [],
					},
				],
			}),
		).toThrow();
		expect(() => parseCodexModelCatalog(null)).toThrow();
	});
});

test("version-only changes leave catalog bytes, mtime and updated untouched", async () => {
	const dir = await mkdtemp(join(tmpdir(), "spatz-catalog-write-"));
	const file = join(dir, "harness-models.json");
	try {
		const old = {
			...structuredClone(BUNDLED_HARNESS_CATALOG),
			updated: "2020-01-01",
		};
		const bytes = JSON.stringify(old);
		await Bun.write(file, bytes);
		const before = await stat(file);
		const harnesses = structuredClone(old.harnesses);
		harnesses.codex.version = "999.0.0";
		expect(await writeHarnessCatalog(file, harnesses)).toEqual(old);
		expect(await Bun.file(file).text()).toBe(bytes);
		expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
		harnesses.codex.models.push({ id: "gpt-future", efforts: ["max"] });
		const changed = await writeHarnessCatalog(file, harnesses);
		expect(changed.updated).toBe(new Date().toISOString().slice(0, 10));
		expect(changed.harnesses.codex.version).toBe("999.0.0");
		expect(await Bun.file(file).json()).toEqual(changed);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("refuses a catalog that drops a current model unless allowed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "spatz-catalog-drop-"));
	const file = join(dir, "harness-models.json");
	try {
		const bytes = JSON.stringify(BUNDLED_HARNESS_CATALOG);
		await Bun.write(file, bytes);
		const harnesses = structuredClone(BUNDLED_HARNESS_CATALOG.harnesses);
		const gone = harnesses.codex.models.shift()?.id;
		harnesses.codex.models.push({ id: "gpt-future", efforts: ["max"] });
		await expect(writeHarnessCatalog(file, harnesses)).rejects.toThrow(
			`codex/${gone}`,
		);
		expect(await Bun.file(file).text()).toBe(bytes);
		const allowed = await writeHarnessCatalog(file, harnesses, true);
		expect(await Bun.file(file).json()).toEqual(allowed);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow isolates extraction and validates only the catalog before publishing", async () => {
	const workflow = Bun.YAML.parse(
		await Bun.file(
			new URL("../.github/workflows/harness-catalog.yml", import.meta.url),
		).text(),
	) as {
		jobs: Record<
			string,
			{
				needs?: string;
				if?: string;
				permissions: Record<string, string>;
				"timeout-minutes": number;
				steps: {
					id?: string;
					uses?: string;
					run?: string;
					with?: Record<string, unknown>;
				}[];
			}
		>;
	};
	const extract = workflow.jobs.extract;
	const publish = workflow.jobs.publish;
	if (!extract || !publish) throw new Error("Missing catalog jobs");
	expect(extract.permissions).toEqual({ contents: "read" });
	expect(publish.permissions).toEqual({
		contents: "write",
		"pull-requests": "write",
	});
	expect(publish.needs).toBe("test");
	const tests = workflow.jobs.test;
	const report = workflow.jobs.report;
	if (!tests || !report) throw new Error("Missing catalog gate jobs");
	// Tests run third-party dev dependencies, so they stay out of the write job.
	expect(tests.needs).toBe("extract");
	expect(tests.permissions).toEqual({ contents: "read" });
	const testRuns = tests.steps.map((s) => s.run ?? "");
	expect(
		testRuns.findIndex((r) => r.includes("accept-harness-catalog.ts")),
	).toBeLessThan(testRuns.indexOf("bun test"));
	expect(testRuns).toContain("bun test");
	expect(report.permissions).toEqual({ actions: "read", issues: "write" });
	expect(report.if).toBe("failure()");
	expect(report["timeout-minutes"]).toBeGreaterThan(0);
	for (const step of report.steps) {
		expect(step.uses).toBeUndefined();
		expect(step.run ?? "").not.toContain("${{");
	}
	expect(report.steps.map((s) => s.run ?? "").join("\n")).toContain(
		"gh issue create",
	);
	for (const job of [extract, tests, publish]) {
		expect(job["timeout-minutes"]).toBeGreaterThan(0);
		expect(job.steps[0]?.with).toEqual({
			ref: "main",
			"persist-credentials": false,
		});
		for (const step of job.steps) {
			if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
			if (step.run) expect(step.run).not.toContain("${{");
		}
	}
	expect(
		extract.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))
			?.with?.path,
	).toBe("catalog/harness-models.json");
	expect(publish.steps.map((s) => s.run ?? "").join("\n")).not.toContain(
		"scripts/harness-catalog.ts",
	);
	const validate = publish.steps.find((s) => s.id === "validate")?.run;
	if (!validate) throw new Error("Missing validation step");
	// The tests run against the exact bytes that publish commits.
	expect(tests.steps.find((s) => s.id === "validate")?.run).toBe(validate);
	const temp = await mkdtemp(join(tmpdir(), "spatz-catalog-publish-"));
	try {
		await mkdir(join(temp, "harness-catalog"));
		await mkdir(join(temp, "catalog"));
		await symlink(
			new URL("../packages", import.meta.url).pathname,
			join(temp, "packages"),
		);
		await symlink(
			new URL("../scripts", import.meta.url).pathname,
			join(temp, "scripts"),
		);
		const output = join(temp, "catalog/harness-models.json");
		const artifact = join(temp, "harness-catalog/harness-models.json");
		await Bun.write(
			join(temp, "harness-catalog/untrusted.ts"),
			'throw new Error("must not execute")',
		);
		for (const valid of [true, false]) {
			await Bun.write(output, "original");
			await Bun.write(
				artifact,
				JSON.stringify(
					valid
						? { ...BUNDLED_HARNESS_CATALOG, injected: "dropped" }
						: { schema: 1 },
				),
			);
			const result = Bun.spawnSync(["bash", "-eu", "-c", validate], {
				cwd: temp,
				env: { ...process.env, RUNNER_TEMP: temp },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(result.exitCode === 0).toBe(valid);
			// Publish writes only the known fields, formatted like the extractor.
			expect(await Bun.file(output).text()).toBe(
				valid
					? `${JSON.stringify(BUNDLED_HARNESS_CATALOG, null, "\t")}\n`
					: "original",
			);
			expect(await Bun.file(join(temp, "catalog/untrusted.ts")).exists()).toBe(
				false,
			);
		}
		// A catalog that drops a current model is refused and main stays as is.
		const current = `${JSON.stringify(BUNDLED_HARNESS_CATALOG, null, "\t")}\n`;
		await Bun.write(output, current);
		const shrunk = structuredClone(BUNDLED_HARNESS_CATALOG);
		shrunk.harnesses["claude-code"].models.pop();
		await Bun.write(artifact, JSON.stringify(shrunk));
		const result = Bun.spawnSync(["bash", "-eu", "-c", validate], {
			cwd: temp,
			env: { ...process.env, RUNNER_TEMP: temp },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).not.toBe(0);
		expect(new TextDecoder().decode(result.stderr)).toContain("drops");
		expect(await Bun.file(output).text()).toBe(current);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("Claude rejects unsafe main IDs and effort schema drift", async () => {
	const fixture = await Bun.file(
		new URL("./fixtures/claude-picker-strings.txt", import.meta.url),
	).text();
	for (const replacement of ["unsafe:id", "../escape", "x".repeat(65)])
		expect(() =>
			parseClaudeModelCatalog(fixture.replace("claude-fable-5-1", replacement)),
		).toThrow("unsafe model id");
	for (const field of ["effort_options", "effort_levels"])
		expect(() =>
			parseClaudeModelCatalog(fixture.replaceAll(field, "renamed")),
		).toThrow();
	for (const value of ["null", '"high"', '["high"]'])
		expect(() =>
			parseClaudeModelCatalog(
				fixture.replace(
					'runtime:{family:"haiku"}',
					`runtime:{family:"haiku",effort_levels:${value}}`,
				),
			),
		).toThrow();
	expect(
		parseClaudeModelCatalog(
			fixture.replace(
				'runtime:{family:"haiku"}',
				'thinking:{effort_options:[]},runtime:{family:"haiku",effort_levels:[]}',
			),
		).find((m) => m.id.includes("haiku"))?.efforts,
	).toEqual(["none"]);
});
test("Codex reasoning-off none is excluded, including none-only models", () => {
	const model = {
		slug: "gpt-6-test",
		visibility: "list",
		supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }],
	};
	expect(parseCodexModelCatalog({ models: [model] })).toEqual([
		{ id: "gpt-6-test", efforts: ["high"] },
	]);
	model.supported_reasoning_levels.pop();
	expect(() => parseCodexModelCatalog({ models: [model] })).toThrow(
		"no supported efforts",
	);
});
