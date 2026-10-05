import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseVersion, setReleaseVersion } from "./release-version.ts";

test("release tags require strict semver and detect prereleases", () => {
	expect(releaseVersion("v1.2.3")).toEqual({
		version: "1.2.3",
		prerelease: false,
	});
	expect(releaseVersion("v1.2.3-rc.1+build.42")).toEqual({
		version: "1.2.3-rc.1+build.42",
		prerelease: true,
	});
	expect(releaseVersion("v1.2.3+build-with-hyphens").prerelease).toBe(false);
	for (const tag of [
		"1.2.3",
		"v1.2",
		"v01.2.3",
		"v1.2.3-01",
		"v1.2.3-",
		"v1.2.3+",
		"v1.2.3\n",
		"v1.2.3/evil",
	]) {
		expect(() => releaseVersion(tag)).toThrow("Invalid release tag");
	}
});

test("release versions stamp the CLI, all plugins and marketplace entries", async () => {
	const root = await mkdtemp(join(tmpdir(), "spatz-version-"));
	const paths = [
		"packages/cli/package.json",
		"packages/claude-mod/.claude-plugin/plugin.json",
		"packages/claude-hooks/.claude-plugin/plugin.json",
		"packages/codex-hooks/.codex-plugin/plugin.json",
		".claude-plugin/marketplace.json",
		"skills/spatz/SKILL.md",
	] as const;
	try {
		for (const path of paths)
			await cp(resolve(import.meta.dir, "..", path), join(root, path), {
				recursive: true,
			});
		for (const tag of [
			"v2.3.4",
			"v2.3.4-rc.1",
			"v2.3.4-nightly.20261005+abc1234",
		]) {
			const before = await Promise.all(
				paths.map((path) => Bun.file(join(root, path)).text()),
			);
			await setReleaseVersion(tag, root);
			for (const [index, path] of paths.entries())
				expect(before[index]?.split("\n").length).toBe(
					(await Bun.file(join(root, path)).text()).split("\n").length,
				);
			for (const path of paths.slice(0, 4))
				expect((await Bun.file(join(root, path)).json()).version).toBe(
					tag.slice(1),
				);
			for (const name of ["claude-mod", "claude-hooks", "codex-hooks"]) {
				const launcher = await Bun.file(
					join(root, `packages/${name}/bin/spatz`),
				).text();
				expect(launcher).toContain(`@spatz/cli@${tag.slice(1)}`);
			}
			const marketplace = await Bun.file(join(root, paths[4])).json();
			expect(
				marketplace.plugins.map(
					(p: { name: string; version: string; source: string }) => [
						p.name,
						p.version,
						p.source,
					],
				),
			).toEqual([
				["spatz-mod", tag.slice(1), "./packages/claude-mod"],
				["spatz", tag.slice(1), "./packages/claude-hooks"],
			]);
		}
		await expect(setReleaseVersion("vnot-semver", root)).rejects.toThrow(
			"Invalid release tag",
		);
		expect((await Bun.file(join(root, paths[0])).json()).version).toBe(
			"2.3.4-nightly.20261005+abc1234",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
