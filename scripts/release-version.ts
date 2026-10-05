import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// SemVer 2.0: numeric identifiers cannot have leading zeroes.
const numeric = "(?:0|[1-9][0-9]*)";
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(
	`^(${numeric}\\.${numeric}\\.${numeric})(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export function releaseVersion(tag: string) {
	const version = tag.slice(1);
	const match = semver.exec(version);
	if (!tag.startsWith("v") || !match || match[0] !== version)
		throw new Error(`Invalid release tag: ${JSON.stringify(tag)}`);
	return { version, prerelease: match[2] !== undefined };
}

export async function setReleaseVersion(
	tag: string,
	root = resolve(import.meta.dir, ".."),
) {
	const release = releaseVersion(tag);
	for (const path of [
		"packages/cli/package.json",
		"packages/claude-mod/.claude-plugin/plugin.json",
		"packages/claude-hooks/.claude-plugin/plugin.json",
		".claude-plugin/marketplace.json",
	]) {
		const file = Bun.file(join(root, path));
		// Preserve formatting: release builds run Biome after stamping these files.
		const text = await file.text();
		await Bun.write(
			file,
			text.replace(/("version"\s*:\s*)"[^"]*"/g, `$1"${release.version}"`),
		);
	}
	return release;
}

if (import.meta.main) {
	const { version, prerelease } = await setReleaseVersion(
		process.argv[2] ?? "",
	);
	if (process.env.GITHUB_OUTPUT)
		await appendFile(
			process.env.GITHUB_OUTPUT,
			`version=${version}\nprerelease=${prerelease}\n`,
		);
	console.log(version);
}
