import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { syncPluginAssets } from "./plugin-assets.ts";
import { releaseVersion } from "./release-version.ts";

/** Run on Linux with zip installed, after release-version.ts stamps the manifests. */
export async function buildPlugins(
	version: string,
	tag = `v${version}`,
	outDir = "dist",
	root = resolve(import.meta.dir, ".."),
) {
	releaseVersion(`v${version}`);
	if (tag !== "nightly" && tag !== `v${version}`)
		throw new Error("Plugin release tag does not match its version");
	await syncPluginAssets(root);
	const out = resolve(outDir);
	await mkdir(out, { recursive: true });
	const marketplace = await Bun.file(
		join(root, ".claude-plugin/marketplace.json"),
	).json();
	for (const plugin of marketplace.plugins) {
		const dir = join(root, plugin.source);
		const manifest = await Bun.file(
			join(dir, ".claude-plugin/plugin.json"),
		).json();
		if (manifest.version !== version || plugin.version !== version)
			throw new Error(
				`Version mismatch for ${plugin.name}; run release-version.ts`,
			);
		const name =
			plugin.name === "spatz" ? "spatz-claude-plugin" : "spatz-claude-hooks";
		const archive = join(out, `${name}-${version.replaceAll("+", "-")}.zip`);
		// zip updates existing files; remove an old archive so deleted files cannot survive.
		await rm(archive, { force: true });
		const pack = Bun.spawn(
			[
				"zip",
				"-qr",
				archive,
				".",
				"-x",
				"node_modules/*",
				".claude-plugin/types/*",
				"tsconfig.json",
			],
			{ cwd: dir, stdout: "inherit", stderr: "inherit" },
		);
		if (await pack.exited)
			throw new Error(`Plugin archive failed: ${plugin.name}`);
		const sha256 = createHash("sha256")
			.update(await Bun.file(archive).bytes())
			.digest("hex");
		await Bun.write(`${archive}.sha256`, `${sha256}  ${basename(archive)}\n`);
		plugin.source = {
			source: "archive",
			url: `https://github.com/lorenzh/spatz/releases/download/${encodeURIComponent(tag)}/${basename(archive)}`,
			sha256,
		};
	}
	const codexArchive = join(
		out,
		`spatz-codex-hooks-${version.replaceAll("+", "-")}.zip`,
	);
	await rm(codexArchive, { force: true });
	const codexPack = Bun.spawn(["zip", "-qr", codexArchive, "."], {
		cwd: join(root, "packages/codex-hooks"),
		stdout: "inherit",
		stderr: "inherit",
	});
	if (await codexPack.exited)
		throw new Error("Plugin archive failed: spatz-hooks (Codex)");
	const codexSha256 = createHash("sha256")
		.update(await Bun.file(codexArchive).bytes())
		.digest("hex");
	await Bun.write(
		`${codexArchive}.sha256`,
		`${codexSha256}  ${basename(codexArchive)}\n`,
	);
	const file = join(out, "marketplace.json");
	await Bun.write(file, `${JSON.stringify(marketplace, null, "\t")}\n`);
	const sha256 = createHash("sha256")
		.update(await Bun.file(file).bytes())
		.digest("hex");
	await Bun.write(`${file}.sha256`, `${sha256}  marketplace.json\n`);
	return file;
}

if (import.meta.main) {
	if (!process.argv[2])
		throw new Error(
			"Usage: bun scripts/build-plugins.ts <version> [tag] [output]",
		);
	console.log(
		await buildPlugins(process.argv[2], process.argv[3], process.argv[4]),
	);
}
