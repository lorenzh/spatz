---
title: How spatz picks a model and effort
description: The decision rule of spatz: cells, the Beta estimate, thresholds, cost order, critical tasks, exploration, the control group and how quality is computed.
tags: [spatz, recommendation, learning]
keywords: [bench.use, bench.snapshot, bench.prior_weight, spatz-snapshot/1, spatz-measurements, release, import-eval, bench prior, snapshot, n_prior, n_bench, attempt, retry, chain, outcome, decision rule, strategy, learned, learned-fallback, credible bound, jev-choice, rules, strongest, estimate, beta, threshold, exploration, control group, cost order, quality, success, stats, scope, turn, agent, session]
---

# How spatz picks a model and effort

spatz recommends the cheapest candidate that has proven good enough for this kind of task. A candidate is one pair of model and effort. Without enough data, spatz uses the pick of Jev or the most expensive candidate.

The terms are explained in [how-it-works.md](how-it-works.md#terms). For benchmark results and policy comparisons, see [measurements.md](measurements.md).

## Cells and the estimate

A cell is the pair (task type, difficulty), for example (`code.bugfix`, `easy`). spatz learns per cell. Criticality is not part of the cell. It only changes the decision rule.

For each candidate in a cell, spatz computes an estimate of the success rate:

```
estimate = (1 + successes) / (2 + n)
```

`n` counts scored first attempts of the candidate in the cell, plus frozen legacy and eval outcomes. `successes` counts the outcomes with quality `≥ 0.8` (`successQuality`). A partial result is no success. This is the mean of a Beta distribution that starts at 0.5. A candidate without outcomes has the estimate 0.5. Each first-attempt outcome moves the estimate towards the observed success rate. Only live first attempts count in `n`.

Only some outcomes count:

- Suggestions from `--dry-run` do not count.
- An outcome counts for the pair that was actually used, not for the recommended pair.
- An outcome counts only when spatz knows both the model and the effort of the used pair.
- Outcomes of models that are not in the current `--models` list do not count.
- Old outcomes do not decay.

Each reported retry keeps its own outcome in separate retry history.
A same-pair reported failure followed by a pass contributes `n=1` and `successes=0` to the first-attempt estimate.
The retry contributes `n=1` and `successes=1` to retry history.
`store.cellStats(taskType)` uses only ordinal 1 of root suggestions and legacy/eval outcomes.
`store.retryStats(taskType)` groups later ordinals and `--retry-of` chain members by cell and actual model/effort pair.
Retry outcomes cannot change the first-attempt estimate.
An internal test-fix-test loop stays in one attempt. Its latest ordered result supplies the quality.
A sequence `A → B → A` keeps three attempts even when the first and last pairs match.

### Model versions

Outcomes do not decay with age. Instead, each attempt stores a `model_version` when the harness shows a dated model id (for example `claude-sonnet-4-5-20250929` gives `20250929`). Otherwise it stores null.
For each model, the newest known version is the live one. Outcomes of an older known version do not count, so a new version starts with an empty estimate. Outcomes with a null version count for every version.
The old outcomes stay in the database. `spatz stats --model-version <v>` shows them.

### Bench prior

spatz uses benchmark results as a capped prior. It needs no import and writes nothing into your database.

**Source.** Every merge to `main` in the public repository [lorenzh/spatz-measurements](https://github.com/lorenzh/spatz-measurements) publishes one aggregated snapshot as a GitHub Release (schema `spatz-snapshot/1`). spatz downloads `releases/latest/download/snapshot.json` and its `snapshot.json.sha256`:

- spatz checks the SHA-256 and the schema. It rejects a file that fails either check.
- It caches the file in `~/.spatz/bench-snapshot.json` and downloads again after 24 hours at the earliest (3 s timeout).
- A failed download, checksum or schema check keeps the last good cache.
- Without a good cache, spatz uses the copy bundled with the build. A release refreshes that copy.
- `SPATZ_NO_NETWORK=1` reads the cache or the bundled copy and never downloads.
- spatz uploads nothing.

**Cells.** The snapshot counts `pass`, `partial` and `fail` per (model, model version, effort, task type, difficulty). It leaves out the bench version `prototype`. A cell gives `n_eff = n` and `s_eff = pass` (`partial` is no success). Pooled levels sum `n_eff` and `s_eff` like live rows.

**Weight.** The prior is worth at most `k` pseudo-observations, `k = 6` by default ([`bench.prior_weight`](configuration.md#bench-evidence-bench-settings)). With `w = min(k, n_eff)` and `a = w * s_eff / n_eff`:

```
estimate = (1 + successes + a) / (2 + n + w)
```

Live outcomes dominate quickly. A cell with a perfect bench record starts at 7/8. After 20 live failures the estimate is 7/28 = 0.25.

The prior changes the estimate only. `n` stays the count of live first attempts. Gates (`n ≥ 5`, critical `n ≥ 10` and the lower bound) use `n` and live `successes` only. The ranking shows `n_prior` (= `w`) and `n_bench` (raw bench runs) next to `n` when a prior applies. The reason names `version_match` and the source, for example `source: release snapshot 3ce2237 of 2026-10-10 (2 d old)`. `spatz stats` shows the snapshot in use (see [cli.md](cli.md#spatz-stats)).

**Version.** A cell applies when its `model_version` equals the live model version (`version_match: exact`) or either one is null (`unknown`). A known different version seeds nothing.

**Off.** Set [`bench.snapshot`](configuration.md#bench-evidence-bench-settings) to `false` to turn the snapshot prior off. `bench.prior_weight: 0` turns off every bench prior.

**Imported rows.** Rows imported with [`spatz import-eval`](cli.md#spatz-import-eval) join this prior only when [`bench.use`](configuration.md#bench-evidence-bench-settings) is `true`. They use the same cells. `rubric` rows count 0.5, because no local judge is validated, and only `pass` is a success. Their `model_version` is compared per row. Snapshot cells and imported rows add up in one cell under the same cap `k`. With `bench.use` off, imported rows only appear in `spatz stats`.

**No double counting.** With `bench.use` on, spatz prefers the imported rows. Each imported file gets the run id of its measurement run: the first 12 hex digits of the SHA-256 of its sorted row `run_id`s, the id that names the run folder. A snapshot cell that includes such a run is left out, and the imported rows supply that evidence. A cell that mixes an imported run with other runs is left out as a whole, so import all runs (`spatz import-eval runs/`) to keep their evidence. Rows imported before schema v13 have no run id; import the same files again to add it.

### Enough data and pooling

A cell has enough data when at least one candidate of the catalog has `n ≥ 5` in it.

If the cell has too little data, spatz pools the outcomes of the same task type over the same and harder difficulty levels:

| Difficulty | Pooled levels |
|---|---|
| `easy` | `easy`, `medium`, `hard` |
| `medium` | `medium`, `hard` |
| `hard` | no pooling |

Success on a harder task is evidence for an easier task. The reverse is not true. Pooled data uses the same "enough data" rule.

With `SPATZ_FAMILY_POOLING=1`, a level that still has too little data pools next over all types of the same family (see [how-it-works.md](how-it-works.md#task-types)) at the same difficulty. spatz never pools across families. The flag is off by default until an offline replay shows that family pooling does not hurt.

## Decision order

spatz applies the first rule that matches. The values are the start values in `DEFAULT_TUNING` (`packages/core/src/contracts/types.ts`).

1. **Critical task.** If the criticality is not `none`, spatz uses the critical rule. A cheaper candidate wins only with `n ≥ 10` in this cell and a 5 % lower credible bound `≥ 0.9`. The bound is the 5 % quantile of Beta(1 + successes, 1 + n − successes). With only passes, a candidate needs 28 outcomes. spatz takes the cheapest such candidate (strategy `learned`). Otherwise it recommends the most expensive candidate (strategy `strongest`). There is no pooling, no control and no exploration for critical tasks.
2. **Random draw.** spatz draws one number `u` in [0, 1) per suggestion.
   - If `u < 0.1`, the suggestion is in the control group. spatz recommends the most expensive candidate (strategy `strongest`, `control: true`).
   - If `0.1 ≤ u < 0.2`, spatz explores after steps 3 to 7. See [Exploration](#exploration).
   - If `u ≥ 0.2`, spatz continues with step 3.
3. **Learned choice in the cell.** If the cell has enough data, spatz takes the cheapest candidate with `n ≥ 5` and estimate `≥ 0.8` (strategy `learned`).
4. **Best estimate in the cell.** If the cell has enough data but no candidate meets both limits, spatz takes the candidate with the highest estimate among the candidates with `n ≥ 5`. Candidates with fewer outcomes cannot win this step. On a tie, the more expensive candidate wins (strategy `learned-fallback`). This strategy marks a pick that met no limit.
5. **Pooled level.** If the cell has too little data, spatz repeats steps 3 and 4 on the pooled levels.
6. **Jev choice.** If the pooled levels also have too little data, spatz takes the best candidate of Jev (strategy `jev-choice`).
7. **Rules.** If Jev was not involved, or its answer is not in the catalog, spatz recommends the most expensive candidate (strategy `rules`).

Fable stays in the Claude Code preset.
With the current catalog and prices, the most expensive pairs are `claude-fable-5-1:max` in Claude Code and `gpt-6-astra:ultra` in Codex.
Cold start without a usable Jev choice selects this pair, except during exploration.
The control group selects it too.
Unless a cheaper pair meets the stricter learned limits, critical tasks select it.
To exclude models, set an explicit allowed list with `models` in config or `SPATZ_MODELS`.
For example, `SPATZ_MODELS='claude-opus-5-5:high,claude-sonnet-5-5:low+medium+high'` excludes Fable.
The list replaces the preset. See [configuration.md](configuration.md#default-models).

The fallback without Jev also goes through steps 3 to 5. It always uses the cell (`other`, `medium`). So `rules` applies only while that cell and its pooled level have too little data.

The ranking shows the recommended candidate and up to two next candidates in cost order. Each entry shows the estimate and `n` of the level that made the decision.

## Cost order

spatz sorts the catalog from cheap to expensive by these keys:

1. Output price per token
2. Input price per token
3. Effort: `none` < `low` < `medium` < `high` < `xhigh` < `max` < `ultra`
4. Model id, alphabetically

The prices come from the OpenRouter model list. Prices apply per model, not per effort. spatz uses only the base prices.

A model that OpenRouter does not list is unknown. Unknown models come after all known models. Among unknown models, effort and id decide.

The "most expensive candidate" is the last candidate in this order. If you pass an unknown model, it becomes the most expensive candidate. Then the control group, the `rules` strategy and critical tasks recommend that model.

If a model has no effort in `--models`, spatz uses `low`, `medium` and `high`. It keeps only the efforts that OpenRouter lists for the model. `none`, `xhigh`, `max` and `ultra` are used only when you pass them.

## Exploration

Exploration tries a cheaper candidate. Without it, spatz never learns that a cheaper model is good enough.

When the draw selects exploration, spatz first computes the normal pick (steps 3 to 7). Then it looks at all candidates that are cheaper than the normal pick. It takes the one with the fewest outcomes in the cell. On a tie, the cheaper one wins. The estimate does not matter here.

If the normal pick is already the cheapest candidate, spatz does not explore. Then `explored` is `false`.

An explored suggestion has `explored: true`. Its reason starts with `Exploration:`. Its strategy stays the strategy of the normal pick.

## Control group

The control group gets the most expensive candidate in 10 % of the normal suggestions. It shows how often the most expensive pair succeeds in the same cells. You compare it with the learned choice to see whether cheaper picks lose quality.

`spatz stats` shows the comparison:

| Field | Meaning |
|---|---|
| `learned_success` | Success rate of learned picks: strategy `learned` and not explored. |
| `fallback_success` | Success rate of best-estimate picks: strategy `learned-fallback` and not explored. Compared with control in the same cells. |
| `control_success` | Success rate of the control group. |
| `learned_vs_control` | Intent-to-treat comparison: `itt` (every root decision of strategy `learned` or `learned-fallback`, explored and retried ones included; retry children are not decisions), `qualified` and `fallback` (not explored), each with `decisions`, `outcomes`, `coverage` (outcomes per decision), `rate`, `control_rate`, `diff` and a bootstrap 95 % interval `ci95` of `diff`. `cells` shows the mix of outcomes per task type and difficulty. |
| `cost_usd_per_success`, `tokens_per_success` | Per pair: spend of completed chains rooted at the pair, divided by their successes. `null` without a success. Orchestration spend is listed apart as `orchestration_cost_usd`. Chains with incomplete cost evidence (an unpriced or lower-bound usage, or an attempt without usage) count in `n` but not in the spend; `cost_incomplete_share` shows their share. |
| `cost_usd_per_attempt` | Per pair: mean cost of one attempt. |
| `coverage` | Share of suggestions (without `--dry-run`) that have an outcome. |
| `adoption` | Per task type: share of root decisions whose first actual pair is the recommended pair. |
| `success` | Per pair: share of outcomes with quality `≥ 0.8`. |

spatz compares first-attempt quality once per root for `learned_success` and `control_success`.
It groups these root decisions per cell. It uses only cells that have both groups. It weights each cell by its number of outcomes in both groups. If no cell has both groups, both fields are empty (`-` in text output, `null` in JSON).

If `learned_success` is about as high as `control_success`, the cheaper picks are good enough. If it is clearly lower, the learned picks lose quality. Small `n` gives noisy rates.

For the command options, read [cli.md](cli.md).

## Quality and success

The `attempt_outcomes` view computes quality for each attempt with evidence.
The `outcomes` view combines these rows with frozen legacy outcomes.

| Signal | Source | Value | Weight |
|---|---|---|---|
| `report` | `spatz report` | `pass` 1, `partial` 0.5, `fail` 0 | 1.0 |
| `test` | Bash test command in a hook | success 1, failure 0 | 1.0 |
| `build` | Bash build command in a hook | success 1, failure 0 | 0.8 |

The rules:

1. If an attempt has a report, its verdict supplies quality. Hook signals do not override that report.
2. Without a report, spatz takes the latest ordered value per signal kind within that attempt. Quality is their weighted mean.
3. Without a signal, there is no outcome.

Conflicting observations without source order stay unresolved.
Execution evidence supplies the actual pair. A report fills only unknown pair fields.
The recommended pair alone supplies no execution evidence.
`--correct` changes a prior verdict without adding a retry or cost.
An identical report is a replay. A changed reported verdict without `--correct` creates a retry.
With `--confirm`, a changed prior verdict is an error instead.
If the catalog lists only `none` for a model, spatz normalizes missing effort to `none`.
Learning also treats older null-effort outcomes as `none` for those models.
Other unknown pairs cannot train learning.

An outcome is a success when quality `≥ 0.8`. `partial` is not a success.

## Routing scope and measurement

Schema v3 adds `scope`, `agent`, `turn_id` and `agent_id` to suggestions.
`SCHEMA_V3` preserves earlier suggestions and outcomes. Earlier rows have null attribution fields.
The core stores five scope labels: `step`, `turn`, `subagent`, `session` and `escalate`.
These labels describe when the caller makes a routing decision.
They do not change the learning cell or its thresholds.

Session windows use `(session_id, agent_id)`. Each subagent can keep an independent open suggestion.
The main sequence uses a null agent id.
A suggestion can cover several turns. Mod usage keeps each step separate.
Direct usage has no success value. Explicit reports or test/build signals supply that value.
Each scored attempt has its own outcome. Usage alone supplies no quality.
See [how-it-works.md](how-it-works.md#direct-attribution) for the fields and migration.

`spatz stats --by scope` counts completed recovery chains under the root suggestion's scope.
It includes input, output, cache-read and cache-creation tokens.
The cache-read share divides cache-read tokens by all input tokens, including cache creation.
Suggestions without a scope appear on a separate line.
`n` counts each completed chain once. Legacy outcomes keep their previous meaning.
Usage without an outcome still contributes tokens.
Each execution keeps its tokens. Chain decision cost counts all linked attempts once under the first actual pair.
For costs `10 → 20 → 70`, the root cost is `100`.
Failed chains contribute cost too. Orchestration overhead stays in chain totals with a null attempt ID.
Separate review suggestions keep separate chains.
USD totals use stored prices or reported costs and exclude rows with `tokens_schema = 1` or `tokens_complete = 0`.
The view does not measure routing latency.
See [cli.md](cli.md#spatz-stats) for the output fields.

## Worked example

The catalog has six candidates. The cost order puts Sonnet before Opus. The task is a bug fix. Jev classifies it as (`code.bugfix`, `easy`), criticality `none`. The draw is `u = 0.5`, so spatz takes the normal path.

The cell (`code.bugfix`, `easy`) has this history:

| Candidate (cost order) | n | Sum of quality | Estimate |
|---|---|---|---|
| `sonnet:low` | 3 | 2.0 | (1 + 2.0) / 5 = 0.60 |
| `sonnet:medium` | 6 | 5.6 | (1 + 5.6) / 8 = 0.825 |
| `sonnet:high` | 2 | 2.0 | (1 + 2.0) / 4 = 0.75 |
| `opus:low` | 0 | 0 | (1 + 0) / 2 = 0.50 |
| `opus:medium` | 0 | 0 | 0.50 |
| `opus:high` | 8 | 7.5 | (1 + 7.5) / 10 = 0.85 |

1. The criticality is `none`. The critical rule does not apply.
2. `u = 0.5` is not below 0.2. No control, no exploration.
3. The cell has enough data: `sonnet:medium` and `opus:high` have `n ≥ 5`. Both have an estimate `≥ 0.8`. `sonnet:medium` is cheaper, so it wins.

The ranking is `sonnet:medium`, `sonnet:high`, `opus:low`.

With `u = 0.15`, spatz explores. The candidate cheaper than `sonnet:medium` is `sonnet:low` only. spatz recommends `sonnet:low` with `explored: true`.

With criticality `security`, no candidate has `n ≥ 10`. spatz recommends `opus:high`.

Assume the agent then runs the tests twice and the build once. The first test run fails, the second passes, and the build passes. There is no report. The latest test value is 1 and the latest build value is 1. The quality is (1.0 × 1 + 0.8 × 1) / 1.8 = 1.0, a success. If the build fails instead, the quality is (1.0 × 1 + 0.8 × 0) / 1.8 ≈ 0.56. That is not a success. A later `spatz report <id> ... --result partial` sets the quality to 0.5.
