---
title: Installing spatz
description: Install the spatz CLI and choose Claude Code hooks, the mod, or both.
tags: [installation, cli, claude-code, spatz]
keywords: [install, npm, nightly, binary, release, marketplace, plugin, hooks, mod, zip, archive, PATH, TYPESAFE_AI_API_KEY]
---

# Installing spatz

The Claude Code plugins call the `spatz` CLI. Install the CLI first.

## Install the CLI

With Node.js 18 or newer:

```bash
npm i -g @spatz/cli
spatz --version
```

For the unstable nightly version, use `npm i -g @spatz/cli@nightly`.
The npm packages include the Bun runtime. You do not need to install Bun separately.

You can also download a binary archive from [GitHub Releases](https://github.com/lorenzh/spatz/releases).
Choose your OS and CPU architecture. Check its `.sha256` file before extraction.
Keep the executable and DuckDB libraries together, then put the executable on `PATH`.
See the [binary installation commands](../README.md#releases).
Linux binaries need glibc. Windows binaries are experimental. We have not tested Windows hooks.

Claude Code must find `spatz` in its environment. A shell alias is not enough.
The hooks plugin runs plain `spatz` from `PATH` and has no executable setting.
The mod also defaults to `spatz`, but accepts an executable path through its `spatz` option.

## Configure classification

To use TypeSafe AI classification, set `TYPESAFE_AI_API_KEY` in the environment that starts Claude Code.
Do not put the key in a repository or plugin file.
Without a key, spatz uses local keyword rules.
When classification is enabled, spatz sends task text and candidate models to TypeSafe AI.
It does not store task text. See [configuration](configuration.md) and [privacy](privacy.md).

## Choose a Claude Code setup

Add the marketplace inside Claude Code:

```text
/plugin marketplace add lorenzh/spatz
```

| Setup | Install command | What it does and records |
| --- | --- | --- |
| Hooks only | `/plugin install spatz-hooks@spatz` | Records test/build signals and transcript usage for linked suggestions. It does not request recommendations or switch models. Run `spatz` yourself or through your agent. |
| Mod only | `/plugin install spatz@spatz` | Requests recommendations and can apply model and effort. Records usage directly, without automatic outcome signals. Use `spatz report` for outcomes. |
| Both | Run both install commands | The mod routes. With `record: auto`, the hooks record outcome signals and transcript usage. |

The mod needs Claude Code 2.1.287 or newer. Its defaults are `mode: show`, `scope: subagent` and `record: auto`.
In `show` mode it displays recommendations. To apply them, run `/spatz mode apply`.
See the [mod guide](claude-mod.md) for routing scopes and persistent options.

With both plugins enabled, keep `record: auto`.
The mod checks for an enabled `spatz-hooks@…` plugin once per session.
It then turns off its own usage recording. If that check fails, the mod records usage.
Use `/spatz status` to check the recorder. To force hooks-only recording, use `/spatz record off`.

When you install `spatz-hooks`, remove hand-written `spatz hook` entries from `~/.claude/settings.json`.
Check project settings for the same entries. Keep unrelated hooks.
Otherwise, Claude Code runs both copies.
The mod cannot detect hand-written hooks through the plugin list.
If you keep those hooks with the mod, set `record: off`.

See [hooks](hooks.md) for event details and attribution limits.

## Install a specific release

The repository marketplace uses the plugin directories in Git.
Each release also includes two plugin ZIPs and a `marketplace.json` with archive URLs and SHA-256 pins.
Claude Code supports these [archive sources](https://code.claude.com/docs/en/plugins/marketplace-reference#archive-plugin-source).

To use a released version, add its marketplace URL instead of the Git repository.
Replace `v0.2.0` with the release tag:

```text
/plugin marketplace add https://github.com/lorenzh/spatz/releases/download/v0.2.0/marketplace.json
/plugin install spatz@spatz
/plugin install spatz-hooks@spatz
```

Both marketplaces are named `spatz`. Use only one source at a time.
If you already registered the Git source, remove it with `/plugin marketplace remove spatz` first.
Removing a marketplace also uninstalls its plugins. Reinstall the plugins you need from the new source.
For nightlies, replace `v0.2.0` with `nightly`.

For manual use, download a plugin ZIP and its `.sha256` file from the release.
Check the checksum, then extract the ZIP into its own directory:

```bash
sha256sum --check spatz-claude-plugin-0.2.0.zip.sha256
unzip spatz-claude-plugin-0.2.0.zip -d spatz-plugin
claude --plugin-dir ./spatz-plugin
```

On macOS, use `shasum -a 256 --check` for the checksum.
Use `spatz-claude-hooks-<version>.zip` for the hooks plugin.
`--plugin-dir` loads an extracted plugin for that session.
If you load both plugins manually, set `/spatz record off`.
Automatic detection checks installed plugins.
The ZIPs do not include the CLI.

## Codex

Use the [Codex hooks instructions](hooks.md#codex-cli).
The Claude Code marketplace plugins do not install Codex hooks.
