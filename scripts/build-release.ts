import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import pkg from "../packages/cli/package.json";
import { releaseVersion } from "./release-version.ts";

const root = resolve(import.meta.dir, "..");

/** Build only for the host: DuckDB's native addon must match the executable. */
export async function buildRelease(version = pkg.version, outDir = "dist") {
	releaseVersion(`v${version}`);
	const target = `${process.platform}-${process.arch}`;
	if (
		!["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(target)
	)
		throw new Error(`Unsupported release target: ${target}`);
	const out = resolve(outDir);
	await mkdir(out, { recursive: true });
	const stage = await mkdtemp(join(out, ".stage-"));
	const name = `spatz-cli-${version}-${target}`;
	const dir = join(stage, name);
	await mkdir(dir);
	try {
		const api = Bun.resolveSync(
			"@duckdb/node-api",
			join(root, "packages/core"),
		);
		const bindings = Bun.resolveSync("@duckdb/node-bindings", dirname(api));
		const native = Bun.resolveSync(
			`@duckdb/node-bindings-${target}/duckdb.node`,
			dirname(bindings),
		);
		const library =
			process.platform === "darwin" ? "libduckdb.dylib" : "libduckdb.so";
		for (const file of ["duckdb.node", library])
			await copyFile(join(dirname(native), file), join(dir, file));
		for (const file of ["LICENSE", "README.md"])
			await copyFile(join(root, file), join(dir, file));
		const result = await Bun.build({
			entrypoints: [join(root, "packages/cli/src/cli.ts")],
			compile: {
				outfile: join(dir, "spatz"),
				autoloadDotenv: false,
				autoloadBunfig: false,
			},
			define: { SPATZ_VERSION: JSON.stringify(version) },
			plugins: [
				{
					name: "duckdb-sidecar",
					setup(build) {
						build.onResolve({ filter: /^@duckdb\/node-bindings$/ }, () => ({
							path: "binding",
							namespace: "sidecar",
						}));
						build.onLoad({ filter: /.*/, namespace: "sidecar" }, () => ({
							loader: "js",
							contents:
								'module.exports = require(require("node:path").join(require("node:path").dirname(require("node:fs").realpathSync(process.execPath)), "duckdb.node"));',
						}));
					},
				},
			],
		});
		if (!result.success)
			throw new AggregateError(result.logs, "Release build failed");
		const archive = join(out, `${name}.tar.gz`);
		const tar = Bun.spawn(["tar", "-czf", archive, "-C", stage, name], {
			stdout: "inherit",
			stderr: "inherit",
		});
		if (await tar.exited) throw new Error("Release archive failed");
		const sha = createHash("sha256")
			.update(await Bun.file(archive).bytes())
			.digest("hex");
		await Bun.write(`${archive}.sha256`, `${sha}  ${basename(archive)}\n`);
		return archive;
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

if (import.meta.main)
	console.log(await buildRelease(process.argv[2], process.argv[3]));
