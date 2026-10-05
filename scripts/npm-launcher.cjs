#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { dirname, join } = require("node:path");

const packages = {
	"linux-x64": "@spatz/cli-linux-x64",
	"linux-arm64": "@spatz/cli-linux-arm64",
	"darwin-arm64": "@spatz/cli-darwin-arm64",
	"darwin-x64": "@spatz/cli-darwin-x64",
	"win32-x64": "@spatz/cli-win32-x64",
};
const target = `${process.platform}-${process.arch}`;
const pkg = packages[target];
if (!pkg) {
	console.error(`spatz: unsupported platform ${target}`);
	process.exit(1);
}
let dir;
try {
	dir = dirname(require.resolve(`${pkg}/package.json`));
} catch {
	console.error(
		`spatz: missing ${pkg}. Reinstall @spatz/cli with optional dependencies enabled (omit --no-optional / --omit=optional). The experimental Windows package may be unavailable for this release.`,
	);
	process.exit(1);
}
const child = spawnSync(
	join(dir, process.platform === "win32" ? "spatz.exe" : "spatz"),
	process.argv.slice(2),
	{ stdio: "inherit" },
);
if (child.error) {
	console.error(`spatz: ${child.error.message}`);
	process.exit(1);
}
if (child.signal) process.kill(process.pid, child.signal);
else process.exit(child.status ?? 1);
