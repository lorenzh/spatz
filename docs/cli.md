---
title: spatz CLI reference
description: Every spatz command with its flags, defaults, the --models grammar, text and JSON output fields, exit codes and examples.
tags: [cli, reference, spatz]
keywords: [command line, commands, flags, options, models, effort, json output, exit code, suggest, report, stats, hook, usage, version]
---

# spatz CLI reference

spatz has four commands. Each command calls the `@spatz/core` API and formats the result. The CLI has no other logic.

```text
spatz --version
spatz "<task>" --models <list> [--json] [--dry-run]
spatz report <suggestion_id> --model <m> --effort <e> --result pass|partial|fail [--rounds <n>] [--note <t>] [--json]
spatz hook <event>
spatz stats [--type <t>] [--json]
```

Related docs: [hooks.md](hooks.md) for the Claude Code integration, [configuration.md](configuration.md) for environment variables and files.

## spatz --version

Prints the CLI version and exits with code 0 without opening the database.
Release builds use the version set at build time. Development runs use `packages/cli/package.json`.
The output is plain text, even with `--json`.

## spatz "\<task\>"

This command recommends a pair of model and effort for one task. spatz classifies the task, ranks the candidates from `--models`, and stores the suggestion. spatz does not store the task text.

### Flags

| Flag | Type | Default | Effect |
| --- | --- | --- | --- |
| `"<task>"` | string, first positional argument | required | The task text. Put it in quotes. spatz reads only the first positional argument and ignores the others. |
| `--models <list>` | string | required | The candidates you can use. See [The --models grammar](#the---models-grammar). |
| `--json` | boolean | `false` | Print one JSON object instead of text. |
| `--dry-run` | boolean | `false` | Mark the suggestion as a test (`is_test: true`). A test suggestion never counts for learning or for `spatz stats`. |

### The --models grammar

```text
<list>   = <entry>[,<entry>...]
<entry>  = <id>[:<effort>[+<effort>...]]
<effort> = low | medium | high | xhigh | max
```

- If an entry has no efforts, spatz uses `low`, `medium` and `high`. If OpenRouter lists the efforts of the model, spatz keeps only the listed ones. spatz uses `xhigh` and `max` only if you name them.
- spatz removes duplicate pairs.
- An unknown effort stops the command with exit code 1.

spatz converts each id to the canonical OpenRouter id:

| Given id | Rule | Example |
| --- | --- | --- |
| Key in `~/.spatz/aliases.json` | The alias value wins over all other rules. | `{"my-model": "vendor/model-x"}` |
| Contains `/` | Used as given. | `openai/gpt-6-sol` |
| `claude-*` | Prefix `anthropic/`. The last dash between two digits becomes a dot. | `claude-opus-5-5` becomes `anthropic/claude-opus-5.5` |
| `gpt-*` | Prefix `openai/`. | `gpt-6-sol` becomes `openai/gpt-6-sol` |
| Any other id | Used as given. | `my-model` |

spatz sorts the candidates by cost: output price, then input price, then effort, then id. A model that OpenRouter does not list counts as the most expensive.

### Text output

```text
suggestion_id: <uuid>
1. <model>:<effort>  estimate=<0.00>  n=<count>
reason: <sentence>
task_type: <type>  difficulty: <level>  criticality: <level>
explored: <bool>  control: <bool>  fallback_used: <bool>[  (dry-run)]
```

The first line is always `suggestion_id: <uuid>`. The Claude Code hook reads this line to link the session to the suggestion. The ranking has one to three lines.

### JSON output

| Field | Type | Meaning |
| --- | --- | --- |
| `suggestion_id` | string (UUID) | Id for `spatz report`. |
| `ranking` | array, 1 to 3 entries | `ranking[0]` is the recommendation. The next entries are the next more expensive candidates. |
| `ranking[].model` | string | Canonical OpenRouter id. |
| `ranking[].effort` | string | `low`, `medium`, `high`, `xhigh` or `max`. |
| `ranking[].n` | number | Count of outcomes for this pair on the level that made the decision. That level is the cell (one pair of `task_type` and `difficulty`). If a learned choice used pooled data, it is the pooled level (same task type, same and harder difficulties). See [recommendation.md](recommendation.md). |
| `ranking[].estimate` | number | Estimated success rate on the same level as `n`: `(1 + sum of quality) / (2 + n)`. With no data it is `0.5`. |
| `reason` | string | One sentence that explains the choice. |
| `classification.task_type` | string | `code.bugfix`, `code.feature`, `code.refactor`, `code.explain`, `review`, `spec`, `planning` or `other`. |
| `classification.difficulty` | string | `leicht` (easy), `mittel` (medium) or `schwer` (hard). |
| `classification.criticality` | string | `none`, `business_logic`, `security` or `data_integrity`. |
| `fallback_used` | boolean | `true` when keyword rules classified the task instead of Jev. |
| `explored` | boolean | `true` when spatz picked a cheaper pair to collect data (exploration). |
| `control` | boolean | `true` when the suggestion is in the control group. The control group always gets the most expensive pair. |
| `strategy` | string | `learned`, `jev-choice`, `rules` or `strongest`. See [recommendation.md](recommendation.md). |
| `is_test` | boolean | `true` with `--dry-run`. |

### Example

```console
$ spatz "Fix the off-by-one error in the pagination helper in src/list.ts" --models claude-opus-5-5:high+medium,claude-sonnet-5-5:medium+low
suggestion_id: 5361b5cd-76f0-45c2-89f7-2609f2b83186
1. anthropic/claude-opus-5.5:high  estimate=0.50  n=0
reason: Without Jev and learned data the most expensive pair anthropic/claude-opus-5.5 (high) is recommended.
task_type: other  difficulty: mittel  criticality: none
explored: false  control: false  fallback_used: true
```

```console
$ spatz "Fix the off-by-one error in src/list.ts" --models claude-sonnet-5-5,gpt-6-sol --json
{"suggestion_id":"aabe5a7a-3e89-4285-a1d1-7e323f243f75","ranking":[{"model":"anthropic/claude-sonnet-5.5","effort":"low","n":0,"estimate":0.5},{"model":"openai/gpt-6-sol","effort":"low","n":0,"estimate":0.5},{"model":"anthropic/claude-sonnet-5.5","effort":"medium","n":0,"estimate":0.5}],"reason":"Exploration: anthropic/claude-sonnet-5.5 (low) is cheaper than the normal pick and has the fewest outcomes in this cell.","classification":{"task_type":"other","difficulty":"mittel","criticality":"none"},"fallback_used":true,"explored":true,"control":false,"strategy":"rules","is_test":false}
```

Both examples ran with `SPATZ_NO_JEV=1` and an empty database. That is why `fallback_used` is `true` and `n` is `0`.

## spatz report

This command records the pair you used and the result of the task. A report wins over all hook signals for this suggestion. The report also closes the suggestion, so later hook events do not go to it.

### Flags

| Flag | Type | Default | Effect |
| --- | --- | --- | --- |
| `<suggestion_id>` | string, positional | required | The id from `spatz "<task>"`. An unknown id gives exit code 1. |
| `--model <m>` | string | required | The model you used. spatz converts it with the same id rules as `--models`. |
| `--effort <e>` | string | required | `low`, `medium`, `high`, `xhigh` or `max`. Another value gives exit code 1. |
| `--result <r>` | `pass`, `partial` or `fail` | required | The result. spatz stores it as quality 1, 0.5 or 0. |
| `--rounds <n>` | non-negative integer | none | Count of rounds the agent needed. |
| `--note <t>` | string | none | A short note. spatz stores it in the database. |
| `--json` | boolean | `false` | Print one JSON object instead of text. |

If you send a second report for the same suggestion, the newest report counts.

### Text output

```text
reported: <suggestion_id>  quality: <0..1>  pair: <model>:<effort>
```

### JSON output

| Field | Type | Meaning |
| --- | --- | --- |
| `suggestion_id` | string | The reported suggestion. |
| `quality` | number | `1`, `0.5` or `0` from `--result`. |
| `model` | string | Canonical id of the used model. |
| `effort` | string | The used effort. |

### Example

```console
$ spatz report 3b257996-110b-48c4-b61d-79761ad7400b --model claude-sonnet-5-5 --effort medium --result pass --rounds 2 --note "one retry"
reported: 3b257996-110b-48c4-b61d-79761ad7400b  quality: 1  pair: anthropic/claude-sonnet-5.5:medium
```

```console
$ spatz report 3b257996-110b-48c4-b61d-79761ad7400b --model claude-sonnet-5-5 --effort medium --result pass --json
{"suggestion_id":"3b257996-110b-48c4-b61d-79761ad7400b","quality":1,"model":"anthropic/claude-sonnet-5.5","effort":"medium"}
```

## spatz hook

This command is the entry point for Claude Code hooks. It reads the hook JSON from stdin and records signals and token usage. See [hooks.md](hooks.md).

| Argument | Type | Default | Effect |
| --- | --- | --- | --- |
| `<event>` | string, positional | none | The hook event name. spatz takes the event from `hook_event_name` in the stdin JSON. The argument only makes the settings file easier to read. |

The command prints nothing and always exits with code 0. It ignores invalid JSON and all errors. A hook can never block a Claude Code session.

### Example

```console
$ echo '{"hook_event_name":"Stop"}' | spatz hook Stop
$ echo $?
0
```

## spatz stats

This command shows how well each pair worked, per task type. It reads the database with DuckDB in read-only mode. Test suggestions (`--dry-run`) are not counted.

### Flags

| Flag | Type | Default | Effect |
| --- | --- | --- | --- |
| `--type <t>` | task type | all types | Show only this task type. Allowed: `code.bugfix`, `code.feature`, `code.refactor`, `code.explain`, `review`, `spec`, `planning`, `other`. Another value gives exit code 2. |
| `--json` | boolean | `false` | Print one JSON object instead of text. |

The first run needs network access once. See [configuration.md](configuration.md#duckdb-sqlite-extension). The command fails with exit code 1 when the database does not exist yet. The database exists after the first `spatz "<task>"`.

### Text output

```text
<task_type>  n=<count>  adoption=<pct>  input_tokens=<count>  output_tokens=<count>
  <model>:<effort>  n=<count>  success=<pct>
coverage: <pct>  learned_success: <pct or ->  control_success: <pct or ->
```

There is one block per task type, with one indented line per used pair. `-` means "no data".

### JSON output

| Field | Type | Meaning |
| --- | --- | --- |
| `by_type` | array | One entry per task type that has suggestions. |
| `by_type[].task_type` | string | The task type. |
| `by_type[].n` | number | Count of outcomes. An outcome exists when a suggestion has at least one signal. |
| `by_type[].pairs` | array | One entry per used pair. |
| `by_type[].pairs[].model` | string | Canonical model id. |
| `by_type[].pairs[].effort` | string or null | `null` when no hook input gave an effort. |
| `by_type[].pairs[].n` | number | Count of outcomes with this pair. |
| `by_type[].pairs[].success_rate` | number, 0 to 1 | Share of outcomes with quality of 0.8 or more. |
| `by_type[].adoption_rate` | number, 0 to 1 | Share of outcomes whose used pair is `ranking[0]`. |
| `by_type[].input_tokens` | number | Sum of input tokens from the hooks. |
| `by_type[].output_tokens` | number | Sum of output tokens from the hooks. |
| `coverage` | number, 0 to 1 | Share of suggestions that have an outcome. All task types count, also with `--type`. |
| `learned_success` | number or null | Success rate of learned picks. spatz compares only cells that have both learned and control outcomes, and weights each cell by its count. |
| `control_success` | number or null | Success rate of the control group in the same cells. |

### Example

```console
$ spatz stats
other  n=1  adoption=100%  input_tokens=0  output_tokens=0
  anthropic/claude-sonnet-5.5:medium  n=1  success=100%
coverage: 14%  learned_success: -  control_success: -
```

```console
$ spatz stats --json
{"by_type":[{"task_type":"other","n":1,"pairs":[{"model":"anthropic/claude-sonnet-5.5","effort":"medium","n":1,"success_rate":1}],"adoption_rate":1,"input_tokens":0,"output_tokens":0}],"coverage":0.14285714285714285,"learned_success":null,"control_success":null}
```

## Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| 0 | Success. `spatz hook` always returns 0. | |
| 1 | Runtime error. spatz prints `spatz: <message>` to stderr. | Unknown effort in `--models`. No usable candidate in `--models`. Invalid `--effort` in `report`. Unknown `suggestion_id`. Database missing for `stats`. DuckDB extension download failed. |
| 2 | Usage error. spatz prints the message and the usage text to stderr. | Missing task, `--models`, `<suggestion_id>`, `--model`, `--effort` or `--result`. `--result` not `pass`, `partial` or `fail`. `--rounds` not a non-negative integer. Invalid `--type`. Unknown flag. |

An invalid effort gives code 1 in `--models` and in `report --effort`, because the core checks it. An invalid `--result` gives code 2, because the CLI checks it.
