import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildPlugins } from "./build-plugins.ts";
import { setReleaseVersion } from "./release-version.ts";

test.skipIf(process.platform === "win32")(
	"plugin archives carry matching versions, hooks and verified release sources",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "spatz-plugins-"));
		try {
			for (const path of [
				".claude-plugin",
				"packages/claude-mod",
				"packages/claude-hooks",
				"packages/codex-hooks",
				"packages/cli/package.json",
			])
				await cp(resolve(import.meta.dir, "..", path), join(root, path), {
					recursive: true,
				});
			const version = "9.8.7-rc.1+build-test";
			const out = join(root, "dist");
			await expect(
				buildPlugins(version, `v${version}`, out, root),
			).rejects.toThrow("Version mismatch");
			await setReleaseVersion(`v${version}`, root);
			for (const tag of [`v${version}`, "nightly"]) {
				const file = await buildPlugins(version, tag, out, root);
				const marketplace = await Bun.file(file).json();
				expect(marketplace.name).toBe("spatz");
				expect(marketplace.plugins).toHaveLength(2);
				for (const plugin of marketplace.plugins) {
					const name =
						plugin.name === "spatz"
							? "spatz-claude-plugin"
							: "spatz-claude-hooks";
					const archive = join(out, `${name}-9.8.7-rc.1-build-test.zip`);
					const sha256 = createHash("sha256")
						.update(await Bun.file(archive).bytes())
						.digest("hex");
					expect(plugin.source).toEqual({
						source: "archive",
						url: `https://github.com/lorenzh/spatz/releases/download/${encodeURIComponent(tag)}/${basename(archive)}`,
						sha256,
					});
					expect(await Bun.file(`${archive}.sha256`).text()).toBe(
						`${sha256}  ${basename(archive)}\n`,
					);
					const extract = join(root, `extract-${tag}-${plugin.name}`);
					const unpack = Bun.spawn(["unzip", "-q", archive, "-d", extract]);
					expect(await unpack.exited).toBe(0);
					const manifest = await Bun.file(
						join(extract, ".claude-plugin/plugin.json"),
					).json();
					expect(manifest.name).toBe(plugin.name);
					expect(manifest.version).toBe(version);
					expect(
						await Bun.file(join(extract, "hooks/hooks.json")).exists(),
					).toBe(true);
				}
				const codexArchive = join(
					out,
					"spatz-codex-hooks-9.8.7-rc.1-build-test.zip",
				);
				const codexSha256 = createHash("sha256")
					.update(await Bun.file(codexArchive).bytes())
					.digest("hex");
				expect(await Bun.file(`${codexArchive}.sha256`).text()).toBe(
					`${codexSha256}  ${basename(codexArchive)}\n`,
				);
				const codexExtract = join(root, `extract-${tag}-codex`);
				expect(
					await Bun.spawn(["unzip", "-q", codexArchive, "-d", codexExtract])
						.exited,
				).toBe(0);
				expect(
					(
						await Bun.file(
							join(codexExtract, ".codex-plugin/plugin.json"),
						).json()
					).name,
				).toBe("spatz-hooks");
				expect(
					await Bun.file(join(codexExtract, "hooks/hooks.json")).exists(),
				).toBe(true);
				const sha256 = createHash("sha256")
					.update(await Bun.file(file).bytes())
					.digest("hex");
				expect(await Bun.file(`${file}.sha256`).text()).toBe(
					`${sha256}  marketplace.json\n`,
				);
			}
			await expect(buildPlugins(version, "v1.0.0", out, root)).rejects.toThrow(
				"does not match",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
