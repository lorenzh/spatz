import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

test("--version prints the package version without opening the store", async () => {
	const home = await mkdtemp(join(tmpdir(), "spatz-version-"));
	try {
		const proc = Bun.spawn(
			[process.execPath, join(import.meta.dir, "cli.ts"), "--version"],
			{
				env: { HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(await new Response(proc.stdout).text()).toBe(`${pkg.version}\n`);
		expect(await new Response(proc.stderr).text()).toBe("");
		expect(await proc.exited).toBe(0);
		expect(await Bun.file(join(home, ".spatz", "spatz.db")).exists()).toBe(
			false,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
