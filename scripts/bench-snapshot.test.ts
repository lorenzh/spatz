import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT_URL } from "../packages/core/src/catalog/snapshot.ts";
import { refreshBundledSnapshot } from "./bench-snapshot.ts";

const text = `${await readFile(join(import.meta.dir, "../catalog/bench-snapshot.json"), "utf8")}`;
const serve =
	(sum = createHash("sha256").update(text).digest("hex")) =>
	async (url: string) =>
		url === SNAPSHOT_URL
			? new Response(text)
			: new Response(`${sum}  snapshot.json\n`);

test("writes the verified release bytes and refuses a checksum mismatch", async () => {
	const dir = await mkdtemp(join(tmpdir(), "spatz-bench-snapshot-"));
	const out = join(dir, "bench-snapshot.json");
	try {
		await writeFile(out, "old");
		await expect(
			refreshBundledSnapshot(serve("f".repeat(64)), out),
		).rejects.toThrow(/checksum/);
		expect(await readFile(out, "utf8")).toBe("old");
		expect(await refreshBundledSnapshot(serve(), out)).toMatch(
			/^bench snapshot [0-9a-f]{7} of \d{4}-\d\d-\d\d, \d+ cells$/,
		);
		expect(await readFile(out, "utf8")).toBe(text);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
