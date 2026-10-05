import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	rename,
	rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { releaseVersion } from "./release-version.ts";

export const platforms = [
	"linux-x64",
	"linux-arm64",
	"darwin-arm64",
	"darwin-x64",
	"win32-x64",
] as const;
const repository = {
	type: "git",
	url: "git+https://github.com/lorenzh/spatz.git",
};

export function npmVersion(input: string): string {
	const { version } = releaseVersion(
		input.startsWith("v") ? input : `v${input}`,
	);
	if (/-nightly\.[0-9]{8}\+/.test(version)) {
		if (!/-nightly\.[0-9]{8}\+[a-f0-9]+$/.test(version))
			throw new Error("Invalid nightly SHA");
		return version.replace("+", ".g");
	}
	return version.replace(/\+.*$/, "");
}

export function npmDistTag(version: string): string {
	const mapped = npmVersion(version);
	return /-nightly\.[0-9]{8}\.g[a-f0-9]+$/.test(mapped)
		? "nightly"
		: releaseVersion(`v${mapped}`).prerelease
			? "next"
			: "latest";
}

export async function buildNpmPackages(
	archiveDir: string,
	release: string,
	outputDir: string,
	targets: readonly string[] = platforms,
) {
	const version = npmVersion(release);
	const out = resolve(outputDir);
	await mkdir(out, { recursive: true });
	const stage = await mkdtemp(join(out, ".extract-"));
	const optionalDependencies: Record<string, string> = {};
	try {
		for (const target of targets) {
			if (!platforms.includes(target as (typeof platforms)[number]))
				throw new Error(`Unsupported target: ${target}`);
			const name = `spatz-cli-${release.replace(/^v/, "").replaceAll("+", "-")}-${target}`;
			const windows = target === "win32-x64";
			const archive = resolve(
				archiveDir,
				`${name}.${windows ? "zip" : "tar.gz"}`,
			);
			if (!(await Bun.file(archive).exists())) {
				if (!windows) throw new Error(`Missing archive for ${target}`);
				console.warn("Skipping experimental win32-x64: archive is missing");
				continue;
			}
			const unpack = Bun.spawn(
				windows
					? ["unzip", "-q", archive, "-d", stage]
					: ["tar", "-xzf", archive, "-C", stage],
				{ stdout: "inherit", stderr: "inherit" },
			);
			if (await unpack.exited) throw new Error(`Failed to extract ${archive}`);
			const dir = join(out, `cli-${target}`);
			await rename(join(stage, name), dir);
			const binary = windows ? "spatz.exe" : "spatz";
			const library = windows
				? "duckdb.dll"
				: target.startsWith("darwin")
					? "libduckdb.dylib"
					: "libduckdb.so";
			for (const file of [binary, "duckdb.node", library]) {
				if (!(await Bun.file(join(dir, file)).exists()))
					throw new Error(`Missing ${target}/${file}`);
			}
			if (!windows) await chmod(join(dir, binary), 0o755);
			const packageName = `@spatz/cli-${target}`;
			await Bun.write(
				join(dir, "package.json"),
				`${JSON.stringify({ name: packageName, version, description: `spatz CLI binary for ${target}`, license: "MIT", repository, os: [target.split("-")[0]], cpu: [target.split("-")[1]], files: await readdir(dir), preferUnplugged: true }, null, 2)}\n`,
			);
			await copyFile(
				new URL("../LICENSE", import.meta.url),
				join(dir, "LICENSE"),
			);
			await Bun.write(
				join(dir, "README.md"),
				`# ${packageName}\n\nPlatform binary for [@spatz/cli](https://www.npmjs.com/package/@spatz/cli). Install that package to use spatz.\n`,
			);
			optionalDependencies[packageName] = version;
		}
		const main = join(out, "cli");
		await mkdir(join(main, "bin"), { recursive: true });
		await Bun.write(
			join(main, "package.json"),
			`${JSON.stringify({ name: "@spatz/cli", version, description: "Model and effort recommendations for coding agents", bin: { spatz: "bin/spatz.js" }, optionalDependencies, engines: { node: ">=18" }, license: "MIT", repository, files: ["bin"] }, null, 2)}\n`,
		);
		await copyFile(
			new URL("npm-launcher.cjs", import.meta.url),
			join(main, "bin/spatz.js"),
		);
		await chmod(join(main, "bin/spatz.js"), 0o755);
		for (const file of ["README.md", "LICENSE"])
			await copyFile(new URL(`../${file}`, import.meta.url), join(main, file));
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const [archives, version, output, target] = process.argv.slice(2);
	if (!archives || !version || !output)
		throw new Error(
			"Usage: bun scripts/npm-packages.ts <archives> <version> <output> [single-target-for-local-test]",
		);
	await buildNpmPackages(
		archives,
		version,
		output,
		target ? [target] : platforms,
	);
}
