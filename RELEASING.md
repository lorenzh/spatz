---
title: Releasing spatz
description: How to publish release archives and npm packages, and control nightly builds.
tags: [spatz, cli, releases]
keywords: [release, nightly, tag, semver, publish, checksum, binary, archive, download, npm, install, trusted publishing]
---

# Releasing spatz

1. Bump `version` in `packages/cli/package.json` to the next SemVer version, for example `0.2.0`.
2. Run the gates in [CONTRIBUTING.md](CONTRIBUTING.md). Commit the bump and merge it into `main` through a pull request.
3. Tag the merged commit and push the tag:

   ```bash
   git switch main
   git pull --ff-only
   git tag v0.2.0
   git push origin v0.2.0
   ```

The release workflow rejects tags that do not contain a valid SemVer version.
It sets the CLI package version from the tag before the frozen dependency install.
Each native runner runs the tests, typecheck, lint, build, and archive smoke test.
GitHub publishes the archives, SHA256 checksums, and generated release notes after all builds pass.
Versions such as `v0.2.0-rc.1` produce prereleases.
Build metadata alone does not make a prerelease: `v0.2.0+build.1` remains a stable release.

The nightly workflow runs daily at 03:00 UTC and accepts manual runs from GitHub Actions.
The workflow compares `main` with the previous nightly commit.
Changes under `packages/`, `scripts/`, `package.json`, `bun.lock`, or `.github/workflows/` trigger a build.
Documentation-only changes do not trigger a build.
If Git cannot resolve the previous commit, the workflow builds.
For a manual rebuild, enable the boolean `force` input. Its default is `false`.
Its version is `<package version>-nightly.<YYYYMMDD>+<shortsha>`.
The workflow replaces any existing build metadata.
After all builds pass, it replaces the fixed `nightly` tag and prerelease.
The release body records the UTC date and full commit SHA.

Both workflows use Linux x64/arm64 and macOS x64/arm64 native runners. They also produce an experimental Windows x64 ZIP archive. A Windows build failure does not block the other release assets. Windows hooks are untested.
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

## npm packages

`.github/workflows/npm-publish.yml` publishes the verified GitHub release archives to npm.
It runs after a successful `Release` or `Nightly` workflow.
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

Platform packages keep DuckDB sidecars beside the executable.
The launcher needs Node.js 18 or newer. Users do not need a separate Bun installation.

### Trusted publishing setup

The owner created all six npm packages as `0.0.0` placeholders for the first publish.
For each package, configure an npm GitHub Actions trusted publisher with these values:

| Field | Value |
| --- | --- |
| Organization or user | `lorenzh` |
| Repository | `spatz` |
| Workflow filename | `npm-publish.yml` |
| Environment | Leave empty |

The publish job lives directly in that file. It does not use a reusable publish workflow.
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
Retries skip any package version already on npm, so a partial publish can resume.
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
