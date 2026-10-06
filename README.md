<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img src="docs/assets/banner-light.svg" alt="spatz" width="340" height="84">
</picture>

# spatz

**Choose a model and effort for your coding task. Learn from the result.**

Harness model defaults refresh from a [daily catalog](docs/configuration.md#harness-catalog), without a CLI release.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/v/release/lorenzh/spatz)](https://github.com/lorenzh/spatz/releases/latest)
[![Bun 1.4](https://img.shields.io/badge/Bun-1.4-black?logo=bun)](https://bun.sh)
[![CI](https://github.com/lorenzh/spatz/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lorenzh/spatz/actions/workflows/ci.yml)
[![Harness catalog](https://github.com/lorenzh/spatz/actions/workflows/harness-catalog.yml/badge.svg)](https://github.com/lorenzh/spatz/actions/workflows/harness-catalog.yml)
[![Nightly](https://github.com/lorenzh/spatz/actions/workflows/nightly.yml/badge.svg)](https://github.com/lorenzh/spatz/actions/workflows/nightly.yml)

spatz ranks the model and effort pairs that you can use for a coding task.
It learns from task results to help choose cheaper pairs that succeed.
You or your coding agent run the task with the recommended pair.

[Quickstart](#quickstart) · [Documentation](#documentation) · [Contributing](#contributing) · [Releases](https://github.com/lorenzh/spatz/releases)

## Why spatz?

Different tasks need different models and effort levels.
spatz combines task classification with results from your previous tasks.

- **Use your available models.** Start with harness defaults or set your own candidates.
- **Learn from results.** Record outcomes through hooks or `spatz report`.
- **Compare performance.** Use `spatz stats` to see results per task type or routing scope.
- **Connect to coding agents.** Hooks support Claude Code and Codex CLI. Other agents can use the CLI directly.
- **Keep learning data local.** spatz stores results in `~/.spatz/spatz.db`. It does not store task text.

## Quickstart

### 1. Install

Install the stable CLI with Node.js 18 or newer:

```bash
npm install -g @spatz/cli
spatz --version
```

The npm package includes the Bun runtime. Keep optional dependencies enabled.
Linux needs glibc. spatz does not support Alpine Linux.
For Windows, see [Platform support](docs/installation.md#platform-support).

For installation without Node.js, use a [release archive](#releases).
For the unstable nightly version, use `npm install -g @spatz/cli@nightly`. To test a release candidate, use `npm install -g @spatz/cli@next`.

### 2. Ask for a recommendation

From Claude Code or Codex, pass the task:

```bash
spatz "Fix the off-by-one error in src/list.ts"
```

spatz uses a preset for the detected harness.
Override it with `--models`, `SPATZ_MODELS`, or `models` in [configuration files](docs/configuration.md#default-models).
Use `--family claude` or `--family gpt` to filter candidates for a review.
The output includes a `suggestion_id` and a ranked list of pairs.
Add `--json` for machine-readable output.

spatz works without an API key.
Without Jev or learned results, it recommends the most expensive candidate.
Jev is the TypeSafe AI model that classifies the task and estimates candidate suitability.
To enable Jev, set your TypeSafe AI key:

```bash
export TYPESAFE_AI_API_KEY="<your-key>"
```

When you enable Jev, spatz sends task text and candidate details to TypeSafe AI.
Read [Privacy](#privacy) before using sensitive task text.

### 3. Run the task and report the result

Run the task with the chosen model and effort in your coding agent.
Then report the pair you actually used:

```bash
spatz report <suggestion_id> \
  --model claude-sonnet-5-5 --effort medium --result pass

spatz stats
```

Replace `<suggestion_id>` with the ID from the recommendation.
Results can be `pass`, `partial`, or `fail`.
An explicit report overrides hook signals for its selected attempt.
A changed verdict creates a retry. Use `--correct` to fix a mistaken report.
Use `--attempt <id> --confirm` to report on an existing attempt without creating a retry.
Use `spatz suggest "Retry the task" --retry-of <suggestion_id>` to link a new suggestion to the same recovery chain.
See [report flags](docs/cli.md#spatz-report) for explicit attempt selection.

For experiments, add `--dry-run` to the recommendation command.
These suggestions never count toward learning or statistics.

## How it works

1. A local filter checks the task text for known secret patterns.
2. Jev classifies the task. Without Jev, spatz uses local keyword rules.
3. spatz ranks your candidates using classification and learned success estimates.
4. You or your agent choose a pair and run the task.
5. Hooks or `spatz report` record the outcome for future recommendations.

The CLI recommends pairs. The optional Claude Code mod can apply them automatically.
See [How it works](docs/how-it-works.md) and [Recommendation rules](docs/recommendation.md) for the decision process.

## Agent integrations

| Integration | What it does | Setup |
| --- | --- | --- |
| Claude Code `spatz` plugin | Record task signals and model usage. | [Hooks guide](docs/hooks.md) |
| Codex `spatz` plugin | Record shell results and model usage. | [Hooks guide](docs/hooks.md) |
| Claude Code `spatz-mod` plugin (mod) | Show recommendations or apply model and effort choices. | [Mod guide](docs/claude-mod.md) |
| Other agents | Request recommendations and report outcomes through the CLI. | [CLI reference](docs/cli.md) |

The Claude Code mod supports `step`, `turn`, `subagent`, `session`, and `escalate` routing scopes.
Hooks and the mod can run together. With `record: auto`, the mod records step usage and hooks record signals.

### Install for Claude Code

Use macOS or Linux with a POSIX shell (see [Platform support](docs/installation.md#platform-support)).
The plugins run the CLI through a bundled launcher: an installed `spatz` on `PATH` wins, otherwise it uses Bun or npx from the `PATH` Claude Code starts with.
The mod needs Claude Code 2.1.287 or newer.

1. Start Claude Code. Add the marketplace and install the hooks:

   ```text
   /plugin marketplace add lorenzh/spatz
   /plugin install spatz@spatz
   ```

   The hooks record test/build results and model usage. They do not switch models.

2. Optional: install the mod for automatic recommendations:

   ```text
   /plugin install spatz-mod@spatz
   ```

   The mod defaults to `show` mode. To apply recommendations to subagents, run:

   ```text
   /spatz mode apply
   /spatz status
   ```

   When you install both plugins, keep `record: auto`. Hooks record signals. The mod owns usage for its registered execution segments.
   To apply recommendations to the main session too, enable `/spatz main on`.

3. Remove any manual `spatz hook` entries from `~/.claude/settings.json` and project settings.
   Keep unrelated hooks. This avoids duplicate records.

See the [Claude Code mod guide](docs/claude-mod.md) for routing scopes and persistent configuration.

### Install for Codex CLI

Use macOS or Linux with a POSIX shell and a Codex CLI version with plugin support.
Install the [spatz CLI](#quickstart) first and check `spatz --version` in your terminal.

1. Add the marketplace and install the hooks from your terminal:

   ```bash
   codex plugin marketplace add lorenzh/spatz
   codex plugin add spatz@spatz
   codex plugin list
   ```

2. Start Codex. Run `/hooks` to review and trust the spatz hooks.
   Codex skips plugin hooks until you trust them. See [OpenAI's hook documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

3. Remove any manual `spatz hook … --agent codex` entries from `~/.codex/hooks.json`.
   Keep unrelated hooks. This avoids duplicate records.

The plugin records shell results and model usage. Its routing skill guides the agent through recommendations and outcome reports.
It does not automatically switch the Codex model.
See the [Codex hooks guide](docs/hooks.md#codex-cli) for recorded events and limits.

### Check your setup

If you use Jev, set `TYPESAFE_AI_API_KEY` in the terminal before starting your coding agent.
Ask your agent to request a recommendation for a real task using its available model and effort pairs.
Keep the suggestion output unfiltered so the hooks can read its ID.
After the task, ask the agent to report the actual pair and result with `spatz report`.
Run `spatz stats` to see recorded outcomes.

Every plugin ships the `routing` skill (`/spatz:routing`, `/spatz-mod:routing`, or `spatz:routing` in Codex). The mod's `/spatz` command checks status and changes mode or scope. You do not need to edit your agent instructions.
Every plugin can run without a global CLI through its bundled launcher using Bun or npx.
The first run downloads about 60 MB. Codex hooks time out after 10 seconds.
For this setup, warm the launcher before the first session with `"<plugin root>/bin/spatz" --version`.
See [Installation](docs/installation.md) for launcher paths and setup without a global CLI.

## Privacy

spatz stores learning data under `~/.spatz`. It does not store task text or tool output.
Hooks process task signals locally and make no network requests.

When you enable Jev, spatz sends task text and candidate details to TypeSafe AI.
The secret filter catches known patterns. It cannot detect every secret.
Do not put secrets in task text.

To disable Jev:

```bash
export SPATZ_NO_JEV=1
```

For a project, put `{"jev": false}` in `.spatz.json` in the working directory.
Without `TYPESAFE_AI_API_KEY`, Jev is also disabled.

Disabling Jev still allows OpenRouter requests for model prices. These requests contain no task data.
spatz caches prices for 24 hours. When the network is unavailable, spatz can still use cached prices.

See the [Privacy guide](docs/privacy.md) for data flows and deletion instructions.
See [Configuration](docs/configuration.md) for environment variables and local files.

## Releases

Download an archive and its matching `.sha256` file from [GitHub Releases](https://github.com/lorenzh/spatz/releases).
Archives include the runtime. You do not need Node.js or Bun installed.

Choose `linux` or `darwin` (macOS), then `x64` or `arm64`.
Apple Silicon uses `darwin-arm64`. Linux builds need glibc.
For Windows archives, see [Platform support](docs/installation.md#platform-support).

Check the checksum before extraction. This Linux x64 example uses version `0.1.0`:

```bash
version=0.1.0
archive="spatz-cli-$version-linux-x64.tar.gz"
sha256sum --check "$archive.sha256"

mkdir -p ~/.local/lib/spatz ~/.local/bin
tar -xzf "$archive" -C ~/.local/lib/spatz
ln -sfn "$HOME/.local/lib/spatz/${archive%.tar.gz}/spatz" ~/.local/bin/spatz
export PATH="$HOME/.local/bin:$PATH"
spatz --version
```

Use your downloaded version. On macOS, use `shasum -a 256 --check "$archive.sha256"`.
If your shell does not include `~/.local/bin`, add the `PATH` line to your shell profile.

The [nightly release](https://github.com/lorenzh/spatz/releases/tag/nightly) is unstable.
See [Releasing spatz](RELEASING.md) for the release process.

## Install from source

Install Bun 1.4, then clone the repository:

```bash
git clone https://github.com/lorenzh/spatz.git
cd spatz
bun install
```

Put a wrapper on your `PATH` so hooks can find `spatz` in non-interactive shells:

```bash
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec bun "%s/packages/cli/src/cli.ts" "$@"\n' "$PWD" > ~/.local/bin/spatz
chmod +x ~/.local/bin/spatz
export PATH="$HOME/.local/bin:$PATH"
spatz --version
```

A shell alias does not work for hooks.
See [Contributing](CONTRIBUTING.md) for the full development setup.

## Documentation

| Guide | What you will find |
| --- | --- |
| [CLI reference](docs/cli.md) | Commands, flags, model IDs, output fields, and exit codes. |
| [How it works](docs/how-it-works.md) | Architecture and the flow from task to outcome. |
| [Recommendation rules](docs/recommendation.md) | Ranking, exploration, and control groups. |
| [Measurements](docs/measurements.md) | Benchmark results for model and effort selection. |
| [Hooks](docs/hooks.md) | Claude Code and Codex CLI setup and recorded signals. |
| [Claude Code mod](docs/claude-mod.md) | Modes, routing scopes, and `/spatz` commands. |
| [Configuration](docs/configuration.md) | Environment variables and local files. |
| [Privacy](docs/privacy.md) | Network requests, stored data, and deletion. |

## Contributing

Bug reports and pull requests are welcome.
For larger changes, [open an issue](https://github.com/lorenzh/spatz/issues) first to agree on the scope.
See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the test-first workflow.
Changes to `main` must go through a pull request.

Run the checks before submitting a change:

```bash
bun test
bun run typecheck
bun run lint
```

For vulnerabilities, follow [SECURITY.md](SECURITY.md). Do not open a public issue.

## License

[MIT](LICENSE) © 2026 Lorenz Hilpert.
