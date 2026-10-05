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

test.skipIf(process.platform === "win32")(
	"launcher counts failed hook calls for spatz stats, never other commands",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "spatz-launcher-fail-"));
		try {
			const tools = join(root, "tools");
			const bare = join(root, "bare");
			for (const dir of [tools, bare]) {
				await mkdir(dir);
				await symlink(Bun.which("mkdir") ?? "/bin/mkdir", join(dir, "mkdir"));
			}
			await Bun.write(join(tools, "bunx"), "#!/bin/sh\nexit 3\n");
			await chmod(join(tools, "bunx"), 0o755);
			const run = (path: string, ...args: string[]) =>
				Bun.spawn([resolve("packages/codex-hooks/bin/spatz"), ...args], {
					env: { PATH: path, HOME: root },
					stdout: "pipe",
					stderr: "pipe",
				}).exited;
			const log = join(root, ".spatz", "launcher-failures");
			expect(await run(tools, "report", "x")).toBe(3);
			expect(await Bun.file(log).exists()).toBe(false);
			expect(await run(tools, "hook", "Stop")).toBe(3);
			expect(await run(bare, "hook", "Stop")).toBe(1);
			expect(await Bun.file(log).text()).toBe("Stop\nStop\n");
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
