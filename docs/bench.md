---
title: Bench eval row format (spatz-eval-row/1)
description: The versioned JSON Lines format in which a benchmark writes one row per run for spatz to import, with its field rules, null token semantics, the JSON Schema file and the TypeScript parser.
tags: [spatz, benchmark, contract, data]
keywords: [import-eval, bench_attempts, bench.use, task_hash, eval row, spatz-eval-row, EvalRow, parseEvalRow, EVAL_ROW_SCHEMA, json schema, jsonl, bench, check, rubric, judge, tokens, cost_usd, estimated_cost_usd, list price, official-prices.json, price-check, null cost, task_type, versioning]
---

# Bench eval row format

A benchmark writes one row per run as JSON Lines. spatz imports these rows as attempts. The format is a versioned contract: `spatz-eval-row/1`.

The contract has two forms that agree with each other:

- [`contracts/eval-row.v1.schema.json`](../contracts/eval-row.v1.schema.json): JSON Schema (draft 2020-12) for validators in any language.
- `@spatz/core`: the type `EvalRow`, the constant `EVAL_ROW_SCHEMA` and the function `parseEvalRow(value)`. The function returns the row with only contract fields, in contract order, or `null` when the value breaks the contract.

The [Measurements](measurements.md) page shows results from a benchmark of this kind.

## Versioning

- A new optional field is additive. It keeps the version. Readers ignore fields they do not know.
- A breaking change (a field removed, renamed or with a new meaning, or a narrower value set) bumps the number: `spatz-eval-row/2`, with a new schema file `eval-row.v2.schema.json`.

## Fields

All fields are required unless the rule says otherwise. Strings must not be empty.

| Field | Type | Rule |
| --- | --- | --- |
| `schema` | string | `"spatz-eval-row/1"`. |
| `run_id` | string (UUID) | Unique per run. spatz dedupes on it. |
| `bench_version` | string | Task-set version. |
| `task_id` | string | Stable task id. |
| `task_version` | integer >= 1 | Bumps when the prompt, the start snapshot or the check change. |
| `task_type` | string | One of the 16 labelled task types of taxonomy v2 (every type except `other`). The bench sets it, not the classifier. |
| `difficulty` | `easy`, `medium`, `hard` | Bench label. |
| `criticality` | string, optional | `none`, `business_logic`, `security` or `data_integrity`. Default `none`. |
| `harness` | string | `claude-code`, `codex`, or the ACP agent name. |
| `agent_version` | string | Version of the harness. |
| `model` | string | Canonical OpenRouter id, for example `anthropic/claude-sonnet-5.5`. |
| `effort` | string | `none`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. |
| `answered_model` | string or null | Raw model id from harness evidence. |
| `model_version` | string or null | Dated model version, if the harness shows it. |
| `attempt` | integer >= 1 | `1` for one attempt per run. Reserved for cascades. |
| `result` | `pass`, `partial`, `fail` | From the bench's own check. |
| `check` | `tests`, `golden`, `rubric`, `human` | Verifier kind: hidden tests or a structural script, a golden answer, a rubric judge, or a human. `rubric` rows weigh 0.5 in the prior until their judge is validated. |
| `judge` | string or null | Rubric judge id (model plus version, or `human`). Must be null for `tests` and `golden`. |
| `duration_s` | number >= 0 | Wall time in seconds. |
| `tokens` | object | See [Tokens and cost](#tokens-and-cost). |
| `cost_usd` | number or null | Cost the harness reported. Null when not reported. |
| `estimated_cost_usd` | number or null, optional | Cost at the model's official list prices. Default null. See [Tokens and cost](#tokens-and-cost). |
| `started_at` | string | ISO 8601 in UTC with a `Z` suffix, on a real calendar day. |
| `contributor` | string | Login or `anon-<hash>`. |
| `verified` | boolean | True only when the bench ran the check itself. |

## Tokens and cost

`tokens` has five keys. All five must be present.

| Key | Meaning |
| --- | --- |
| `input` | Uncached input tokens. |
| `output` | Output tokens, reasoning included. |
| `cache_read` | Cached input tokens read, or null when not reported. |
| `cache_write` | Input tokens written to the cache, or null when not reported. |
| `reasoning` | Reasoning tokens, or null when not reported. |

Null means "not reported". It is never the same as 0.

- Usage reported: `input` and `output` are integers >= 0. The other counters are integers >= 0 or null. `cost_usd` is a number or null. spatz prices a row with null cost at import (`cost_source = priced`).
- No usage reported: all five counters, `cost_usd` and `estimated_cost_usd` are null together. Any other mix of nulls is invalid. spatz imports such a row with `cost_source = unavailable` and never prices it. The row counts for success rates, but not for cost-per-success estimates.

### Billed cost and list-price estimate

`cost_usd` is only the cost the harness billed or reported. It is null for a harness that reports no cost (for example Codex) and for subscription runs. So `cost_usd` values from different harnesses are not comparable.

`estimated_cost_usd` gives every row the same yardstick. The bench computes it from the token counters and the official list prices of the model, per token:

```
estimated_cost_usd = input × input price
                   + cache_read × cache read price
                   + cache_write × cache write price
                   + output × output price
```

`reasoning` is part of `output` and both providers bill it as output, so it is not added again. A null counter adds 0. A row is priced once, when the bench publishes it, and the bench records the prices it used with their source and date. spatz pins the official list prices in [`catalog/official-prices.json`](../catalog/official-prices.json); a daily check compares them with OpenRouter and reports differences, but never changes the table. A row without the field parses with `estimated_cost_usd = null`. The field is additive, so the version stays `spatz-eval-row/1`.

## Import

[`spatz import-eval`](cli.md#spatz-import-eval) reads JSON Lines files or run directories (`runs/<id>/rows.jsonl`). It stores each valid row once per `run_id` in the table `bench_attempts`, apart from live attempts. A second import changes nothing. `--dry-run` reports the counts and stores nothing. The command also keeps the extra field `task_hash` when a row has one.

Bench rows never enter live outcomes or the comparison of learned and control choices. `spatz stats` lists them in their own `bench` lines. They change recommendations only as a capped prior, and only when you set [`bench.use`](configuration.md#bench-evidence-bench-settings). Without an import, spatz gets the same evidence in aggregated form from the [bench snapshot](recommendation.md#bench-prior), a release of [spatz-measurements](https://github.com/lorenzh/spatz-measurements).

## Examples

A rubric row for a UI design task:

```json
{"schema":"spatz-eval-row/1","run_id":"0f8fad5b-d9cb-469f-a165-70867728950e","bench_version":"1","task_id":"sample/ui-1","task_version":1,"task_type":"design.ui","difficulty":"easy","criticality":"none","harness":"claude-code","agent_version":"2.1.289","model":"anthropic/claude-opus-5.5","effort":"high","answered_model":"claude-opus-5-5","model_version":null,"attempt":1,"result":"partial","check":"rubric","judge":"anthropic/claude-opus-5.5:2026-10","duration_s":41.2,"tokens":{"input":6,"output":1095,"cache_read":43895,"cache_write":4490,"reasoning":169},"cost_usd":0.31,"estimated_cost_usd":0.066623,"started_at":"2026-10-06T09:00:00.000Z","contributor":"anon-01234567","verified":true}
```

A Codex row without a reported cost:

```json
{"schema":"spatz-eval-row/1","run_id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","bench_version":"1","task_id":"sample/bugfix-1","task_version":1,"task_type":"code.bugfix","difficulty":"medium","criticality":"none","harness":"codex","agent_version":"0.130.0","model":"openai/gpt-6.1-sol","effort":"high","answered_model":"gpt-6.1-sol","model_version":null,"attempt":1,"result":"pass","check":"tests","judge":null,"duration_s":33.0,"tokens":{"input":4539,"output":1223,"cache_read":56320,"cache_write":null,"reasoning":197},"cost_usd":null,"estimated_cost_usd":0.02694,"started_at":"2026-10-06T01:40:33.681Z","contributor":"anon-01234567","verified":true}
```

## Validate in TypeScript

```ts
import { parseEvalRow } from "@spatz/core";

for (const line of (await Bun.file("rows.jsonl").text()).split("\n")) {
	if (line && !parseEvalRow(JSON.parse(line))) console.error("invalid row:", line);
}
```
