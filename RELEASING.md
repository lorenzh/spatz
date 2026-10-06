---
title: Releasing spatz
description: The release strategy (main, nightly, release branches and candidates) and how to publish CLI and Claude Code plugin archives and npm packages, and control nightly builds and daily harness catalog updates.
tags: [spatz, cli, releases]
keywords: [migration, backup, rollback, downgrade, release, release branch, release candidate, rc, cherry-pick, strategy, nightly, catalog, harness, workflow, tag, semver, publish, checksum, binary, archive, download, npm, install, trusted publishing, plugin, marketplace, zip]
---

# Releasing spatz

## Release strategy

spatz uses trunk-based development with a nightly build and one release branch per minor version.

```
main ──●──●──●──●──●──●──●──►        nightly: npm @nightly, daily
            \
             release/0.2 ──●──●──►   v0.2.0-rc.1 → v0.2.0-rc.2 → v0.2.0 → v0.2.1
```

- `main` is the development branch. All changes reach `main` through pull requests. The nightly workflow builds `main` when code changed.
- A release starts when a set of features is ready, not on a fixed date. As a guide, plan one minor release every two to four weeks.
- spatz is still on 0.x: new features raise the minor version (`0.2.0`), fixes raise the patch version (`0.2.1`).
- Each minor version gets a release branch `release/<major>.<minor>`, for example `release/0.2`. Release candidates, the final release and later patches of that minor version come from this branch.
- Release candidates use the tag `v<version>-rc.<n>`. They are GitHub prereleases and go to npm under the dist-tag `next`, never `latest`.
- Fix first on `main`, then cherry-pick the fix onto the release branch. A fix that only applies to the release branch is the exception; say so in its pull request.
- Only fixes go onto a release branch. New features wait for the next minor version.
- If no new features land on `main` during the candidate phase, you can skip the release branch: tag the candidates directly on a `main` commit (`v0.2.0-rc.1`) without committing an RC version bump. The release workflow stamps the version from the tag into the build, so `main` keeps the last stable version.

### Version on `main`

`main` keeps the version of the last stable release: its current files never carry a release candidate or an older maintenance version. Commits in its history may contain RC bumps after a merge; only the current tree matters.
The Git plugin marketplace reads `main`, and each plugin launcher pins `@spatz/cli` to its plugin version. A version on `main` that is not on npm would break the launcher for plugin users.
Nightly builds therefore carry the last released version plus the date, for example `0.2.0-nightly.20261020+abc1234`. The npm dist-tag `nightly` keeps them apart from releases, so their SemVer order does not matter.

## Cutting a release

1. Create the release branch from `main` and set the candidate version:

   ```bash
   git switch main
   git pull --ff-only
   git switch -c release/0.2
   bun scripts/release-version.ts v0.2.0-rc.1
   ```

   Run the gates in [CONTRIBUTING.md](CONTRIBUTING.md), commit the bump and push the branch. Protect `release/*` like `main`: changes only through pull requests.
2. Tag the first candidate on the release branch:

   ```bash
   git tag v0.2.0-rc.1
   git push origin release/0.2 v0.2.0-rc.1
   ```

3. Test the candidate:
   - CLI: `npm i -g @spatz/cli@next`.
   - Claude Code plugins from the branch: `/plugin marketplace add lorenzh/spatz@release/0.2`, then install the plugins as usual.
   - Codex plugins from the branch: `codex plugin marketplace add lorenzh/spatz --ref release/0.2`.
   - The plugin ZIP files and `marketplace.json` of the GitHub prerelease also work.
4. For each fix: merge it into `main`, cherry-pick it onto `release/0.2` through a pull request, set the next candidate version with `bun scripts/release-version.ts v0.2.0-rc.2`, and tag `v0.2.0-rc.2`.
5. When a candidate passes, set the final version on the release branch and tag it:

   ```bash
   bun scripts/release-version.ts v0.2.0
   # commit the bump through a pull request into release/0.2
   git tag v0.2.0
   git push origin v0.2.0
   ```

6. Wait until the npm publish workflow has published exactly `0.2.0` (`npm view @spatz/cli@0.2.0 version`). The npm publish runs after the GitHub release and can fail on its own.
7. Then merge the release branch back into `main` through a pull request. This brings the version bump to `main`, so the Git marketplace and the plugin launchers use `0.2.0`. Never merge while the branch carries a candidate version: plugin launchers on `main` would pin a prerelease.
8. Keep the release branch. Patch releases (`v0.2.1`) follow steps 4 to 7 on the same branch, without a candidate when the fix is small.
9. Maintenance of an older minor version: once a newer minor version is released (for example `0.3.0`), a patch on `release/0.2` publishes to the npm dist-tag `v0.2-latest`, not `latest`. Do not merge that branch back into `main`, because `main` must keep the newest stable version. The fix is already on `main` (step 4).

### Release checklist

- [ ] CI is green on the release branch, and the release workflow passed for the last candidate.
- [ ] `npm i -g @spatz/cli@next` installs and `spatz --version` prints the candidate.
- [ ] The plugins from `release/<minor>` load. Claude Code: `/spatz status` answers (mod). Codex: the hooks appear in `/hooks` and a shell command creates no error.
- [ ] Docs describe every user-visible change of the release.
- [ ] npm shows the final version (`latest` for the newest minor), and only then is the release branch merged back into `main`.

### Migration checklist for breaking releases

The release owner completes this checklist before the first breaking candidate.
Repeat the checks after changes to migrations or consumer contracts.
This gate covers [#78](https://github.com/lorenzh/spatz/issues/78).

- [ ] Record the old and new schema versions. Check that an upgrade creates a backup before the first migration write.
- [ ] Restore a populated v5 backup with the previous CLI. Compare rows, outcomes, learning statistics and token totals.
- [ ] Check that the previous CLI refuses the newer schema with an upgrade instruction. Both hook families must exit 0 silently.
- [ ] Test migration rollback on failure and concurrent writers. Keep the backup when migration fails.
- [ ] For [#67](https://github.com/lorenzh/spatz/issues/67), check `tokens_schema` in every cost query. Exclude legacy Codex rows (`tokens_schema = 1`) from USD comparisons.
- [ ] Check normalized input and cache counters across Claude and Codex fixtures ([#60](https://github.com/lorenzh/spatz/issues/60)).
- [ ] Run compatibility fixtures for hooks, mod and skill against the candidate CLI output and strategy strings: `default`, `retry`, `learned-fallback`.
- [ ] Check requested-versus-answered dispatch fields ([#66](https://github.com/lorenzh/spatz/issues/66)) and unknown-model errors ([#71](https://github.com/lorenzh/spatz/issues/71)).
- [ ] Check taxonomy values and CLI filters ([#72](https://github.com/lorenzh/spatz/issues/72)). Check stats JSON consumers after [#44](https://github.com/lorenzh/spatz/issues/44).
- [ ] Run the legacy and delayed-event fixtures for [#34](https://github.com/lorenzh/spatz/issues/34) and [#35](https://github.com/lorenzh/spatz/issues/35). Use the [attempt design](docs/design/attempts.md#implementation-checks).
- [ ] Update docs for each user-visible change. Record checks that do not apply to this release and explain why.
- [ ] Add a **Breaking changes and migration** section to the release notes before publication. List each break and its required user action.

Release notes must name the schema versions and compatible CLI/plugin versions.
Include the backup location and [restore procedure](docs/configuration.md#database-backup-and-restore).
List token semantics, strategy strings, model validation, taxonomy and stats JSON changes that ship in this release.
Generated commit lists do not replace these instructions.
The owner of the first breaking release must complete these notes when that release is prepared.

## Release and nightly workflows

The release workflow rejects tags that do not contain a valid SemVer version.
It sets the CLI version, all three plugin manifest versions and both Claude Code marketplace entry versions from the tag.
Each native runner runs the tests, typecheck, lint, build, and archive smoke test.
GitHub publishes the archives, SHA256 checksums, and generated release notes after all builds pass.
Versions such as `v0.2.0-rc.1` produce prereleases.
Build metadata alone does not make a prerelease: `v0.2.0+build.1` remains a stable release.

The nightly workflow runs daily at 03:00 UTC and accepts manual runs from GitHub Actions.
The workflow builds its triggering commit (`github.sha`) and compares it with the previous nightly commit.
Changes under `packages/`, `scripts/`, `package.json`, `bun.lock`, `.github/workflows/`, or `.claude-plugin/` trigger a build.
Documentation-only changes do not trigger a build.
If Git cannot resolve the previous commit, the workflow builds.
For a manual rebuild, enable the boolean `force` input. Its default is `false`.
Its version is `<package version>-nightly.<YYYYMMDD>+<shortsha>`.
The workflow replaces any existing build metadata.
After all builds pass, it replaces the fixed `nightly` tag and prerelease.
The release body records the UTC date and full commit SHA.

Both workflows use Linux x64/arm64 and macOS x64/arm64 native runners. They also produce an experimental Windows x64 ZIP archive. A Windows build failure does not block the other release assets. The Windows job runs no test suite, only a smoke test of the built `spatz.exe`. Windows hooks are untested.
On a `v*` tag, a failed experimental Windows job ships the release without the Windows asset.
The Intel macOS runner is `macos-15-intel` because GitHub retired `macos-13`.

To build and test an archive locally after the setup in [CONTRIBUTING.md](CONTRIBUTING.md):

```bash
bun scripts/build-release.ts 0.2.0
bun scripts/smoke-release.ts dist/spatz-cli-0.2.0-linux-x64.tar.gz 0.2.0
```

Use your host's OS and architecture in the archive name. The build script supports native builds only, including experimental Windows x64.
The smoke test checks the checksum, version, dry-run suggestion, and DuckDB statistics outside the checkout.
It uses the preinstalled DuckDB SQLite extension and sets dead HTTP proxies.
See [README.md](README.md#releases) for download and installation instructions.

## Daily harness catalog

`.github/workflows/harness-catalog.yml` runs on `main` daily at 04:00 UTC and supports `workflow_dispatch`.
Run `bun scripts/harness-catalog.ts` to update the catalog locally.
The script installs the latest published harness packages into temporary directories and deletes them afterward.
Installs disable package lifecycle scripts. Harness commands use temporary home directories without credentials or user configuration.
The script needs no login or API key.

The extractor uses these sources and selection rules:

- **Claude Code:** the native package embeds a structured catalog marked by `https://downloads.claude.ai/model-catalog/v1/schema.json`.
  The extractor reads `surfaces.cc.model_selector_config` for `id: cc` without executing the embedded JavaScript.
  It selects every `main` picker model offered on `first_party`, regardless of family. It excludes disabled and overflow entries.
  Efforts must appear in both `thinking.effort_options` and `runtime.effort_levels`; otherwise extraction fails.
  A Claude model gets `["none"]` only when both `effort_options` and `effort_levels` are empty; if only one is empty, extraction fails.
  An unsafe ID in the main picker fails extraction.
- **Codex:** the installed CLI returns its built-in picker metadata through `codex debug models --bundled` without login.
  The extractor selects `visibility: list` entries from the newest GPT major generation.
  This excludes hidden entries and older generations. Efforts come from `supported_reasoning_levels`; Codex `none` (reasoning off) is excluded.

The script keeps only these spatz efforts: `none`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
If a harness has no selected models, the script fails.
It rejects empty results after effort filtering. Models without picker effort options use `none`.
It validates the complete schema before writing `catalog/harness-models.json`.
The file sorts models by ID and efforts by spatz's effort order.
When model IDs or efforts change, `updated` records the UTC date.
Version-only changes do not rewrite the file. Stored harness versions describe the last model update.
The script refuses a catalog that drops a model from the current file, and the workflow refuses it again before publishing.
When a model is really retired, run `bun scripts/harness-catalog.ts --allow-drop` locally and merge the result through a normal PR.
Account entitlements can differ from these package defaults.

When the file changes and the tests pass, the workflow commits it on `catalog/update-<YYYYMMDD>` using `github-actions[bot]`.
It creates a PR to `main`, then runs `gh pr merge --merge --delete-branch`.
PRs opened with the workflow token do not start `ci.yml`, so the `test` job runs the tests before the merge instead.
A repeated run updates today's open branch with a force-with-lease push and reuses its PR.
If the file has no changes, the workflow exits without a commit.
The workflow uses four jobs, each with a timeout:

- `extract` has `contents: read` and a 15-minute timeout. It checks out the run's commit (`github.sha`) and stores no credentials.
  It runs the extractor and uploads only `catalog/harness-models.json` with the pinned artifact action.
- `test` needs `extract`, has `contents: read` and a 15-minute timeout. It checks out the run's commit without stored credentials.
  It copies the artifact with `scripts/accept-harness-catalog.ts` and installs the dev dependencies.
  It installs the DuckDB extension in a temporary home, then runs `bun test` with another temporary `HOME` and `SPATZ_DUCKDB_EXTENSION_DIR` set to that extension.
  The dev dependencies are third-party code, so this job has no write access.
- `publish` needs `test` and has a 10-minute timeout. It checks out the run's commit again without stored credentials.
  The pinned download action puts the `extract` artifact in a temporary directory.
  `scripts/accept-harness-catalog.ts` checks the JSON, its size and dropped models, then writes only the known fields of that one file.
  The output is the same file that `test` checked.
  This job never installs dependencies or executes downloaded harness packages or artifact code.
  Only this job has `contents: write` and `pull-requests: write`.
  Before the push and again before the merge, it checks that `main` is still the commit that `test` checked.
  If `main` moved, the job fails without merging. Run the workflow again so that `test` checks the new `main`.
- `report` runs only when a job before it fails. It has `actions: read`, `issues: write` and a 5-minute timeout, and runs only `gh`.
  When the two previous completed runs on `main` also failed, it opens the issue `Harness catalog workflow failed three runs in a row`.
  It opens no second issue while that one is open. Close the issue after the fix.

Before checking for changes, `publish` closes older open `catalog/update-<YYYYMMDD>` PRs from `github-actions[bot]`.
It uses the bot token and only closes branches in this repository. It keeps today's PR for retries.

`catalog/` is deliberately absent from the nightly workflow's change filter.
Catalog-only commits need no build because installed CLIs fetch the file from `main`.
The next regular release or nightly build embeds the latest copy for offline use.
See [configuration](docs/configuration.md#harness-catalog) for cache and offline behavior.

## Claude Code plugins

The shared build workflow packs all three plugin directories once on Linux for releases and nightlies:

- `spatz-claude-plugin-<version>.zip`: the `spatz-mod` plugin.
- `spatz-claude-hooks-<version>.zip`: the `spatz` command hooks.
- `spatz-codex-hooks-<version>.zip`: the Codex `spatz` plugin.
- `marketplace.json`: the release marketplace with HTTPS archive URLs and SHA-256 pins.

These archive filenames remain stable across the plugin ID rename.

Each file has a `.sha256` companion and an entry in `SHA256SUMS`.
Asset filenames replace `+` with `-`. Versions inside manifests keep the original SemVer string.
The build excludes generated mod types, local `tsconfig.json` and `node_modules` from ZIPs.
Plugin launchers download the pinned CLI when needed.

The repository marketplace keeps relative sources for installation from Git.
The build generates the archive-source marketplace in `dist`. The repository marketplace keeps its sources.
Stable URLs use the release tag. Nightly URLs use the fixed `nightly` tag.
Claude Code 2.1.289 passed validation for both source formats.
See [installation](docs/installation.md#install-a-specific-release) for release and manual ZIP installation.

To pack plugins locally, install `zip`. Then run:

```bash
bun scripts/release-version.ts v0.2.0
bun scripts/build-plugins.ts 0.2.0
```

The plugin archive test also needs `unzip`.
The release build does not commit its version changes back to Git.
Before tagging, commit the version bump so Git marketplace users receive the new plugin version.

## npm packages

`.github/workflows/npm-publish.yml` publishes the verified GitHub release archives to npm.
It runs after a successful `Release` or `Nightly` workflow from the same repository.
`Release` runs must use `release.yml` with a `push` event.
`Nightly` runs must use `nightly.yml` with a `schedule` or `workflow_dispatch` event.
The originating run must have a successful `release` job.
For nightlies, the release commit must also match that run's `head_sha`.
Even when the commit matches, a skipped nightly build does not publish to npm.
The workflow checks the release ID before and after downloading to detect replacement during download.
It checks `SHA256SUMS` before it extracts any archive.

The packages are:

- `@spatz/cli`: the `spatz` launcher, with exact-version optional dependencies.
- `@spatz/cli-linux-x64` and `@spatz/cli-linux-arm64`.
- `@spatz/cli-darwin-arm64` and `@spatz/cli-darwin-x64`.
- `@spatz/cli-win32-x64`: experimental and optional.

If the Windows archive is absent, the workflow omits its npm package.

Platform packages keep DuckDB sidecars beside the executable. Linux packages require glibc.
The launcher needs Node.js 18 or newer. Users do not need a separate Bun installation.

### Trusted publishing setup

The owner created all six npm packages as `0.0.0` placeholders for the first publish.
For each package, configure an npm GitHub Actions trusted publisher with these values:

| Field | Value |
| --- | --- |
| Organization or user | `lorenzh` |
| Repository | `spatz` |
| Workflow filename | `npm-publish.yml` |
| Environment | `npm` |

The publish job lives directly in that file. It does not use a reusable publish workflow.
The publish job runs in the GitHub environment `npm`, which only allows deployments from `main`.
npm accepts a token only when the run uses that environment, so a workflow changed on another branch cannot publish.
It uses Node.js 24, npm 11.5.1 or newer, and `id-token: write` for authentication.
The workflow needs no npm token. Each publish includes provenance.
See [npm's trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/) for the package settings.
Merge this workflow into `main` before expecting automatic runs.

### Versions and retries

| GitHub release version | npm version | npm dist-tag |
| --- | --- | --- |
| `v1.2.3` | `1.2.3` | `latest` |
| `v1.2.3-rc.1` | `1.2.3-rc.1` | `next` |
| `1.2.3-nightly.20261005+0123456` | `1.2.3-nightly.20261005.g0123456` | `nightly` |

The `g` prefix keeps numeric SHAs with leading zeros valid in npm versions.
For non-nightly versions, npm drops `+build` metadata. Such releases share the same npm version.
Platform packages publish first. The main package publishes last.
Publish jobs run one at a time. Stable releases compare their version with `@spatz/cli`'s current `latest` version.
Older stable releases use `v<major>.<minor>-latest` instead. A missing `latest` or the `0.0.0` placeholder counts as the lowest version.
Retries skip any package version already on npm, so a partial publish can resume.
Retries also skip E403 errors that say the version was already published.
They do not replace existing versions or move dist-tags for skipped packages.
A forced nightly on the same UTC date and commit has the same npm version.
The workflow skips that existing version.

To retry, open **Actions → Publish npm packages → Run workflow** on `main`.
Set `tag` to the GitHub release tag, such as `v0.2.0` or `nightly`.
The CLI equivalent is:

```bash
gh workflow run npm-publish.yml --ref main -f tag=nightly
```

To assemble packages locally, pass the archive folder, release version, and a new output folder:

```bash
bun scripts/npm-packages.ts dist 0.2.0 /tmp/spatz-npm-packages
```

The script requires all four Linux/macOS archives. Windows is optional.
For a local smoke test with only a host archive, append its target, such as `linux-x64`.
The publish workflow always requires the complete Linux/macOS set.

## Plugin assets

Edit `skills/routing/SKILL.md` as the single source for all plugin skills.
Run `bun scripts/plugin-assets.ts` after changes and commit the generated copies and launchers.
The release version script and plugin archive build also run this step.
Each `bin/spatz` pins the version from its plugin manifest.
Tests check skill equality, launcher behavior, version stamping, and executable permissions after ZIP extraction.
Git marketplace installs use the committed copies and need no build step.
