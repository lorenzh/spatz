---
title: spatz CLI reference
description: Every spatz command with its flags, defaults, the --models grammar, text and JSON output fields, exit codes and examples.
tags: [cli, reference, spatz]
keywords: [attempt, retry, correct, binding, chain, dispatch, dispatches, requested_model, swapped, import-rollout, rollout, codex exec, SPATZ_SUGGESTION_ID, cost, tokens, cost_usd, tokens_complete, tokens_schema, fallback, failures, launcher, diagnostics, link, command line, commands, flags, options, models, effort, json output, exit code, suggest, report, stats, hook, usage, scope, session, turn, agent, version]
---

# spatz CLI reference

Each spatz command calls the `@spatz/core` API and formats the result. The CLI has no other logic.

```text
spatz --version
spatz "<task>" [--models <list>] [--family <claude|gpt>] [--json] [--dry-run] [--scope <scope>] [--session <id>] [--turn <id>] [--agent-id <id>] [--source <agent>] [--requested <model|->] [--requested-agent <type>] [--retry-of <suggestion_id>]
spatz report <suggestion_id> --model <m> --effort <e> --result pass|partial|fail [--attempt <id>] [--correct] [--rounds <n>] [--note <t>] [--turn <id> --source claude-code-mod] [--json]
spatz usage <suggestion_id> --model <m> [--effort <e>] --input <n> --output <n> --cache-read <n> --cache-creation <n> --turn <id> --source claude-code-mod [--json]
spatz link <suggestion_id> --agent-id <id> --session <id> [--json]
spatz import-rollout <file> --suggestion <id> [--json]
spatz hook <event> [--agent codex]
spatz stats [--type <t>] [--by scope] [--json]
```

Related docs: [hooks.md](hooks.md) for Claude Code and Codex integrations, [configuration.md](configuration.md) for environment variables and files.

## spatz --version

Prints the CLI version and exits with code 0 without opening the database.
Release builds use the version set at build time. Development runs use `packages/cli/package.json`.
The output is plain text, even with `--json`.

## spatz "\<task\>"

This command recommends a pair of model and effort for one task. spatz classifies the task, ranks the resolved candidates, and stores the suggestion. spatz does not store the task text.

### Flags

| Flag | Type | Default | Effect |
| --- | --- | --- | --- |
| `"<task>"` | string, first positional argument | required | The task text. Put it in quotes. spatz reads only the first positional argument and ignores the others. |
| `--models <list>` | string | config or harness preset | The candidates you can use. See [The --models grammar](#the---models-grammar). |
| `--family <family>` | string | no filter | Keep `claude`/`anthropic` or `gpt`/`openai` candidates. Applied after resolution, including explicit `--models`. An empty result exits 2. |
| `--json` | boolean | `false` | Print one JSON object instead of text. |
| `--dry-run` | boolean | `false` | Mark the suggestion as a test (`is_test: true`). A test suggestion never counts for learning or for `spatz stats`. |
| `--retry-of <suggestion_id>` | string | none | Join the named suggestion's recovery chain. |
| `--scope <scope>` | string | `null` | Store `step`, `turn`, `subagent`, `session` or `escalate`. This labels the routing decision. |
| `--session <id>` | string | `null` | Link the suggestion at creation. This does not need a Bash hook. With `--source claude-code-mod`, you must also give `--turn` or `--agent-id`. Otherwise the call fails. |
| `--turn <id>` | string | `null` | Store the initial turn id. |
| `--agent-id <id>` | string | `null` | Store the subagent id. Without it, the suggestion uses the main window. |
| `--source <agent>` | string | `null` | Store provenance in `suggestions.agent`: `claude-code`, `claude-code-mod` or `codex`. |
| `--requested <model\|->` | string | `null` | Store the original model before mod routing. `-` means no explicit model. Known Claude aliases and model ids are normalized. |
| `--requested-agent <type>` | string | — | Read the named Claude agent's frontmatter `model:` when `--requested` is absent, `-` or `inherit`. |

These fields stay in SQLite. The suggestion JSON keeps its existing fields.
The CLI stores the scope label. The caller chooses the decision points.

```sh
spatz "Review the parser" --models claude-sonnet-5-5:high \
  --scope subagent --session session-1 --turn turn-1 \
  --agent-id agent-1 --source claude-code-mod --json
```

`spatz suggest "<task>"` is the explicit form of the same command.
Each suggestion opens an implicit attempt with an unknown actual pair.
Execution evidence or a report supplies the actual pair.
Use `--retry-of <suggestion_id>` to join the earlier suggestion's recovery chain.
Without this flag, the suggestion starts a new chain.
A separately routed review keeps its own chain.

### Candidate resolution

spatz uses the first available source:

1. `--models`
2. `SPATZ_MODELS`
3. `models` in `<cwd>/.spatz.json`
4. `models` in `~/.spatz/config.json`
5. A preset for the detected harness

All sources use the grammar below. An empty or blank value counts as unset, so the next source applies. An invalid selected value fails instead of falling through, and the error names its source (for example `SPATZ_MODELS:`).
Without a source, spatz exits 2 and names the flag and configuration options.
JSON reports the selected source as `models_source`. A family filter does not change that source.

Claude Code gets Opus 5.5 and Sonnet 5.5. Codex gets GPT-6 Astra and GPT-6 Luna.
Both presets use `low+medium+high`. See [harness detection](configuration.md#harness-detection) for markers and nesting rules.
`--family` filters the resolved candidates. It does not add models from another preset.
For cross-family reviews, configure all models you can dispatch before filtering.

```sh
spatz "Review the parser" --family gpt --json
```

### The --models grammar

```text
<list>   = <entry>[,<entry>...]
<entry>  = <id>[:<effort>[+<effort>...]]
<effort> = none | low | medium | high | xhigh | max | ultra
```

- If an entry has no efforts, spatz uses `low`, `medium` and `high`. If OpenRouter lists the efforts of the model, spatz keeps only the listed ones. spatz uses `none`, `xhigh`, `max` and `ultra` only if you name them.
- spatz removes duplicate pairs.
- An unknown effort stops the command with exit code 1. For catalog models, `none` is rejected when the model lists real efforts; unknown models still accept it.
- `none` means the harness offers no effort setting. It sorts below `low`; `ultra` sorts above `max`, after price.
- For Codex dispatch, pass `ultra` as `-c model_reasoning_effort=ultra`. Claude Code has no `ultra`.

spatz converts each id to the canonical OpenRouter id:

| Given id | Rule | Example |
| --- | --- | --- |
| Key in `~/.spatz/aliases.json` | The alias value wins over all other rules. | `{"my-model": "vendor/model-x"}` |
| Contains `/` | Used as given. | `openai/gpt-6-sol` |
| `claude-*` | Prefix `anthropic/`. The last dash between two digits becomes a dot. | `claude-opus-5-5` becomes `anthropic/claude-opus-5.5` |
| `gpt-*` | Prefix `openai/`. | `gpt-6-sol` becomes `openai/gpt-6-sol` |
| Any other id | Used as given. | `my-model` |

An 8-digit date snapshot suffix (for example, `-20251001`) is stripped from Claude IDs for pricing and learning and added when spatz matches a picker ID. The Claude picker ID `claude-haiku-4-5-20251001` maps to `anthropic/claude-haiku-4.5`. User aliases take precedence.

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
| `models_source` | string | `flag`, `env`, `project`, `user`, `preset:claude-code` or `preset:codex`. |
| `ranking` | array, 1 to 3 entries | `ranking[0]` is the recommendation. The next entries are the next more expensive candidates. |
| `ranking[].model` | string | Canonical OpenRouter id. |
| `ranking[].effort` | string | `none`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. |
| `ranking[].n` | number | Count of outcomes for this pair on the level that made the decision. That level is the cell (one pair of `task_type` and `difficulty`). If a learned choice used pooled data, it is the pooled level (same task type, same and harder difficulties). See [recommendation.md](recommendation.md). |
| `ranking[].estimate` | number | Estimated success rate on the same level as `n`: `(1 + sum of quality) / (2 + n)`. With no data it is `0.5`. |
| `reason` | string | One sentence that explains the choice. |
| `classification.task_type` | string | `code.bugfix`, `code.feature`, `code.refactor`, `code.explain`, `review`, `spec`, `planning` or `other`. |
| `classification.difficulty` | string | `easy`, `medium` or `hard`. |
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
task_type: other  difficulty: medium  criticality: none
explored: false  control: false  fallback_used: true
```

```console
$ spatz "Fix the off-by-one error in src/list.ts" --models claude-sonnet-5-5,gpt-6-sol --json
{"suggestion_id":"aabe5a7a-3e89-4285-a1d1-7e323f243f75","models_source":"flag","ranking":[{"model":"anthropic/claude-sonnet-5.5","effort":"low","n":0,"estimate":0.5},{"model":"openai/gpt-6-sol","effort":"low","n":0,"estimate":0.5},{"model":"anthropic/claude-sonnet-5.5","effort":"medium","n":0,"estimate":0.5}],"reason":"Exploration: anthropic/claude-sonnet-5.5 (low) is cheaper than the normal pick and has the fewest outcomes in this cell.","classification":{"task_type":"other","difficulty":"medium","criticality":"none"},"fallback_used":true,"explored":true,"control":false,"strategy":"rules","is_test":false}
```

Both examples ran with `SPATZ_NO_JEV=1` and an empty database. That is why `fallback_used` is `true` and `n` is `0`.

## spatz report

This command records the actual pair and result for one attempt.
A report wins over that attempt's hook signals.
It closes the attempt and suggestion window. Late evidence can still bind by source identity.

### Flags

| Flag | Type | Default | Effect |
| --- | --- | --- | --- |
| `<suggestion_id>` | string, positional | required | The id from `spatz "<task>"`. An unknown id gives exit code 1. |
| `--model <m>` | string | required | The model you used. spatz converts it with the same id rules as `--models`. |
| `--effort <e>` | string | required | `none`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. Another value gives exit code 1. `none` is rejected for catalog models with real efforts; unknown models still accept it. |
| `--result <r>` | `pass`, `partial` or `fail` | required | The result. spatz stores it as quality 1, 0.5 or 0. |
| `--attempt <id>` | string | automatic selection | Select an attempt belonging to this suggestion. Its known pair must match. |
| `--correct` | boolean | `false` | Replace a prior report on the selected attempt. Keep its pair and usage unchanged. |
| `--confirm` | boolean | `false` | Report on an existing `--attempt` without creating a retry. Reject a changed prior report. Cannot combine with `--correct`. |
| `--rounds <n>` | non-negative integer | none | Count of rounds the agent needed. |
| `--note <t>` | string | none | A short note. spatz stores it in the database. |
| `--json` | boolean | `false` | Print one JSON object instead of text. |
| `--turn <id>` | string | none | Identify a direct report's turn. Needs `--source claude-code-mod`. |
| `--source claude-code-mod` | string | none | Identify a direct mod report. Needs `--turn`. |

Without `--attempt`, the report selects the highest compatible ordinal.
An unused implicit attempt also qualifies. If no attempt matches, spatz creates one.
An identical report returns the same attempt without adding an outcome or usage.
A changed verdict on an already reported attempt creates a retry.
Use `--correct` to fix a mistaken verdict instead. It requires a prior report.
Use `--attempt <id> --confirm` to report on an existing attempt without creating a retry.
A changed prior report still needs `--correct`.
Reports can fill unknown pair fields but cannot overwrite known execution metadata.
The report event stores `--rounds`, `--note` and the direct report’s `--turn`.
Corrections store the supplied metadata in a new event revision.
An identical same-pair retry needs an observed new start to distinguish it from replay.

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
| `attempt_id` | string or null | UUID of the attempt selected by this report. Null for legacy outcomes. |
| `ordinal` | number or null | Attempt number within this suggestion. Null for legacy outcomes. |
| `root_id` | string or null | First attempt of the recovery chain. Null for legacy outcomes. |
| `input_tokens`, `output_tokens` | number or null | Recorded uncached input and output tokens for this attempt. |
| `cache_read_tokens`, `cache_creation_tokens` | number or null | Recorded cache tokens for this attempt. |

### Example

```console
$ spatz report 3b257996-110b-48c4-b61d-79761ad7400b --model claude-sonnet-5-5 --effort medium --result pass --rounds 2 --note "one retry"
reported: 3b257996-110b-48c4-b61d-79761ad7400b  quality: 1  pair: anthropic/claude-sonnet-5.5:medium
```

```console
$ spatz report 3b257996-110b-48c4-b61d-79761ad7400b --model claude-sonnet-5-5 --effort medium --result pass --json
{"suggestion_id":"3b257996-110b-48c4-b61d-79761ad7400b","quality":1,"model":"anthropic/claude-sonnet-5.5","effort":"medium","attempt_id":"<attempt-uuid>","ordinal":1,"root_id":"<attempt-uuid>","input_tokens":null,"output_tokens":null,"cache_read_tokens":null,"cache_creation_tokens":null}
```

To correct that verdict, repeat the report with `--attempt <attempt-uuid> --correct`.
To route more work in the same recovery chain, use `spatz suggest "Retry the task" --retry-of <suggestion_id>`.

## spatz attempt

The mod uses these commands to register execution identity. The routing skill does not need them.

```sh
spatz attempt start <suggestion_id> --key <turnId:index> --model <m> \
  [--effort <e>] --session <id> [--agent-id <id>] [--turn <id>] [--owns-usage] [--json]
spatz attempt bind <attempt_id> --call <tool_use_id> --session <id> [--agent-id <id>]
spatz attempt finalize --session <id> [--agent-id <id>]
```

`start` registers a segment before execution. A repeated start key returns the same attempt.
Unknown effort stays null. `--owns-usage` marks mod usage ownership for this context.
`bind` connects a hook/mod tool-call ID to the active attempt.
`finalize` closes observed execution without inventing a successful verdict.
The main session omits `--agent-id`. Each subagent supplies its own ID.

## spatz usage

This command stores direct token usage without reading a transcript.
It does not create a success signal or close the suggestion.

| Flag | Default | Effect |
| --- | --- | --- |
| `<suggestion_id>` | required | The existing suggestion id. |
| `--model <m>` | required | The model used. spatz applies its model-id rules. |
| `--attempt <id>` | absent | Bind the measurement to this attempt. |
| `--key <turnId:index>` | absent | Stable identity of a disjoint mod step measurement. |
| `--session <id>` | absent | Session context for explicit attempt measurements. |
| `--agent-id <id>` | absent | Subagent context for explicit attempt measurements. |
| `--effort <e>` | `null` | `none`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. `none` is rejected for catalog models with real efforts; unknown models still accept it. Missing or supplied efforts are stored as `none` for catalog models whose only effort is `none`. |
| `--input <n>` | required | Uncached input tokens. |
| `--output <n>` | required | Output tokens. |
| `--cache-read <n>` | required | Input tokens read from cache. |
| `--cache-creation <n>` | required | Input tokens written to cache. |
| `--turn <id>` | required | The run's turn id. Also stored as `scope_key`. |
| `--source claude-code-mod` | required | The direct usage source. |
| `--cost-usd <n>` | absent | Optional harness-reported USD cost. Must be a finite non-negative decimal. The CLI accepts scientific notation. It rejects empty values, whitespace and hexadecimal values. |
| `--json` | `false` | Print the stored usage record. |

All token counts must be non-negative safe integers.
Step measurements use `--attempt`, `--key` and `--session` with the actual sent effort.
Replaying the same measurement does not add its tokens twice.
Each step keeps separate counts even when its pair matches another step.
The command also accepts direct turn measurements without step identity.
For a linked subagent, mod usage replaces hook estimates by session and agent id.
Later hook replays cannot add those estimates again.

```sh
spatz usage <suggestion_id> --model claude-sonnet-5-5 --effort high \
  --input 10 --output 20 --cache-read 60 --cache-creation 30 \
  --turn turn-1 --source claude-code-mod --json
```

Text output is `usage recorded: <suggestion_id>  turn: <turn_id>`.
JSON contains `suggestion_id`, `model`, `effort`, `source`, `scope_key`, `turn_id` and `agent_id`.
It also contains the four token counts with snake_case names.
`input_tokens` means uncached input. `output_tokens` includes reasoning tokens once.
JSON also includes `cost_usd`, `cost_source`, `tokens_complete` and `tokens_schema`.
`cost_source` is `reported`, `priced` or `unavailable`. Unavailable cost is `null`.
If all four counters are known, `tokens_complete` is `1`. Otherwise it is `0`.
New rows use `tokens_schema = 2`. See [cost storage](how-it-works.md#normalized-tokens-and-cost).
The remaining fields are `is_sidechain`, `rounds`, `note` and `reported_at`.
`rounds` and `note` are `null`. `reported_at` is epoch milliseconds.
If the suggestion has an agent id, `is_sidechain` is true.

If completion has no usage, do not submit invented zero counts.
The mod records disjoint step measurements with their actual pairs.
It does not submit a mixed turn total against the last response model.

## spatz link

A subagent has no id when its suggestion is made. `spatz link` adds the agent id and the session afterwards.
Until then, the suggestion has no session and sits in no session window, so it cannot close the window of the main session.

| Flag | Default | Effect |
| --- | --- | --- |
| `<suggestion_id>` | required | The existing suggestion id. |
| `--agent-id <id>` | required | The real agent id. |
| `--session <id>` | required | The session of the agent. |
| `--json` | `false` | Print `suggestion_id` and `agent_id`. |

The command is idempotent. A second call with the same agent id changes nothing.
A call with another agent or session id fails with exit code 1.
For mod suggestions, linking also merges the original requested model into `dispatches`.
After the link, the suggestion joins the window sequence of that agent.

```sh
spatz link <suggestion_id> --agent-id agent-1 --session session-1
```

Text output is `linked: <suggestion_id>  agent: <agent_id>`.

## spatz import-rollout

If spatz hooks were absent or untrusted, import the Codex run here.

```sh
spatz import-rollout <file> --suggestion <id> [--json]
```

`<file>` is the run's rollout JSONL file. `--suggestion` names an existing suggestion.
The command imports every recognized turn. It supports legacy tool calls and newer `CommandExecution` events.
It records the actual model, effort, normalized tokens, and test/build results.
It uses the suggestion's stored prices for cost, as the hooks do.
It stores no raw prompts, commands, or tool output.

The import binds each run to attempts within the named suggestion.
It works after the suggestion closes and leaves the parent session link unchanged.
Repeated imports replace the same records without adding tokens twice. This also applies after hooks ran.
A turn without usage leaves stored usage unchanged. Use the latest complete rollout.
The file must contain only turns that belong to the named suggestion.
For a resumed session with unrelated work, import a JSONL file containing only this run's turns.

Text output:

```text
rollout imported: <id>  turns: 1
```

With `--json`, the output is `{"suggestion_id":"<id>","turns":1}`.
`turns` counts all recognized turns. A turn can have no usage or test/build results.
Missing arguments exit with code 2. An unknown suggestion, unreadable file, or file without recognized turns exits with code 1.
spatz skips malformed lines and unsupported records.
Use [the environment link](hooks.md#link-a-dispatched-codex-run) for automatic recording.
Run `spatz report` separately to record your verified verdict.

## spatz hook

This command is the entry point for Claude Code and Codex hooks. It reads the hook JSON from stdin and records signals and token usage.
With `--agent codex`, spatz reads completed command events from the rollout at turn end.
For older rollouts, it matches calls to outputs by call id. See [hooks.md](hooks.md).

| Argument | Type | Default | Effect |
| --- | --- | --- | --- |
| `<event>` | string, positional | none | The hook event name. spatz takes the event from `hook_event_name` in the stdin JSON. The argument only makes the settings file easier to read. |

The command prints nothing by default and always exits with code 0. It ignores invalid JSON and all errors.
With `SPATZ_DEBUG=1`, hooks write fixed diagnostics to stderr. They contain no prompt text or tool output.

### Example

```console
$ echo '{"hook_event_name":"Stop"}' | spatz hook Stop
$ echo $?
0
```

For Codex, pass `--agent codex`, for example `spatz hook Stop --agent codex`.

## spatz stats

This command shows how well each pair worked, per task type. It reads the database with DuckDB in read-only mode. Test suggestions (`--dry-run`) are not counted.

### Flags

| Flag | Type | Default | Effect |
| --- | --- | --- | --- |
| `--type <t>` | task type | all types | Show only this task type. Allowed: `code.bugfix`, `code.feature`, `code.refactor`, `code.explain`, `review`, `spec`, `planning`, `other`. Another value gives exit code 2. |
| `--json` | boolean | `false` | Print one JSON object instead of text. |

`--by scope` adds `by_scope` to the JSON response. Text output shows one line per recorded scope.
Suggestions without a scope appear as `unscoped` in text and `scope: null` in JSON.
`--type` also filters this view. Test suggestions stay excluded.
For none-only catalog models, stats count old rows with a missing effort as `none`.

| `by_scope` field | Meaning |
| --- | --- |
| `scope` | The stored routing scope, or `null`. |
| `n` | Completed recovery chains counted once under the root scope, plus legacy outcomes. |
| `success_rate` | Share of completed chains that succeeded, plus legacy results. Without results, JSON gives `null` and text gives `-`. |
| `input_tokens`, `output_tokens` | Total recorded input and output tokens. |
| `cache_read_tokens`, `cache_creation_tokens` | Total recorded cache tokens. |
| `cost_usd` | Sum of USD costs from schema-2 usage rows, or `null`. |
| `cache_read_share` | `cache_read_tokens / (input_tokens + cache_read_tokens + cache_creation_tokens)`. With no input tokens, the share is zero. |

Token totals include suggestions without outcomes. Each measurement counts once before outcome joins.
Output tokens do not enter the cache-read share.
Scope totals use the root suggestion's scope for each recovery chain.
Coverage counts distinct scored suggestions over distinct non-test suggestions.
Adoption and learned/control comparisons use first-attempt quality once per root.
Pair statistics count each scored attempt. A same-pair reported fail/pass contributes two outcomes.
Legacy statistics keep their pre-migration meaning.
Both task-type and scope stats include all four token totals and `cost_usd`.
The sum includes reported costs and costs calculated from stored prices.
Schema-1 rows never enter USD totals. If no row has a schema-2 cost, the total is `null` (`-` in text).
Missing counters contribute zero to the calculation, so incomplete rows can understate cost.
Token totals still include historical rows and treat null counters as zero.
Historical Codex input totals can include cached tokens. These totals are not normalized retroactively.
Stats do not measure routing latency.

```sh
spatz stats --by scope
spatz stats --by scope --type review --json
```

The first run needs network access once. See [configuration.md](configuration.md#duckdb-sqlite-extension). spatz creates an empty database if none exists. Launcher failures remain visible before the first successful suggestion.

### Text output

```text
<task_type>  n=<count>  adoption=<pct>  input_tokens=<count>  output_tokens=<count>  cache_read_tokens=<count>  cache_creation_tokens=<count>  cost_usd=<amount or ->
  <model>:<effort>  n=<count>  success=<pct>
coverage: <pct>  learned_success: <pct or ->  control_success: <pct or ->
dispatches: <count>  routed_by_mod: <count>  swapped: <count>
fallbacks: <reason>=<count>  ...
failures: parse=<count>  hook=<count>  launcher=<count>
```

There is one block per task type, with one indented line per used pair. `-` means "no data".
The dispatch, fallback and failure lines also appear with `--by scope`.

### Dispatch counts

The global counts appear in text and JSON, including `--by scope`.
Neither `--type` nor `--by scope` filters them.

| Field | Meaning |
| --- | --- |
| `dispatches` | Observed session/agent pairs, including dispatches without a suggestion. |
| `routed_by_mod` | Dispatches linked to a mod suggestion. This includes `show` mode and does not prove that a rewrite occurred. |
| `swapped` | Dispatches whose known requested and answering model ids differ. |

A linked dry-run suggestion excludes its dispatch from all three counts.
Hook and mod observations of one spawn count once.
Unknown requested or answering models do not count as swaps.
A named agent supplies its requested model through the definition's frontmatter `model:`.
Core checks the project's `.claude/agents` before `$CLAUDE_CONFIG_DIR/agents` (default `~/.claude/agents`).
Missing or unreadable definitions leave the model unknown. See [definition lookup](hooks.md#dispatch-observations) for the limits.
Aliases select the newest matching cached harness model, with the bundled catalog as fallback.
With a requested Opus model and a Sonnet answer, `swapped` increases by one.
A preserved Opus request and answer adds no swap.

The counts start with observations recorded by schema v7. Historical dispatches are not inferred.
See [hook storage](hooks.md#dispatch-observations) and [mod tracking](claude-mod.md#dispatch-tracking).

### Fallbacks and failures

`fallbacks` counts non-test suggestions by their stored `fallback_reason`.
Reasons are `opt_out`, `secret`, `no_key`, `timeout`, `auth`, `rate_limit` and `error`.
Legacy fallback rows without a stored reason count as `unknown`.
Without fallbacks, JSON gives `{}` and text gives `fallbacks: -`.

| Counter | Meaning |
| --- | --- |
| `failures.parse` | Transcript reads or parsing failed, or no usable messages matched the requested turn or subagent. |
| `failures.hook` | Hook input was invalid, a required turn id was missing, or recording threw an error. |
| `failures.launcher` | A plugin launcher could not run a hook command successfully. |

Parse and hook failures count once per kind, event, session and turn.
Subagent parsing uses the agent id as its turn key.
Without a session or turn id, each failure counts separately.
A later successful replay does not erase an earlier failure.
If the turn still yields usable data, malformed transcript lines do not count separately.
Failures do not need a linked suggestion. They also include hooks for dry-run suggestions.

Fallback and failure counts are global. Neither `--type` nor `--by scope` filters them.
Counters start with the first failure recorded by this version. They need no `SPATZ_DEBUG` setting.
See [how-it-works.md](how-it-works.md#failure-recording) for storage and [configuration.md](configuration.md#launcher-failures) for the launcher file.


### JSON output

| Field | Type | Meaning |
| --- | --- | --- |
| `by_type` | array | One entry per task type that has suggestions. |
| `by_type[].task_type` | string | The task type. |
| `by_type[].n` | number | Count of scored attempts plus legacy outcomes. |
| `by_type[].pairs` | array | One entry per used pair. |
| `by_type[].pairs[].model` | string | Canonical model id. |
| `by_type[].pairs[].effort` | string or null | `null` when no hook input gave an effort. |
| `by_type[].pairs[].n` | number | Count of outcomes with this pair. |
| `by_type[].pairs[].success_rate` | number, 0 to 1 | Share of outcomes with quality of 0.8 or more. |
| `by_type[].adoption_rate` | number, 0 to 1 | Share of root decisions whose first actual pair is `ranking[0]`. |
| `by_type[].input_tokens` | number | Sum of recorded input tokens. |
| `by_type[].output_tokens` | number | Sum of recorded output tokens. |
| `by_type[].cache_read_tokens` | number | Sum of input tokens read from cache. |
| `by_type[].cache_creation_tokens` | number | Sum of input tokens written to cache. |
| `by_type[].cost_usd` | number or null | Sum of USD costs from schema-2 usage rows. Null if none have a cost. |
| `coverage` | number, 0 to 1 | Share of suggestions that have an outcome. All task types count, also with `--type`. |
| `learned_success` | number or null | First-attempt success rate of learned root decisions in cells with both learned and control outcomes, weighted by their counts. |
| `control_success` | number or null | Success rate of the control group in the same cells. |
| `dispatches`, `routed_by_mod`, `swapped` | number | Global dispatch counts. Each defaults to zero. See [dispatch counts](#dispatch-counts). |
| `fallbacks` | object | Global non-test suggestion counts keyed by fallback reason. |
| `failures` | object | Global `parse`, `hook` and `launcher` counts. Each defaults to zero. |

### Example

```console
$ spatz stats
other  n=1  adoption=100%  input_tokens=0  output_tokens=0  cache_read_tokens=0  cache_creation_tokens=0  cost_usd=-
  anthropic/claude-sonnet-5.5:medium  n=1  success=100%
coverage: 14%  learned_success: -  control_success: -
dispatches: 0  routed_by_mod: 0  swapped: 0
fallbacks: opt_out=7
failures: parse=0  hook=0  launcher=0
```

```console
$ spatz stats --json
{"by_type":[{"task_type":"other","n":1,"pairs":[{"model":"anthropic/claude-sonnet-5.5","effort":"medium","n":1,"success_rate":1}],"adoption_rate":1,"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_creation_tokens":0,"cost_usd":null}],"coverage":0.14285714285714285,"learned_success":null,"control_success":null,"dispatches":0,"routed_by_mod":0,"swapped":0,"fallbacks":{"opt_out":7},"failures":{"parse":0,"hook":0,"launcher":0}}
```

## Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| 0 | Success. `spatz hook` always returns 0. | |
| 1 | Runtime error. spatz prints `spatz: <message>` to stderr. | Unknown effort in `--models`. No usable candidate in `--models`. Invalid `--effort` in `report`. Unknown `suggestion_id`. DuckDB extension download failed. |
| 2 | Usage error. spatz prints the message and the usage text to stderr. | No candidate source. Invalid `--family` or no family matches. Non-string `models` default. Missing task, `<suggestion_id>`, `--model`, `--effort` or `--result`. `--result` not `pass`, `partial` or `fail`. `--rounds` not a non-negative integer. Invalid `--type`. Unknown flag. |

An invalid effort gives code 1 in `--models` and in `report --effort`, because the core checks it. An invalid `--result` gives code 2, because the CLI checks it.
