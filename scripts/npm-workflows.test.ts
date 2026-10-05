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

test("npm workflow accepts only trusted release runs or direct manual dispatch", async () => {
	const workflow = Bun.YAML.parse(
		await Bun.file(
			new URL("../.github/workflows/npm-publish.yml", import.meta.url),
		).text(),
	) as {
		jobs: {
			resolve: { if: string };
			publish: { concurrency: { group: string } };
		};
	};
	const accepts = new Function(
		"github",
		`return (${workflow.jobs.resolve.if});`,
	);
	const run = {
		conclusion: "success",
		head_repository: { full_name: "lorenzh/spatz" },
		head_branch: "main",
		name: "Release",
		event: "push",
		path: ".github/workflows/release.yml",
	};
	const github = (workflow_run = run, event_name = "workflow_run") => ({
		repository: "lorenzh/spatz",
		event_name,
		event: { workflow_run },
	});
	expect(accepts(github())).toBe(true);
	for (const event of ["schedule", "workflow_dispatch"])
		expect(
			accepts(
				github({
					...run,
					name: "Nightly",
					event,
					path: ".github/workflows/nightly.yml",
				}),
			),
		).toBe(true);
	for (const trusted of [
		run,
		{
			...run,
			name: "Nightly",
			event: "schedule",
			path: ".github/workflows/nightly.yml",
		},
	]) {
		for (const overrides of [
			{ head_repository: { full_name: "attacker/spatz" } },
			{ event: "pull_request" },
			{ event: "pull_request_target" },
			{ path: ".github/workflows/fake.yml" },
			{ name: "Fake" },
			{ conclusion: "failure" },
		])
			expect(accepts(github({ ...trusted, ...overrides }))).toBe(false);
	}
	expect(accepts(github({ ...run, event: "workflow_dispatch" }))).toBe(false);
	expect(
		accepts(
			github({
				...run,
				name: "Nightly",
				event: "workflow_dispatch",
				path: ".github/workflows/nightly.yml",
				head_branch: "feature",
			}),
		),
	).toBe(false);
	expect(
		accepts(
			github({
				...run,
				name: "Nightly",
				event: "push",
				path: ".github/workflows/nightly.yml",
			}),
		),
	).toBe(false);
	expect(accepts({ event_name: "workflow_dispatch" })).toBe(true);
	expect(workflow.jobs.publish.concurrency.group).toBe("npm-publish");
	const nightly = Bun.YAML.parse(
		await Bun.file(
			new URL("../.github/workflows/nightly.yml", import.meta.url),
		).text(),
	) as {
		jobs: {
			version: { steps: { with: { ref: string } }[] };
			build: { with: { ref: string } };
		};
	};
	expect(nightly.jobs.version.steps[0]?.with.ref).toBe(`\${{ github.sha }}`);
	expect(nightly.jobs.build.with.ref).toBe(`\${{ needs.version.outputs.sha }}`);
});

test.skipIf(process.platform === "win32")(
	"npm publishing protects latest and retries only already-published E403 errors",
	async () => {
		const temp = await mkdtemp(join(tmpdir(), "spatz-publish-"));
		try {
			await symlink(import.meta.dir, join(temp, "scripts"));
			for (const name of ["cli-linux-x64", "cli"])
				await Bun.write(
					join(temp, "npm-packages", name, "package.json"),
					JSON.stringify({ name: `@spatz/${name}`, version: "1.2.3" }),
				);
			await Bun.write(
				join(temp, "npm"),
				`#!/bin/bash
if [[ "$1" == view ]]; then
  if [[ "$3" == dist-tags.latest ]]; then
    printf '%s' "$LATEST_JSON"
    exit "$LATEST_CODE"
  fi
  echo '{"error":{"code":"E404"}}'
  exit 1
fi
printf '%s\\n' "$PWD $*" >> "$PUBLISH_LOG"
printf '%s' "$PUBLISH_JSON"
exit "$PUBLISH_CODE"
`,
			);
			await chmod(join(temp, "npm"), 0o755);
			const script = await workflowScript("npm-publish", "publish", "publish");
			const run = async (overrides: Record<string, string> = {}) => {
				const log = join(temp, "publish.log");
				await Bun.write(log, "");
				const result = Bun.spawnSync(
					["bash", "-e", "-o", "pipefail", "-c", script],
					{
						cwd: temp,
						env: {
							...process.env,
							HOME: temp,
							PATH: `${temp}:${process.env.PATH}`,
							DIST_TAG: "latest",
							RELEASE_VERSION: "1.2.3",
							LATEST_JSON: '"2.0.0"',
							LATEST_CODE: "0",
							PUBLISH_JSON: "{}",
							PUBLISH_CODE: "0",
							PUBLISH_LOG: log,
							...overrides,
						},
					},
				);
				return { code: result.exitCode, log: await Bun.file(log).text() };
			};
			const older = await run();
			expect(older.code).toBe(0);
			expect(older.log.trim().split("\n")).toHaveLength(2);
			expect(older.log).toContain("--tag v1.2-latest");
			for (const latest of ['"0.0.0"', '"1.2.3"', '"1.2.2"', "", "null"])
				expect((await run({ LATEST_JSON: latest })).log).toContain(
					"--tag latest",
				);
			expect(
				(
					await run({
						LATEST_CODE: "1",
						LATEST_JSON: '{"error":{"code":"E404"}}',
					})
				).log,
			).toContain("--tag latest");
			const denied = await run({
				LATEST_CODE: "1",
				LATEST_JSON: '{"error":{"code":"E403"}}',
			});
			expect(denied.code).not.toBe(0);
			expect(denied.log).toBe("");
			expect(
				(await run({ DIST_TAG: "nightly", LATEST_CODE: "1" })).log,
			).toContain("--tag nightly");
			const error = (code: string, summary: string) => ({
				PUBLISH_CODE: "1",
				PUBLISH_JSON: JSON.stringify({ error: { code, summary } }),
			});
			const duplicate = await run(
				error(
					"E403",
					"You cannot publish over the previously published versions: 1.2.3.",
				),
			);
			expect(duplicate.code).toBe(0);
			expect(duplicate.log.trim().split("\n")).toHaveLength(2);
			// npm's own pre-upload check reports the duplicate without an error code.
			const local = await run({
				PUBLISH_CODE: "1",
				PUBLISH_JSON: JSON.stringify({
					error: {
						summary:
							"You cannot publish over the previously published versions: 1.2.3.",
					},
				}),
			});
			expect(local.code).toBe(0);
			for (const failure of [
				error("E403", "Permission denied"),
				error("E500", "cannot publish over the previously published version"),
				{ PUBLISH_CODE: "1", PUBLISH_JSON: "network failure" },
			])
				expect((await run(failure)).code).not.toBe(0);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	},
);

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
				".claude-plugin/marketplace.json",
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
