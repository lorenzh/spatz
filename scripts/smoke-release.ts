import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import fixture from "../packages/core/src/catalog/fixtures/openrouter-models.json";
import { parseOpenRouterModels } from "../packages/core/src/catalog/openrouter.ts";

export async function smokeRelease(archive: string, version: string) {
	const sha = createHash("sha256")
		.update(await Bun.file(archive).bytes())
		.digest("hex");
	assert.equal(
		await Bun.file(`${archive}.sha256`).text(),
		`${sha}  ${basename(archive)}\n`,
	);
	const home = await mkdtemp(join(tmpdir(), "spatz-smoke-"));
	try {
		const tar = Bun.spawn(["tar", "-xzf", resolve(archive), "-C", home], {
			stdout: "inherit",
			stderr: "inherit",
		});
		assert.equal(await tar.exited, 0);
		const dir = join(home, basename(archive, ".tar.gz"));
		for (const file of ["LICENSE", "README.md"])
			assert.ok(await Bun.file(join(dir, file)).exists(), `Missing ${file}`);
		// Exercise the documented PATH symlink and native lookup from another cwd.
		const binary = join(home, "spatz");
		await symlink(join(dir, "spatz"), binary);
		await Bun.write(
			join(home, ".spatz/openrouter-models.json"),
			JSON.stringify({
				fetched_at: Date.now(),
				models: parseOpenRouterModels(fixture),
			}),
		);
		async function run(args: string[]) {
			const child = Bun.spawn([binary, ...args], {
				cwd: home,
				env: {
					HOME: home,
					SPATZ_NO_JEV: "1",
					HTTPS_PROXY: "http://127.0.0.1:9",
					HTTP_PROXY: "http://127.0.0.1:9",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			assert.equal(code, 0, stderr);
			assert.equal(stderr, "");
			return stdout;
		}
		assert.equal(await run(["--version"]), `${version}\n`);
		const suggestion = JSON.parse(
			await run([
				"release smoke test",
				"--models",
				"gpt-6-luna:low",
				"--dry-run",
				"--json",
			]),
		);
		assert.equal(suggestion.is_test, true);
		assert.equal(suggestion.fallback_used, true);
		const stats = JSON.parse(await run(["stats", "--json"]));
		assert.deepEqual(stats.by_type, []);
		assert.equal(stats.coverage, 0);
		console.log(
			`Smoke passed: ${basename(archive)} (--version: ${version}, dry-run, stats)`,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	assert.ok(
		process.argv[2] && process.argv[3],
		"Usage: bun scripts/smoke-release.ts <archive> <version>",
	);
	await smokeRelease(process.argv[2], process.argv[3]);
}
