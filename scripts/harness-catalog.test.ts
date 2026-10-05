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
	test("selects the newest Opus and Sonnet IDs from Claude's embedded catalog", async () => {
		const fixture = await readFile(
			new URL("./fixtures/claude-picker-strings.txt", import.meta.url),
			"utf8",
		);
		expect(parseClaudeModelCatalog(fixture)).toEqual([
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
		expect(() =>
			parseClaudeModelCatalog(
				fixture.replace('family:"sonnet"', 'family:"missing"'),
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
			{ id: "gpt-6-astra", efforts: ["low", "medium", "high"] },
			{ id: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh", "max"] },
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
	expect(publish.needs).toBe("extract");
	for (const job of [extract, publish]) {
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
	const temp = await mkdtemp(join(tmpdir(), "spatz-catalog-publish-"));
	try {
		await mkdir(join(temp, "harness-catalog"));
		await mkdir(join(temp, "catalog"));
		await symlink(
			new URL("../packages", import.meta.url).pathname,
			join(temp, "packages"),
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
				JSON.stringify(valid ? BUNDLED_HARNESS_CATALOG : { schema: 1 }),
			);
			const result = Bun.spawnSync(["bash", "-eu", "-c", validate], {
				cwd: temp,
				env: { ...process.env, RUNNER_TEMP: temp },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(result.exitCode === 0).toBe(valid);
			expect(await Bun.file(output).text()).toBe(
				valid ? await Bun.file(artifact).text() : "original",
			);
			expect(await Bun.file(join(temp, "catalog/untrusted.ts")).exists()).toBe(
				false,
			);
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
