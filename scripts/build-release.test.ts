import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelease } from "./build-release.ts";
import { smokeRelease } from "./smoke-release.ts";

test.skipIf(process.platform === "win32")(
	"archive runs outside the checkout with the injected version and DuckDB sidecars",
	async () => {
		const out = await mkdtemp(join(tmpdir(), "spatz-build-"));
		try {
			const version = "9.8.7-rc.1+build-test";
			const archive = await buildRelease(version, out);
			expect(archive).toEndWith(
				`spatz-cli-${version.replaceAll("+", "-")}-${process.platform}-${process.arch}.tar.gz`,
			);
			const checksum = await readFile(`${archive}.sha256`, "utf8");
			expect(checksum).toMatch(/^[a-f0-9]{64} {2}.+\n$/);
			expect(checksum).toEndWith(`  ${archive.split(/[\\/]/).at(-1)}\n`);
			await smokeRelease(archive, version);
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	},
	120_000,
);
