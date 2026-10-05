import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pluginNames } from "./plugin-assets.ts";

test("shipped skills equal the source and launchers pin their plugin version", async () => {
	const cli = await Bun.file("packages/cli/package.json").json();
	const source = await Bun.file(resolve("skills/spatz/SKILL.md")).text();
	for (const name of pluginNames) {
		const dir = resolve("packages", name);
		const manifest =
			name === "codex-hooks" ? ".codex-plugin" : ".claude-plugin";
		const { version } = await Bun.file(
			join(dir, manifest, "plugin.json"),
		).json();
		expect(version).toBe(cli.version);
		expect(await Bun.file(join(dir, "skills/spatz/SKILL.md")).text()).toBe(
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
