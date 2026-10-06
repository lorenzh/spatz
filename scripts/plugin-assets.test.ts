import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pluginNames, syncPluginAssets } from "./plugin-assets.ts";

test("shipped skills equal the source and launchers pin their plugin version", async () => {
	const cli = await Bun.file("packages/cli/package.json").json();
	const source = await Bun.file(resolve("skills/routing/SKILL.md")).text();
	for (const name of pluginNames) {
		const dir = resolve("packages", name);
		const manifest =
			name === "codex-hooks" ? ".codex-plugin" : ".claude-plugin";
		const { version } = await Bun.file(
			join(dir, manifest, "plugin.json"),
		).json();
		expect(version).toBe(cli.version);
		expect(await Bun.file(join(dir, "skills/routing/SKILL.md")).text()).toBe(
			source,
		);
		const launcher = await Bun.file(join(dir, "bin/spatz")).text();
		expect(launcher.match(/@spatz\/cli@[^\s]+/g)).toEqual([
			`@spatz/cli@${version}`,
			`@spatz/cli@${version}`,
		]);
		expect((await stat(join(dir, "bin/spatz"))).mode & 0o111).not.toBe(0);
	}
});

test.skipIf(process.platform === "win32")(
	"launcher prefers PATH, then bunx, then npx; preserves arguments, stdin and status",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "spatz-launcher-"));
		try {
			for (const name of ["spatz", "bunx", "npx"]) {
				await Bun.write(
					join(dir, name),
					`#!/bin/sh\nprintf '%s\\n' '${name}' "$@"\nread -r input\nprintf '%s\\n' "$input"\nexit 7\n`,
				);
				await chmod(join(dir, name), 0o755);
			}
			for (const name of ["spatz", "bunx", "npx", "missing"]) {
				const proc = Bun.spawn(
					[
						resolve("packages/claude-hooks/bin/spatz"),
						"task with spaces",
						"--json",
					],
					{
						env: { PATH: dir },
						stdin: new Blob(["hook input\n"]),
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const stdout = await new Response(proc.stdout).text();
				const stderr = await new Response(proc.stderr).text();
				if (name === "missing") {
					expect(await proc.exited).toBe(1);
					expect(stdout).toBe("");
					expect(stderr).toBe("install the spatz CLI: npm i -g @spatz/cli\n");
				} else {
					const { version } = await Bun.file(
						"packages/claude-hooks/.claude-plugin/plugin.json",
					).json();
					const prefix =
						name === "spatz"
							? ""
							: `${name === "npx" ? "-y\n" : ""}@spatz/cli@${version}\n`;
					expect(stdout).toBe(
						`${name}\n${prefix}task with spaces\n--json\nhook input\n`,
					);
					expect(stderr).toBe("");
					expect(await proc.exited).toBe(7);
					await rm(join(dir, name));
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"launcher falls through launcher-only PATH entries without recursion",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "spatz-launcher-path-"));
		try {
			const first = join(root, "first");
			const second = join(root, "second");
			const tools = join(root, "tools");
			for (const dir of [first, second, tools])
				await mkdir(dir, { recursive: true });
			for (const dir of [first, second])
				await Bun.$`cp packages/claude-hooks/bin/spatz ${join(dir, "spatz")}`;
			await Bun.write(
				join(tools, "npx"),
				"#!/bin/sh\nprintf 'npx %s\\n' \"$*\"\n",
			);
			await chmod(join(tools, "npx"), 0o755);
			const proc = Bun.spawn([join(first, "spatz"), "--version"], {
				env: { PATH: [first, second, tools].join(":"), SPATZ_LAUNCHER: "" },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(await new Response(proc.stdout).text()).toMatch(
				/^npx -y @spatz\/cli@/,
			);
			expect(await proc.exited).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("plugin asset sync rejects invalid versions before writing launchers", async () => {
	const root = await mkdtemp(join(tmpdir(), "spatz-plugin-version-"));
	try {
		await Bun.write(join(root, "skills/routing/SKILL.md"), "skill\n");
		const manifest = join(
			root,
			"packages/claude-mod/.claude-plugin/plugin.json",
		);
		await mkdir(join(root, "packages/claude-mod/.claude-plugin"), {
			recursive: true,
		});
		await Bun.write(manifest, '{"version":"latest"}');
		await expect(syncPluginAssets(root)).rejects.toThrow("Invalid release tag");
		expect(
			await Bun.file(join(root, "packages/claude-mod/bin/spatz")).exists(),
		).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")(
	"launcher failures survive swallowed stderr, including nested launchers",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "spatz-launcher-failures-"));
		try {
			const bin = join(home, "bin");
			await mkdir(bin);
			await symlink("/bin/mkdir", join(bin, "mkdir"));
			const launcher = resolve("packages/claude-hooks/bin/spatz");
			const run = async () => {
				const proc = Bun.spawn([launcher, "hook", "Stop"], {
					env: { HOME: home, PATH: bin, SPATZ_LAUNCHER: "" },
					stdin: new Blob(["input\n"]),
					stdout: "pipe",
					stderr: "ignore",
				});
				const stdout = await new Response(proc.stdout).text();
				return { code: await proc.exited, stdout };
			};
			expect(await run()).toEqual({ code: 1, stdout: "" });
			expect(
				await Bun.file(join(home, ".spatz/launcher-failures")).text(),
			).toBe("1\n");
			await Bun.write(
				join(bin, "bunx"),
				'#!/bin/sh\nread -r input\nprintf "%s" "$input"\nexit 7\n',
			);
			await chmod(join(bin, "bunx"), 0o755);
			await symlink(launcher, join(bin, "spatz"));
			expect(await run()).toEqual({ code: 7, stdout: "input" });
			expect(
				await Bun.file(join(home, ".spatz/launcher-failures")).text(),
			).toBe("1\n1\n");
			await Bun.write(join(bin, "bunx"), "#!/bin/sh\nexit 0\n");
			expect(await run()).toEqual({ code: 0, stdout: "" });
			expect(
				await Bun.file(join(home, ".spatz/launcher-failures")).text(),
			).toBe("1\n1\n");
			await rm(join(home, ".spatz"), { recursive: true });
			await Bun.write(join(home, ".spatz"), "not a directory");
			await Bun.write(join(bin, "bunx"), "#!/bin/sh\nexit 7\n");
			expect((await run()).code).toBe(7);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	},
);
