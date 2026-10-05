import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelease } from "./build-release.ts";
import { smokeRelease } from "./smoke-release.ts";

test("archive runs outside the checkout with the injected version and DuckDB sidecars", async () => {
	const out = await mkdtemp(join(tmpdir(), "spatz-build-"));
	try {
		const version = "9.8.7-rc.1+build-test";
		const archive = await buildRelease(version, out);
		expect(archive).toEndWith(
			`spatz-cli-${version}-${process.platform}-${process.arch}.tar.gz`,
		);
		await smokeRelease(archive, version);
	} finally {
		await rm(out, { recursive: true, force: true });
	}
}, 120_000);
