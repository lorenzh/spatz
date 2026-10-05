---
title: Releasing spatz
description: How to publish tagged releases and build nightly CLI archives.
tags: [spatz, cli, releases]
keywords: [release, nightly, tag, semver, publish, checksum, binary, archive, download]
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
If the existing nightly release records the same commit as `main`, the workflow skips the build.
Its version is `<package version>-nightly.<YYYYMMDD>+<shortsha>`.
The workflow replaces any existing build metadata.
After all builds pass, it replaces the fixed `nightly` tag and prerelease.
The release body records the UTC date and full commit SHA.

Both workflows use Linux x64/arm64 and macOS x64/arm64 native runners. They also produce an experimental Windows x64 ZIP archive. A Windows build failure does not block the other release assets. Windows hooks are untested.
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
