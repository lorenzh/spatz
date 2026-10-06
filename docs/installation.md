---
title: Installing spatz
description: Install the spatz CLI and choose Claude Code or Codex hooks and plugins.
tags: [installation, cli, claude-code, codex, spatz]
keywords: [install, npm, nightly, binary, release, marketplace, plugin, hooks, mod, zip, archive, PATH, TYPESAFE_AI_API_KEY]
---

# Installing spatz

The plugins include a `bin/spatz` launcher and the `spatz` routing skill.
Hooks and skills work without a separate CLI install when Node.js (npx) or Bun is available.
The launcher uses an installed `spatz` on `PATH` first, then `bunx`, then `npx -y`.
Both package runners use the plugin's exact version. The first run downloads about 60 MB.

## Platform support

Linux builds need glibc. spatz does not support Alpine Linux.
The CLI binary for Windows x64 is experimental, and some releases omit it.
The plugin hooks and launcher need a POSIX shell. The plugins do not support native Windows (Claude Code and Codex). We have not tested Windows hooks.

## Install the CLI

With Node.js 18 or newer:

```bash
npm i -g @spatz/cli
spatz --version
```

For the unstable nightly version, use `npm i -g @spatz/cli@nightly`. To test a release candidate, use `npm i -g @spatz/cli@next`. See [RELEASING.md](../RELEASING.md#release-strategy) for how releases are cut.
The npm packages include the Bun runtime. You do not need to install Bun separately.

You can also download a binary archive from [GitHub Releases](https://github.com/lorenzh/spatz/releases).
Choose your OS and CPU architecture. Check its `.sha256` file before extraction.
Keep the executable and DuckDB libraries together, then put the executable on `PATH`.
See the [binary installation commands](../README.md#releases).

A shell alias does not count as an installed executable.
The mod uses its plugin's `bin/spatz` launcher by default. Set its `spatz` executable option only when you want a custom executable.

## Configure classification

To use TypeSafe AI classification, set `TYPESAFE_AI_API_KEY` in the environment that starts your CLI or coding agent.
Do not put the key in a repository or plugin file.
Without a key, spatz uses local keyword rules.
When classification is enabled, spatz sends task text and candidate models to TypeSafe AI.
It does not store task text. See [configuration](configuration.md) and [privacy](privacy.md).

```bash
export TYPESAFE_AI_API_KEY=<your-key>
```

## Choose a Claude Code setup

Add the marketplace inside Claude Code:

```text
/plugin marketplace add lorenzh/spatz
```

| Setup | Install command | What it does and records |
| --- | --- | --- |
| Hooks only | `/plugin install spatz@spatz` | Records test/build signals and transcript usage for linked suggestions. It does not request recommendations or switch models. Run `spatz` yourself or through your agent. |
| Mod only | `/plugin install spatz-mod@spatz` | Requests recommendations and can apply model and effort. Records usage directly, without automatic outcome signals. Use `spatz report` for outcomes. |
| Both | Run both install commands | The mod routes and owns usage for its registered execution segments. Hooks record outcome signals and skip usage owned by the mod. |

If you installed the 0.1.1 hooks plugin as `spatz-hooks@spatz`, migrate it:

```text
/plugin uninstall spatz-hooks@spatz
/plugin install spatz@spatz
```

If you installed the 0.1.1 mod as `spatz@spatz`, that ID now installs the hooks plugin. Install the mod as `spatz-mod@spatz` instead.

The mod needs Claude Code 2.1.287 or newer. Its defaults are `mode: show`, `scope: subagent` and `record: auto`.
In `show` mode it displays recommendations. To apply them, run `/spatz mode apply`.
See the [mod guide](claude-mod.md) for routing scopes and persistent options.

With both plugins enabled, keep `record: auto`.
`auto` equals `on`: the mod registers starts and records step usage.
Hooks record test/build signals and skip usage owned by the mod.
Use `/spatz status` to check the recorder.
To use hooks for all usage recording, run `/spatz record off`.
The shared skill skips CLI recommendations for Claude Code subagents because the mod routes them. It still uses spatz for Codex runs and other harnesses.

When you install the `spatz` hooks plugin, remove hand-written `spatz hook` entries from `~/.claude/settings.json`.
Check project settings for the same entries. Keep unrelated hooks.
Otherwise, Claude Code runs both copies.
If you use hand-written hooks with the mod, keep `record: auto`.
The same ownership rule prevents those hooks from recording usage owned by the mod.

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
/plugin install spatz-mod@spatz
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
Use `spatz-claude-hooks-<version>.zip` for the `spatz` hooks plugin. ZIP names stay stable across the plugin ID rename.
`--plugin-dir` loads an extracted plugin for that session.
If you load both plugins manually, keep `record: auto`.
Hooks record outcome signals and skip usage owned by the mod.
The ZIPs include the launcher and skill. The launcher downloads the CLI when needed.

## Use with Codex

Install the Codex marketplace plugin:

```text
codex plugin marketplace add lorenzh/spatz
codex plugin add spatz@spatz
```

If you installed `spatz-hooks@spatz` with Codex 0.1.1, run `codex plugin remove spatz-hooks@spatz`, then `codex plugin add spatz@spatz`, and review and trust the hooks again in `/hooks`. If you installed the 0.1.1 Claude mod as `spatz@spatz`, use `spatz-mod@spatz` for the mod.

Review and trust the new hooks with `/hooks` before they run. Codex stores plugin hooks separately from manually configured hooks. Remove hand-written `spatz hook … --agent codex` entries from `~/.codex/hooks.json` when installing the plugin, or events are recorded twice.
Codex supplies `PLUGIN_ROOT` to plugin hooks. The plugin's `packages/codex-hooks/hooks/hooks.json` invokes `sh "${PLUGIN_ROOT}/bin/spatz"`.
Before the first hook, warm the pinned CLI through the plugin launcher:

```bash
"<plugin root>/bin/spatz" --version
```

For Codex marketplace installs, the root is `~/.codex/plugins/cache/spatz/spatz/<version>`; confirm it from Codex's plugin listing. Claude Code's installed plugin path is shown by `/plugin` and is usually `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`. Direct npx warms `@latest`, and Bun has a separate cache. Codex hooks have a 10-second timeout, so warm-up avoids a cold download during a hook.

Without the plugin, add manual hooks to `~/.codex/hooks.json` using plain `spatz` on `PATH`:

```json
{
	"hooks": {
		"PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "spatz hook PostToolUse --agent codex", "timeout": 10 }] }],
		"Stop": [{ "hooks": [{ "type": "command", "command": "spatz hook Stop --agent codex", "timeout": 10 }] }]
	}
}
```

The plugin's `packages/codex-hooks/hooks/hooks.json` contains:

```json
{
	"hooks": {
		"PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "sh \"${PLUGIN_ROOT}/bin/spatz\" hook PostToolUse --agent codex", "timeout": 10 }] }],
		"Stop": [{ "hooks": [{ "type": "command", "command": "sh \"${PLUGIN_ROOT}/bin/spatz\" hook Stop --agent codex", "timeout": 10 }] }]
	}
}
```
See [Codex hooks](hooks.md#codex-cli) for the events and limits.

## Routing skill

Each plugin ships the same `routing` skill under `skills/routing/SKILL.md` (`/spatz:routing` for the hooks plugin, `/spatz-mod:routing` for the mod, and `spatz:routing` for Codex).
It asks agents to rank available model and effort pairs before delegation.
It also covers reviews by the other model family and explicit outcome reports.
The skill requests agent behavior. It does not add dispatch tools or switch models itself.
When both Claude plugins are enabled, use either copy for a dispatch, not both.
The mod's `/spatz` command checks status and changes mode or scope. It is separate from the namespaced `routing` skill.
