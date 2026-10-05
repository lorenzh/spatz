import { appendFile } from "node:fs/promises";

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

if (import.meta.main) {
	const { version, prerelease } = releaseVersion(process.argv[2] ?? "");
	const file = Bun.file(
		new URL("../packages/cli/package.json", import.meta.url),
	);
	const pkg = await file.json();
	await Bun.write(file, `${JSON.stringify({ ...pkg, version }, null, "\t")}\n`);
	if (process.env.GITHUB_OUTPUT)
		await appendFile(
			process.env.GITHUB_OUTPUT,
			`version=${version}\nprerelease=${prerelease}\n`,
		);
	console.log(version);
}
