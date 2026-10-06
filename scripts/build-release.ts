import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import pkg from "../packages/cli/package.json";
import { releaseVersion } from "./release-version.ts";

const root = resolve(import.meta.dir, "..");

/** Build only for the host target. */
export async function buildRelease(version = pkg.version, outDir = "dist") {
	releaseVersion(`v${version}`);
	const target = `${process.platform}-${process.arch}`;
	if (
		![
			"linux-x64",
			"linux-arm64",
			"darwin-x64",
			"darwin-arm64",
			"win32-x64",
		].includes(target)
	)
		throw new Error(`Unsupported release target: ${target}`);
	const out = resolve(outDir);
	await mkdir(out, { recursive: true });
	const stage = await mkdtemp(join(out, ".stage-"));
	const safeVersion = version.replaceAll("+", "-");
	const name = `spatz-cli-${safeVersion}-${target}`;
	const dir = join(stage, name);
	await mkdir(dir);
	try {
		for (const file of ["LICENSE", "README.md"])
			await copyFile(join(root, file), join(dir, file));
		const result = await Bun.build({
			entrypoints: [join(root, "packages/cli/src/cli.ts")],
			target: "bun",
			compile: {
				...(process.platform === "win32" && { target: "bun-windows-x64" }),
				outfile: join(
					dir,
					process.platform === "win32" ? "spatz.exe" : "spatz",
				),
				autoloadDotenv: false,
				autoloadBunfig: false,
			},
			define: { SPATZ_VERSION: JSON.stringify(version) },
		});
		if (!result.success)
			throw new AggregateError(result.logs, "Release build failed");
		const archive = join(
			out,
			`${name}.${process.platform === "win32" ? "zip" : "tar.gz"}`,
		);
		const pack = Bun.spawn(
			process.platform === "win32"
				? [
						join(
							process.env.SystemRoot ?? "C:\\Windows",
							"System32",
							"tar.exe",
						),
						"-a",
						"-cf",
						archive,
						"-C",
						stage,
						name,
					]
				: ["tar", "-czf", archive, "-C", stage, name],
			{ stdout: "inherit", stderr: "inherit" },
		);
		if (await pack.exited) throw new Error("Release archive failed");
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
