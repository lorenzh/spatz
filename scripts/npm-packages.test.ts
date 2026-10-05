import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildNpmPackages,
	npmDistTag,
	npmVersion,
	platforms,
} from "./npm-packages.ts";

test("npm versions preserve releases and map nightly metadata to a nonnumeric identifier", () => {
	expect(npmVersion("v1.2.3")).toBe("1.2.3");
	expect(npmVersion("1.2.3-rc.1")).toBe("1.2.3-rc.1");
	expect(npmVersion("0.2.0-nightly.20261005+0123456")).toBe(
		"0.2.0-nightly.20261005.g0123456",
	);
	expect(npmVersion("0.2.0-rc.1-nightly.20261005+abcdef0")).toBe(
		"0.2.0-rc.1-nightly.20261005.gabcdef0",
	);
	expect(npmVersion("1.2.3+build.1")).toBe("1.2.3");
	for (const version of [
		"nightly",
		"v01.2.3",
		"1.2.3\n",
		"1.2.3;echo bad",
		"1.2.3-nightly.20261005+nothex",
	])
		expect(() => npmVersion(version)).toThrow();
});

test("dist-tags separate stable, prerelease, and nightly versions", () => {
	expect(npmDistTag("1.2.3")).toBe("latest");
	expect(npmDistTag("v1.2.3+build-hyphen")).toBe("latest");
	expect(npmDistTag("1.2.3-rc.1")).toBe("next");
	expect(npmDistTag("1.2.3-nightly.20261005+0123456")).toBe("nightly");
});

test("older stable releases preserve latest using a major/minor dist-tag", () => {
	for (const latest of [undefined, null, "", "0.0.0", "1.2.2", "1.2.3"])
		expect(npmDistTag("1.2.3", latest)).toBe("latest");
	for (const latest of ["1.2.4", "1.10.0", "2.0.0"])
		expect(npmDistTag("v1.2.3+build.1", latest)).toBe("v1.2-latest");
	expect(npmDistTag("1.10.0", "1.9.0")).toBe("latest");
	expect(npmDistTag("1.2.3-rc.1", "2.0.0")).toBe("next");
	expect(npmDistTag("1.2.3-nightly.20261005+0123456", "2.0.0")).toBe("nightly");
});

test.skipIf(process.platform === "win32")(
	"packages preserve sidecars, metadata, launcher mapping, arguments and exit status",
	async () => {
		const temp = await mkdtemp(join(tmpdir(), "spatz-npm-test-"));
		try {
			const version = "1.2.3-nightly.20261005+0123456";
			const archives = join(temp, "archives");
			await mkdir(archives);
			for (const target of platforms) {
				const name = `spatz-cli-${version.replaceAll("+", "-")}-${target}`;
				const dir = join(temp, name);
				await mkdir(dir);
				const binary = target.startsWith("win32") ? "spatz.exe" : "spatz";
				await Bun.write(
					join(dir, binary),
					"#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2))); process.exit(7);\n",
				);
				await chmod(join(dir, binary), 0o755);
				await Bun.write(join(dir, "duckdb.node"), "binding");
				await Bun.write(
					join(
						dir,
						target.startsWith("win32")
							? "duckdb.dll"
							: target.startsWith("darwin")
								? "libduckdb.dylib"
								: "libduckdb.so",
					),
					"library",
				);
				const command = target.startsWith("win32")
					? [
							"python3",
							"-c",
							"import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], sys.argv[3])",
							join(archives, name),
							temp,
							name,
						]
					: ["tar", "-czf", join(archives, `${name}.tar.gz`), "-C", temp, name];
				expect(Bun.spawnSync(command, { cwd: temp }).exitCode).toBe(0);
			}
			const out = join(temp, "packages");
			await buildNpmPackages(archives, version, out);
			const main = await Bun.file(join(out, "cli/package.json")).json();
			expect(main).toMatchObject({
				name: "@spatz/cli",
				version: "1.2.3-nightly.20261005.g0123456",
				bin: { spatz: "bin/spatz.js" },
				engines: { node: ">=18" },
				license: "MIT",
			});
			for (const target of platforms) {
				const pkg = await Bun.file(
					join(out, `cli-${target}/package.json`),
				).json();
				expect(pkg).toMatchObject({
					name: `@spatz/cli-${target}`,
					version: main.version,
					os: [target.split("-")[0]],
					cpu: [target.split("-")[1]],
					preferUnplugged: true,
					license: "MIT",
					repository: {
						type: "git",
						url: "git+https://github.com/lorenzh/spatz.git",
					},
				});
				expect(main.optionalDependencies[pkg.name]).toBe(main.version);
				expect(pkg.libc).toEqual(
					target.startsWith("linux") ? ["glibc"] : undefined,
				);
				expect(pkg.files).toContain("duckdb.node");
				expect(
					await Bun.file(join(out, `cli-${target}/duckdb.node`)).text(),
				).toBe("binding");
				const probe = Bun.spawnSync(
					[
						"node",
						"-e",
						`Object.defineProperty(process, 'platform', {value: '${pkg.os[0]}'}); Object.defineProperty(process, 'arch', {value: '${pkg.cpu[0]}'}); require(${JSON.stringify(join(out, "cli/bin/spatz.js"))});`,
					],
					{ env: { ...process.env, HOME: temp } },
				);
				expect(probe.exitCode).toBe(1);
				expect(probe.stderr.toString()).toContain(`@spatz/cli-${target}`);
			}
			const platformDir = join(out, `cli-${process.platform}-${process.arch}`);
			expect((await stat(join(platformDir, "spatz"))).mode & 0o111).toBe(0o111);
			await mkdir(join(out, "cli/node_modules/@spatz"), { recursive: true });
			await symlink(
				platformDir,
				join(
					out,
					`cli/node_modules/@spatz/cli-${process.platform}-${process.arch}`,
				),
			);
			const run = Bun.spawnSync(
				["node", join(out, "cli/bin/spatz.js"), "a b", "--version"],
				{ env: { ...process.env, HOME: temp } },
			);
			expect(run.exitCode).toBe(7);
			expect(JSON.parse(run.stdout.toString())).toEqual(["a b", "--version"]);
			await Bun.write(
				join(platformDir, "spatz"),
				'#!/usr/bin/env node\nprocess.kill(process.pid, "SIGTERM");\n',
			);
			const signaled = Bun.spawnSync(["node", join(out, "cli/bin/spatz.js")], {
				env: { ...process.env, HOME: temp },
			});
			expect(signaled.signalCode).toBe("SIGTERM");
			await Bun.write(
				join(platformDir, "spatz"),
				'#!/bin/sh\nkill -PIPE "$$"\n',
			);
			const piped = Bun.spawnSync(["node", join(out, "cli/bin/spatz.js")], {
				env: { ...process.env, HOME: temp },
			});
			expect(piped.exitCode).toBe(128 + constants.signals.SIGPIPE);
			const unsupported = Bun.spawnSync(
				[
					"node",
					"-e",
					`Object.defineProperty(process, 'arch', {value: 'riscv64'}); require(${JSON.stringify(join(out, "cli/bin/spatz.js"))});`,
				],
				{ env: { ...process.env, HOME: temp } },
			);
			expect(unsupported.exitCode).toBe(1);
			expect(unsupported.stderr.toString()).toContain("unsupported platform");
			await rm(
				join(
					archives,
					`spatz-cli-${version.replaceAll("+", "-")}-win32-x64.zip`,
				),
			);
			await buildNpmPackages(archives, version, join(temp, "no-windows"));
			expect(
				(await Bun.file(join(temp, "no-windows/cli/package.json")).json())
					.optionalDependencies,
			).not.toHaveProperty("@spatz/cli-win32-x64");
			await rm(
				join(
					archives,
					`spatz-cli-${version.replaceAll("+", "-")}-linux-arm64.tar.gz`,
				),
			);
			await expect(
				buildNpmPackages(archives, version, join(temp, "incomplete")),
			).rejects.toThrow("linux-arm64");
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	},
);
