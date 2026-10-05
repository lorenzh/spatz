---
title: Releasing spatz
description: How to publish CLI and Claude Code plugin archives and npm packages, and control nightly builds and daily harness catalog updates.
tags: [spatz, cli, releases]
keywords: [release, nightly, catalog, harness, workflow, tag, semver, publish, checksum, binary, archive, download, npm, install, trusted publishing, plugin, marketplace, zip]
---

# Releasing spatz

1. Run `bun scripts/release-version.ts v0.2.0` with the next SemVer version. Include all five manifests in the version bump.
2. Run the gates in [CONTRIBUTING.md](CONTRIBUTING.md). Commit the bump and merge it into `main` through a pull request.
3. Tag the merged commit and push the tag:

   ```bash
   git switch main
   git pull --ff-only
   git tag v0.2.0
   git push origin v0.2.0
   ```

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
Account entitlements can differ from these package defaults.

When the file changes, the workflow commits it on `catalog/update-<YYYYMMDD>` using `github-actions[bot]`.
It creates a PR to `main`, then runs `gh pr merge --merge --delete-branch`.
A repeated run updates today's open branch with a force-with-lease push and reuses its PR.
If the file has no changes, the workflow exits without a commit.
The workflow uses two jobs, each with a timeout:

- `extract` has `contents: read` and a 15-minute timeout. Its checkout stores no credentials.
  It runs the extractor and uploads only `catalog/harness-models.json` with the pinned artifact action.
- `publish` needs `extract` and has a 10-minute timeout. It checks out `main` again without stored credentials.
  The pinned download action puts the artifact in a temporary directory.
  The repository parser checks the JSON and its size before the job copies that one file.
  This job never installs or executes downloaded harness packages or artifact code.
  Only this job has `contents: write` and `pull-requests: write`.

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
