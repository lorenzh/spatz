---
title: spatz configuration
description: Environment variables, files under ~/.spatz, candidate defaults and harness detection, fixed tuning values and timeouts. `spatz stats` reads the database with bun:sqlite and needs no download.
tags: [configuration, reference, spatz]
keywords: [bench.use, bench.snapshot, bench.prior_weight, bench-snapshot.json, spatz-measurements, bench_attempts, import-eval, bench prior, cost, tokens, price_snapshot, price_date, migration, backup, restore, rollback, downgrade, failures, launcher, models, family, presets, catalog, allow-drop, retired models, SPATZ_NO_NETWORK, SPATZ_MODELS, harness, environment variables, env, api key, opt-out, aliases, descriptions, database, cache, openrouter, offline, bun:sqlite, timeout, threshold, tuning, SPATZ_DEBUG, SPATZ_SUGGESTION_ID, diagnostics, effort]
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
| `SPATZ_FAMILY_POOLING` | not set | When the value is exactly `1`, a thin cell also pools over the same task-type family at the same difficulty. Off by default. See [recommendation.md](recommendation.md). |
| `SPATZ_DEBUG` | not set | When the value is exactly `1`, hooks write fixed diagnostics to stderr. Hook commands still exit with code 0. |
| `SPATZ_SUGGESTION_ID` | not set | Read only by Codex hooks. At Stop, record that turn's usage and test/build signals against this existing suggestion instead of using session attribution. An unknown ID records a hook failure. See [Link a dispatched Codex run](hooks.md#link-a-dispatched-codex-run). |
| `OPENROUTER_API_KEY` | not set | When set, spatz sends it as `Authorization: Bearer <key>` with the OpenRouter model-list request. The request works without it. |
| `SPATZ_MODELS` | not set | Default candidate list using the `--models` grammar. Overrides project and user defaults. |
| `HOME` | home directory of the OS user | spatz keeps all its files in `$HOME/.spatz`. |

## Files and directories

| Path | Format | Written by | Purpose |
| --- | --- | --- | --- |
| `~/.spatz/spatz.db` | SQLite, WAL mode | spatz | Suggestions, signals, usage and parse or hook failures. |
| `~/.spatz/spatz.db.bak-v*` | SQLite backups | spatz | Database copies made before schema upgrades, including incomplete backup files left after an interrupted process. |
| `~/.spatz/launcher-failures` | One `1` marker per line | Plugin launchers | Failed hook launches for `spatz stats`. |
| `~/.spatz/harness-models.json` | JSON | spatz | Cache of the harness model catalog. |
| `~/.spatz/bench-snapshot.json` | JSON | spatz | Cache of the verified bench snapshot release (24 h). See [recommendation.md](recommendation.md#bench-prior). Older versions kept per-model files in `~/.spatz/catalog/`; spatz no longer reads them, and you can delete that folder. |
| `~/.spatz/openrouter-models.json` | JSON | spatz | Cache of the OpenRouter model list. |
| `~/.spatz/aliases.json` | JSON object | you | Model id mapping. Optional. |
| `~/.spatz/descriptions.json` | JSON object | you | Model descriptions for Jev. Optional. |
| `<cwd>/.spatz.json` | JSON object | you | Project models, Jev opt-out and the `bench` settings. Optional. |
| `~/.spatz/config.json` | JSON object | you | User default models and the `bench` settings. Optional. |

spatz creates `~/.spatz` when it opens the database. If an optional file is missing, has invalid JSON or is not an object, spatz ignores it. In `aliases.json` and `descriptions.json`, spatz ignores each entry whose value is not a string. In `.spatz.json`, spatz also reads `models`.

### Database: ~/.spatz/spatz.db

bun:sqlite writes the database in WAL mode with a busy timeout of 5000 ms. So several Claude Code sessions can write at the same time. spatz migrates the schema when it opens the file. `PRAGMA user_version` holds the schema version.

The tables are `suggestions`, `signals`, `usages`, `usage_scopes` and `failures`. Schema v12 adds `bench_attempts` for rows from [`spatz import-eval`](cli.md#spatz-import-eval), one per `run_id`. Schema v13 adds `bench_attempts.source_run`, the measurement run of each imported row. The view `outcomes` computes quality and the used pair per suggestion. No table holds the task text.

To delete all learned data, delete `~/.spatz/spatz.db` and the files `spatz.db-wal` and `spatz.db-shm` next to it.
Also delete its `spatz.db.bak-v*` backups.

### Database backup and restore

Before an upgrade of an existing non-empty database, spatz creates `spatz.db.bak-v<from>` beside the database.
The backup includes committed WAL data and keeps the old schema version.
spatz holds the migration write lock during backup and migration.
It waits up to 5000 ms for another writer to finish.
If backup creation fails, the migration stops.
Fresh databases and databases at the current version need no backup.

spatz keeps the current backup and up to two other schema-version backups.
A retry replaces the backup for the same source version only after the new copy is complete.
In-memory databases have no file backup.

This CLI includes a newer-schema refusal guard: commands fail with an instruction to upgrade the CLI if the database schema is newer than supported.
Hooks ignore the error and exit 0 silently. They record no data until a compatible CLI is installed.

CLIs up to v0.1.6 do not contain this guard. They can write to a newer schema after a downgrade.
Before installing one of those versions, restore a backup whose schema it supports using the steps below.

To restore before a downgrade:

1. Stop all spatz commands and agent sessions that use the database.
2. Keep a separate copy of the current database and any `spatz.db-wal` and `spatz.db-shm` files.
3. If present, remove `spatz.db-wal` and `spatz.db-shm` from the stopped database directory.
4. Copy `spatz.db.bak-v<from>` over `spatz.db` in the same directory.
5. Install the CLI and plugins compatible with the restored schema.
6. Run `spatz stats` to check the restored data.

Restoration loses records created after the backup.
Never restore over a database while a process has it open.
Release owners must complete the [migration checklist](../RELEASING.md#migration-checklist-for-breaking-releases).

### Launcher failures

If a hook command exits unsuccessfully, the plugin launcher appends a fixed marker to `$HOME/.spatz/launcher-failures`.
This covers missing runtimes and failed package downloads. Hook wrappers can discard stderr without hiding the count.
The launcher needs a writable `$HOME/.spatz` directory. If the directory is missing, the launcher creates it with `mkdir`.
New marker files use owner-only permissions. If the write fails, the launcher preserves the original exit code and cannot count that failure.

`spatz stats` reads the file on each run. It does not clear the file or need `SPATZ_DEBUG=1`.
The file grows by two bytes per failed invocation and has no automatic rotation.
To reset only the launcher counter, delete this file while hooks are idle.
Deleting the database resets parse and hook counters but leaves launcher markers intact.

### OpenRouter cache: ~/.spatz/openrouter-models.json

`spatz "<task>"` needs model prices to sort the candidates by cost. spatz gets them from `https://openrouter.ai/api/v1/models` and keeps a trimmed copy for 24 hours.

- If the cache is younger than 24 hours and includes both cache-price keys for every model, spatz makes no request.
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
      "price_cache_read": 0.0000002,
      "price_cache_write": 0.0000025,
      "context_length": 1000000,
      "supported_efforts": ["low", "medium", "high", "xhigh", "max"]
    }
  ]
}
```

`fetched_at` is epoch milliseconds. Prices are USD per token. The values above are an example. To force a new request, delete the file.

The cache also stores `price_cache_read` and `price_cache_write` from OpenRouter.
OpenRouter names these rates `input_cache_read` and `input_cache_write`.
Missing or invalid cache rates are `null`.
If any cached model lacks either key, spatz treats the cache as stale and requests fresh prices when online.
Explicit `null` values do not trigger this refresh.
If offline or the request fails, spatz still uses the old cache with null cache rates.

Each suggestion stores a `price_snapshot` keyed by its candidate model IDs.
Each entry holds all four rates. `price_date` records the capture time in epoch milliseconds.
The rates can come from a stale cache during an outage or offline run.
A later cache refresh does not change existing snapshots or usage costs.
If a used model has no snapshot, its calculated cost is unavailable.
A positive token count with a missing rate also makes cost unavailable.
Zero or null counters need no rate. Reported USD costs take priority over calculated costs.
See [normalized tokens and cost](how-it-works.md#normalized-tokens-and-cost).

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

The [daily catalog workflow](../RELEASING.md#daily-harness-catalog) updates models without a CLI release.
The bundled catalog changes with the next build. If your account or dispatch tool exposes different choices, configure models explicitly.
The workflow publishes only after the tests pass. It only adds models and changes efforts; it never removes a model from the catalog.
A model that a harness no longer offers stays in the catalog until a maintainer runs `bun scripts/harness-catalog.ts --allow-drop` and merges the result through a reviewed PR.
Until then, presets can still suggest that model. Configure models explicitly to exclude it.

### Per-project configuration: .spatz.json

spatz reads this file only from its working directory, not parent directories.
Run spatz from the project root for this file to apply.
`"jev": false` stops spatz from sending task text to Jev. You can combine it with `models`:

```json
{ "jev": false, "models": "claude-sonnet-5-5" }
```

### Bench evidence: bench settings

By default spatz uses the [bench snapshot](recommendation.md#bench-prior) of [spatz-measurements](https://github.com/lorenzh/spatz-measurements) as a capped prior. It downloads the snapshot at most once a day and uploads nothing. Three settings change the bench evidence:

| Setting | Default | Effect |
| --- | --- | --- |
| `bench.snapshot` | `true` | `false` turns the snapshot prior off. spatz then downloads no snapshot. |
| `bench.prior_weight` | `6` | The bench prior of a cell is worth at most this many outcomes. A number of at least 0; `0` turns every bench prior off. |
| `bench.use` | `false` | `true` lets rows imported with [`spatz import-eval`](cli.md#spatz-import-eval) join the prior. Otherwise they appear only in `spatz stats`. |

```json
{ "bench": { "snapshot": true, "prior_weight": 6, "use": true } }
```

Put them in `~/.spatz/config.json` for all projects, or in `<cwd>/.spatz.json` for one project. The project file wins per setting. spatz ignores a value of the wrong type or a negative weight.

The prior changes the estimate, but never `n` or the gates, so live outcomes stay in control. With `bench.use` on, imported rows replace the snapshot cells of the same measurement runs, so no run counts twice. `spatz stats` shows the snapshot in use, its source and its age.

## Fixed tuning values

These values are start values from the design. The CLI uses them as they are. No environment variable or file changes them. To change them, edit `DEFAULT_TUNING` in `packages/core/src/contracts/types.ts`. A program that uses `@spatz/core` directly can pass its own `config` to `createApi`.

| Value | Default | Meaning |
| --- | --- | --- |
| `minN` | 5 | Learned choice: a pair needs at least this many outcomes in the cell. |
| `minEstimate` | 0.8 | Learned choice: a pair needs at least this success estimate. |
| `criticalMinN` | 10 | Critical task: a cheaper pair needs at least this many outcomes. |
| `criticalMinEstimate` | 0.9 | Critical task: a cheaper pair needs a 5 % lower credible bound of success of at least this. |
| `controlRate` | 0.1 | Share of suggestions in the control group (most expensive pair). |
| `exploreRate` | 0.1 | Share of suggestions that explore a cheaper pair. |
| `jevTimeoutMs` | 1000 ms | Timeout of the Jev request. spatz makes no retry. After a timeout, spatz uses the keyword rules. |
| `difficultyMinProbability` | 0.5 | If the top difficulty has a lower probability, spatz raises the difficulty one level. |
| `openWindowMs` | 2 h | A suggestion closes after this time without a hook event. |
| `openRouterCacheMs` | 24 h | Age of the OpenRouter cache before a new request. |
| `openRouterTimeoutMs` | 3000 ms | Timeout of the OpenRouter request. After a timeout, spatz uses the old cache. |
| `successQuality` | 0.8 | An outcome is a success when its quality is at least this value. |
| `priorWeight` | 6 | The bench prior of a cell is worth at most this many outcomes. `bench.prior_weight` in a config file changes it. |

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
