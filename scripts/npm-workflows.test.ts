import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function workflowScript(file: string, job: string, id: string) {
	const workflow = Bun.YAML.parse(
		await Bun.file(
			new URL(`../.github/workflows/${file}.yml`, import.meta.url),
		).text(),
	) as { jobs: Record<string, { steps: { id?: string; run?: string }[] }> };
	const script = workflow.jobs[job]?.steps.find((step) => step.id === id)?.run;
	if (!script) throw new Error("Workflow step is missing");
	return script;
}

test.skipIf(process.platform === "win32")(
	"npm resolver rejects invalid tags and skipped or superseded nightlies",
	async () => {
		const temp = await mkdtemp(join(tmpdir(), "spatz-resolve-"));
		try {
			await symlink(import.meta.dir, join(temp, "scripts"));
			await Bun.write(
				join(temp, "gh"),
				'#!/bin/sh\nif [ "$1" = api ]; then printf "%s" "$PUBLISHED_JOB"; else cat "$MOCK_RELEASE"; fi\n',
			);
			await chmod(join(temp, "gh"), 0o755);
			const release = {
				tagName: "nightly",
				targetCommitish: "0123456789abcdef",
				body: "Version: 1.2.3-nightly.20261005+0123456\n",
				databaseId: 12,
				isDraft: false,
			};
			await Bun.write(join(temp, "mock.json"), JSON.stringify(release));
			const script = await workflowScript("npm-publish", "resolve", "release");
			const run = async (overrides: Record<string, string> = {}) => {
				const output = join(temp, "output");
				await Bun.write(output, "");
				const result = Bun.spawnSync(
					["bash", "-e", "-o", "pipefail", "-c", script],
					{
						cwd: temp,
						env: {
							...process.env,
							HOME: temp,
							PATH: `${temp}:${process.env.PATH}`,
							GITHUB_OUTPUT: output,
							MOCK_RELEASE: join(temp, "mock.json"),
							RELEASE_TAG: "nightly",
							EVENT_NAME: "workflow_run",
							RUN_SHA: release.targetCommitish,
							RUN_ID: "1",
							RUN_ATTEMPT: "1",
							PUBLISHED_JOB: "12",
							GH_REPO: "lorenzh/spatz",
							...overrides,
						},
					},
				);
				return { code: result.exitCode, output: await Bun.file(output).text() };
			};
			expect((await run()).output).toContain("ready=true");
			expect((await run({ PUBLISHED_JOB: "" })).output).toBe("");
			expect((await run({ RUN_SHA: "different" })).output).toBe("");
			expect(
				(await run({ EVENT_NAME: "workflow_dispatch", PUBLISHED_JOB: "" }))
					.output,
			).toContain("dist_tag=nightly");
			for (const tag of [
				"v1.2.3\n",
				"--help",
				"v01.2.3",
				"v1.2.3; touch injected",
			])
				expect(
					(await run({ RELEASE_TAG: tag, EVENT_NAME: "workflow_dispatch" }))
						.code,
				).not.toBe(0);
			await Bun.write(
				join(temp, "mock.json"),
				JSON.stringify({ ...release, tagName: "v1.2.3-rc.1" }),
			);
			expect((await run({ RELEASE_TAG: "v1.2.3-rc.1" })).output).toContain(
				"dist_tag=next",
			);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"nightly filter builds for release inputs, force, and missing history",
	async () => {
		const temp = await mkdtemp(join(tmpdir(), "spatz-nightly-"));
		try {
			const env = {
				...process.env,
				HOME: temp,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
			};
			const git = (...args: string[]) => {
				const result = Bun.spawnSync(
					[
						"git",
						"-c",
						"user.name=Test",
						"-c",
						"user.email=test@example.com",
						...args,
					],
					{ cwd: temp, env },
				);
				if (result.exitCode) throw new Error(result.stderr.toString());
				return result.stdout.toString().trim();
			};
			git("init", "-q");
			git("commit", "--allow-empty", "-qm", "initial");
			const previous = git("rev-parse", "HEAD");
			await Bun.write(
				join(temp, "gh"),
				'#!/bin/sh\nprintf "%s" "$PREVIOUS_SHA"\n',
			);
			await chmod(join(temp, "gh"), 0o755);
			const script = (
				await workflowScript("nightly", "version", "version")
			).split('date="$(date')[0];
			const check = async (force = "false", prev = previous) => {
				const output = join(temp, "output");
				await Bun.write(output, "");
				const result = Bun.spawnSync(
					[
						"bash",
						"-e",
						"-o",
						"pipefail",
						"-c",
						`${script}\necho changed=true >> "$GITHUB_OUTPUT"`,
					],
					{
						cwd: temp,
						env: {
							...env,
							PATH: `${temp}:${process.env.PATH}`,
							GITHUB_OUTPUT: output,
							FORCE: force,
							PREVIOUS_SHA: prev,
							GH_REPO: "lorenzh/spatz",
						},
					},
				);
				expect(result.exitCode).toBe(0);
				return (await Bun.file(output).text()).trim();
			};
			expect(await check()).toBe("changed=false");
			await Bun.write(join(temp, "README.md"), "docs only");
			git("add", "README.md");
			git("commit", "-qm", "docs");
			expect(await check()).toBe("changed=false");
			expect(await check("true")).toBe("changed=true");
			expect(await check("false", "")).toBe("changed=true");
			expect(await check("false", "0".repeat(40))).toBe("changed=true");
			for (const file of [
				"packages/test.ts",
				"scripts/test.ts",
				"package.json",
				"bun.lock",
				".github/workflows/test.yml",
			]) {
				const before = git("rev-parse", "HEAD");
				await mkdir(join(temp, file, ".."), { recursive: true });
				await Bun.write(join(temp, file), "changed");
				git("add", file);
				git("commit", "-qm", "code");
				expect(await check("false", before)).toBe("changed=true");
			}
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	},
);
