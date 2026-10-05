---
title: spatz configuration
description: Environment variables, files under ~/.spatz, candidate defaults and harness detection, fixed tuning values and timeouts, and how to preinstall the DuckDB sqlite extension.
tags: [configuration, reference, spatz]
keywords: [models, family, presets, catalog, SPATZ_NO_NETWORK, SPATZ_MODELS, harness, environment variables, env, api key, opt-out, aliases, descriptions, database, cache, openrouter, duckdb, extension, offline, timeout, threshold, tuning, SPATZ_DEBUG, diagnostics, effort]
---

# spatz configuration

You configure spatz with environment variables and optional JSON files. The tuning values are fixed in the code.

For the commands see [cli.md](cli.md). For the hooks see [hooks.md](hooks.md).

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `TYPESAFE_AI_API_KEY` | not set | API key for Jev (TypeSafe AI). When it is not set, spatz classifies with keyword rules (`fallback_used: true`). |
| `SPATZ_NO_NETWORK` | not set | When exactly `1`, suggestions skip harness catalog, OpenRouter and Jev requests. Cached and bundled data still work. |
| `SPATZ_NO_JEV` | not set | When the value is exactly `1`, spatz never sends the task text to Jev. Other values have no effect. |
| `SPATZ_DEBUG` | not set | When the value is exactly `1`, hooks write fixed diagnostics to stderr. Hook commands still exit with code 0. |
| `OPENROUTER_API_KEY` | not set | When set, spatz sends it as `Authorization: Bearer <key>` with the OpenRouter model-list request. The request works without it. |
| `SPATZ_MODELS` | not set | Default candidate list using the `--models` grammar. Overrides project and user defaults. |
| `HOME` | home directory of the OS user | spatz keeps all its files in `$HOME/.spatz`. |

The test suites also read `SPATZ_DUCKDB_EXTENSION_DIR`. The CLI does not read it. See [DuckDB sqlite extension](#duckdb-sqlite-extension).

## Files and directories

| Path | Format | Written by | Purpose |
| --- | --- | --- | --- |
| `~/.spatz/spatz.db` | SQLite, WAL mode | spatz | All suggestions, signals and usage. |
| `~/.spatz/harness-models.json` | JSON | spatz | Cache of the harness model catalog. |
| `~/.spatz/openrouter-models.json` | JSON | spatz | Cache of the OpenRouter model list. |
| `~/.spatz/duckdb-extensions/` | DuckDB extension directory | `spatz stats` | The DuckDB sqlite extension. |
| `~/.spatz/aliases.json` | JSON object | you | Model id mapping. Optional. |
| `~/.spatz/descriptions.json` | JSON object | you | Model descriptions for Jev. Optional. |
| `<cwd>/.spatz.json` | JSON object | you | Project models and Jev opt-out. Optional. |
| `~/.spatz/config.json` | JSON object | you | User default models. Optional. |

spatz creates `~/.spatz` when it opens the database. If an optional file is missing, has invalid JSON or is not an object, spatz ignores it. In `aliases.json` and `descriptions.json`, spatz ignores each entry whose value is not a string. In `.spatz.json`, spatz also reads `models`.

### Database: ~/.spatz/spatz.db

bun:sqlite writes the database in WAL mode with a busy timeout of 5000 ms. So several Claude Code sessions can write at the same time. spatz migrates the schema when it opens the file. `PRAGMA user_version` holds the schema version.

The tables are `suggestions`, `signals`, `usages` and `usage_scopes`. The view `outcomes` computes quality and the used pair per suggestion. No table holds the task text.

To delete all learned data, delete `~/.spatz/spatz.db` and the files `spatz.db-wal` and `spatz.db-shm` next to it.

### OpenRouter cache: ~/.spatz/openrouter-models.json

`spatz "<task>"` needs model prices to sort the candidates by cost. spatz gets them from `https://openrouter.ai/api/v1/models` and keeps a trimmed copy for 24 hours.

- If the cache is younger than 24 hours, spatz makes no request.
- If the request fails or takes more than 3 s, spatz uses the old cache.
- If there is no cache, spatz continues without prices. All models then count as unknown and rank as most expensive.

```json
{
  "fetched_at": 1791100000000,
  "models": [
    {
      "id": "anthropic/claude-sonnet-5.5",
      "name": "Anthropic: Claude Sonnet 5.5",
      "price_prompt": 0.000002,
      "price_completion": 0.00001,
      "context_length": 1000000,
      "supported_efforts": ["low", "medium", "high", "xhigh", "max"]
    }
  ]
}
```

`fetched_at` is epoch milliseconds. Prices are USD per token. The values above are an example. To force a new request, delete the file.

### Alias file: ~/.spatz/aliases.json

The alias file maps a model id that you pass to a canonical OpenRouter id. An alias wins over the built-in id rules. spatz uses it for `--models`, for `spatz report --model` and for model names from transcripts.

```json
{
  "my-fast-model": "vendor/fast-model-2",
  "claude-sonnet-5-5": "anthropic/claude-sonnet-5.5"
}
```

### Description file: ~/.spatz/descriptions.json

The description file gives Jev one short text per canonical model id. Jev uses it to select the best candidate. Without an entry, Jev gets the model name and its output price per million tokens.

```json
{
  "anthropic/claude-sonnet-5.5": "Fast general coding model, good for routine fixes.",
  "anthropic/claude-opus-5.5": "Strongest model, for design work and hard bugs."
}
```

### Default models

Set `models` to a string in `<cwd>/.spatz.json` or `~/.spatz/config.json`:

```json
{ "models": "claude-opus-5-5:low+medium+high,gpt-6-astra:low+medium+high" }
```

Use only models and efforts that your harness can dispatch.
For example, Claude Code users who dispatch GPT through Codex can configure both families.
The mod continues to pass its own `models` userConfig as `--models`.

Precedence: `--models` > `SPATZ_MODELS` > project `models` > user `models` > harness preset.
All values use the [CLI model grammar](cli.md#the---models-grammar).
Empty lists and unknown efforts fail with exit 1. Non-string defaults fail with exit 2 when selected.
A higher-priority source overrides an invalid lower-priority value.

Valid efforts, in ascending cost order, are `none`, `low`, `medium`, `high`, `xhigh`, `max` and `ultra`.
Prices take precedence over effort. `none` means the harness offers no effort setting; it differs from missing usage data (`null`).
Codex supports `ultra` only on models that list it. Claude Code has no `ultra`.
The extractor excludes the Codex reasoning-off `none` from presets. In spatz, `none` means to leave effort unset.
For catalog models with real efforts, `--models` and reports reject `none`. Unknown models keep accepting it.
Usage with missing effort becomes `none` only for catalog models whose sole effort is `none`.
Learning also counts older null-effort outcomes for those models.

### Harness detection

spatz reads the environment of its own process:

| Marker | Catalog entry |
| --- | --- |
| Nonempty `CODEX_THREAD_ID` | `codex` |
| `CLAUDECODE=1` or nonempty `CLAUDE_CODE_ENTRYPOINT` | `claude-code` |

`CODEX_COMPANION_*` variables do not detect Codex.
Codex wins when both markers exist. This selects the inner harness when Codex runs inside a Claude Code shell command.
Environment markers cannot establish arbitrary nesting order. For Claude launched inside Codex, set a model default or pass `--models`.

Codex [injects `CODEX_THREAD_ID` into command environments](https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_env.rs).
Presets use every effort listed for each model in the harness catalog.
The implementation environment confirmed `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT=cli` in Claude Code.

The presets come from the [harness catalog](#harness-catalog) and keep `models_source` as `preset:<harness>`.
Defaults include `none`, `xhigh`, `max` and `ultra` where listed.
Fable stays in the Claude Code preset.
Cold start without a usable Jev choice selects the most expensive pair, except during exploration.
The control group also selects this pair.
Unless a cheaper pair meets the stricter learned limits, critical tasks select it too.
With the current catalog and prices, these pairs are `claude-fable-5-1:max` in Claude Code and `gpt-6-astra:ultra` in Codex.
Effort breaks price ties. See [recommendation.md](recommendation.md#decision-order) for the decision order.
To exclude Fable or another model, set an explicit list of allowed models.
Use `models` in `.spatz.json` or `~/.spatz/config.json`, or set `SPATZ_MODELS`:

```bash
export SPATZ_MODELS='claude-opus-5-5:high,claude-sonnet-5-5:low+medium+high'
```

This list replaces the preset. spatz cannot select omitted models.
Presets describe harness defaults, not account entitlements. If a preset does not match your dispatch tools, use `--models` or a configured default.
Without a detected harness or model default, spatz exits 2 with configuration instructions.

### Harness catalog

When resolution reaches the preset step, spatz reads the detected harness entry from the catalog.
Explicit flags and configured model lists skip the network lookup. Effort validation and usage recording still read the cached or bundled catalog.
The catalog URL is [`https://raw.githubusercontent.com/lorenzh/spatz/main/catalog/harness-models.json`](https://raw.githubusercontent.com/lorenzh/spatz/main/catalog/harness-models.json).

spatz stores the validated document under `catalog` in `~/.spatz/harness-models.json`, with `fetched_at` in epoch milliseconds.
It uses the same 24-hour lifetime and 3-second timeout as the OpenRouter cache.
A fresh cache skips the request. An expired cache or future `fetched_at` triggers a request.
The harness catalog and OpenRouter requests run in parallel.
If the request fails, spatz uses the last valid cache.
If no valid cache exists, spatz uses the JSON bundled into the executable at build time.
Unknown schema versions and malformed known harnesses count as failures. A failed request never replaces a valid cache.
The parser ignores unknown harnesses and extra fields. It removes unknown efforts and models with no remaining efforts.
It rejects structurally broken files and known harnesses with no remaining models. Only breaking changes need a schema bump.
Known harnesses allow up to 50 models and IDs up to 64 characters. Unknown efforts are dropped per model; models with no remaining efforts are ignored.
Downloads stop above 256 KiB.

**v0.1.5 compatibility:** its strict effort validator rejects this entire catalog because it contains `none` and `ultra`.
Those clients keep using their last valid cache or bundled catalog; failed validation does not overwrite the cache.
After each cache TTL expiry, v0.1.5 re-fetches the catalog. Rejected downloads do not reset the TTL.
Each later run that uses a preset retries the request. This adds a small network cost per run.
Upgrade to get the tolerant parser and stop these repeated rejected downloads.
Adding fields cannot teach released clients new efforts. Upgrade the CLI to use these models and efforts.

`SPATZ_NO_NETWORK=1` skips both catalog requests and Jev classification for suggestions.
It uses stale caches and keyword classification.
`SPATZ_NO_JEV=1` and `"jev": false` remain task-text opt-outs. They allow catalog requests because those requests contain no task text.
For offline `spatz stats`, also preinstall the [DuckDB extension](#duckdb-sqlite-extension).

The [daily catalog workflow](../RELEASING.md#daily-harness-catalog) updates models without a CLI release.
The bundled catalog changes with the next build. If your account or dispatch tool exposes different choices, configure models explicitly.

### Per-project configuration: .spatz.json

spatz reads this file only from its working directory, not parent directories.
Run spatz from the project root for this file to apply.
`"jev": false` stops spatz from sending task text to Jev. You can combine it with `models`:

```json
{ "jev": false, "models": "claude-sonnet-5-5" }
```

## Fixed tuning values

These values are start values from the design. The CLI uses them as they are. No environment variable or file changes them. To change them, edit `DEFAULT_TUNING` in `packages/core/src/contracts/types.ts`. A program that uses `@spatz/core` directly can pass its own `config` to `createApi`.

| Value | Default | Meaning |
| --- | --- | --- |
| `minN` | 5 | Learned choice: a pair needs at least this many outcomes in the cell. |
| `minEstimate` | 0.8 | Learned choice: a pair needs at least this estimate. |
| `criticalMinN` | 10 | Critical task: a cheaper pair needs at least this many outcomes. |
| `criticalMinEstimate` | 0.9 | Critical task: a cheaper pair needs at least this estimate. |
| `controlRate` | 0.1 | Share of suggestions in the control group (most expensive pair). |
| `exploreRate` | 0.1 | Share of suggestions that explore a cheaper pair. |
| `jevTimeoutMs` | 1000 ms | Timeout of the Jev request. spatz makes no retry. After a timeout, spatz uses the keyword rules. |
| `difficultyMinProbability` | 0.5 | If the top difficulty has a lower probability, spatz raises the difficulty one level. |
| `openWindowMs` | 2 h | A suggestion closes after this time without a hook event. |
| `openRouterCacheMs` | 24 h | Age of the OpenRouter cache before a new request. |
| `openRouterTimeoutMs` | 3000 ms | Timeout of the OpenRouter request. After a timeout, spatz uses the old cache. |
| `successQuality` | 0.8 | An outcome is a success when its quality is at least this value. |

Other fixed values:

| Value | Default | Where |
| --- | --- | --- |
| Default efforts | `low`, `medium`, `high` | Used when a `--models` entry names no effort. |
| Signal weights | `report` 1.0, `test` 1.0, `build` 0.8 | Weighted mean of the hook signals. |
| Report values | `pass` 1, `partial` 0.5, `fail` 0 | Quality from `spatz report`. |
| Ranking length | up to 3 | Entries in `ranking`. |
| SQLite busy timeout | 5000 ms | Wait time for a locked database. |
| Jev model | `jev-1.13.0` | Model of the Jev request. |

See [recommendation.md](recommendation.md) for how these values decide a recommendation.

## DuckDB sqlite extension

`spatz stats` reads the SQLite database with DuckDB. DuckDB needs its sqlite extension for that. On the first run, `spatz stats` downloads the extension from `extensions.duckdb.org` into `~/.spatz/duckdb-extensions/`. Later runs work offline. No other command loads DuckDB.

If the machine has no network access, the first `spatz stats` fails with exit code 1 and the message `Failed to download extension "sqlite_scanner"`.

To prepare the extension before you go offline, do one of these steps:

1. Run `spatz stats` once on the same machine while it has network access. The database must exist, so run one `spatz "<task>"` first. You can use `--dry-run`.
2. Copy or link an existing extension directory to `~/.spatz/duckdb-extensions`. It must come from the same DuckDB version and platform:

   ```bash
   mkdir -p ~/.spatz
   ln -s /path/to/existing/duckdb-extensions ~/.spatz/duckdb-extensions
   ```

The directory has this layout:

```text
~/.spatz/duckdb-extensions/
  v1.5.6/
    linux_amd64/
      sqlite_scanner.duckdb_extension
      sqlite_scanner.duckdb_extension.info
```

The CLI always uses `~/.spatz/duckdb-extensions`. `SPATZ_DUCKDB_EXTENSION_DIR` has no effect on the CLI. Only the test suites read it, to find an installed extension.
