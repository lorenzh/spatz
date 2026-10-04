---
title: How spatz picks a model and effort
description: The decision rule of spatz: cells, the Beta estimate, thresholds, cost order, critical tasks, exploration, the control group and how quality is computed.
tags: [spatz, recommendation, learning]
keywords: [decision rule, strategy, learned, jev-choice, rules, strongest, estimate, beta, threshold, exploration, control group, cost order, quality, success, stats]
---

# How spatz picks a model and effort

spatz recommends the cheapest candidate that has proven good enough for this kind of task. A candidate is one pair of model and effort. Without enough data, spatz uses the pick of Jev or the most expensive candidate.

The terms are explained in [how-it-works.md](how-it-works.md#terms).

## Cells and the estimate

A cell is the pair (task type, difficulty), for example (`code.bugfix`, `leicht`). spatz learns per cell. Criticality is not part of the cell. It only changes the decision rule.

For each candidate in a cell, spatz computes an estimate of the success rate:

```
estimate = (1 + sum of quality) / (2 + n)
```

`n` is the number of outcomes of the candidate in the cell. `quality` is the value of one outcome, from 0 to 1. This is the mean of a Beta distribution that starts at 0.5. A candidate without outcomes has the estimate 0.5. Each outcome moves the estimate towards the observed quality.

Only some outcomes count:

- Suggestions from `--dry-run` do not count.
- An outcome counts for the pair that was actually used, not for the recommended pair.
- An outcome counts only when spatz knows both the model and the effort of the used pair.
- Outcomes of models that are not in the current `--models` list do not count.
- Old outcomes do not decay.

### Enough data and pooling

A cell has enough data when at least one candidate of the catalog has `n ≥ 5` in it.

If the cell has too little data, spatz pools the outcomes of the same task type over the same and harder difficulty levels:

| Difficulty | Pooled levels |
|---|---|
| `leicht` | `leicht`, `mittel`, `schwer` |
| `mittel` | `mittel`, `schwer` |
| `schwer` | no pooling |

Success on a harder task is evidence for an easier task. The reverse is not true. Pooled data uses the same "enough data" rule.

## Decision order

spatz applies the first rule that matches. The values are the start values in `DEFAULT_TUNING` (`packages/core/src/contracts/types.ts`).

1. **Critical task.** If the criticality is not `none`, spatz uses the critical rule. A cheaper candidate wins only with `n ≥ 10` and estimate `≥ 0.9` in this cell. spatz takes the cheapest such candidate (strategy `learned`). Otherwise it recommends the most expensive candidate (strategy `strongest`). There is no pooling, no control and no exploration for critical tasks.
2. **Random draw.** spatz draws one number `u` in [0, 1) per suggestion.
   - If `u < 0.1`, the suggestion is in the control group. spatz recommends the most expensive candidate (strategy `strongest`, `control: true`).
   - If `0.1 ≤ u < 0.2`, spatz explores after steps 3 to 7. See [Exploration](#exploration).
   - If `u ≥ 0.2`, spatz continues with step 3.
3. **Learned choice in the cell.** If the cell has enough data, spatz takes the cheapest candidate with `n ≥ 5` and estimate `≥ 0.8` (strategy `learned`).
4. **Best estimate in the cell.** If the cell has enough data but no candidate meets both limits, spatz takes the candidate with the highest estimate. On a tie, the more expensive candidate wins (strategy `learned`).
5. **Pooled level.** If the cell has too little data, spatz repeats steps 3 and 4 on the pooled levels.
6. **Jev choice.** If the pooled levels also have too little data, spatz takes the best candidate of Jev (strategy `jev-choice`).
7. **Rules.** If Jev was not involved, or its answer is not in the catalog, spatz recommends the most expensive candidate (strategy `rules`).

The fallback without Jev also goes through steps 3 to 5. It always uses the cell (`other`, `mittel`). So `rules` applies only while that cell and its pooled level have too little data.

The ranking shows the recommended candidate and up to two next candidates in cost order. Each entry shows the estimate and `n` of the level that made the decision.

## Cost order

spatz sorts the catalog from cheap to expensive by these keys:

1. Output price per token
2. Input price per token
3. Effort: `low` < `medium` < `high` < `xhigh` < `max`
4. Model id, alphabetically

The prices come from the OpenRouter model list. Prices apply per model, not per effort. spatz uses only the base prices.

A model that OpenRouter does not list is unknown. Unknown models come after all known models. Among unknown models, effort and id decide.

The "most expensive candidate" is the last candidate in this order. If you pass an unknown model, it becomes the most expensive candidate. Then the control group, the `rules` strategy and critical tasks recommend that model.

If a model has no effort in `--models`, spatz uses `low`, `medium` and `high`. It keeps only the efforts that OpenRouter lists for the model. `xhigh` and `max` are used only when you pass them.

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
| `control_success` | Success rate of the control group. |
| `coverage` | Share of suggestions (without `--dry-run`) that have an outcome. |
| `adoption` | Per task type: share of outcomes whose used pair is the recommended pair. |
| `success` | Per pair: share of outcomes with quality `≥ 0.8`. |

spatz compares `learned_success` and `control_success` per cell. It uses only cells that have both groups. It weights each cell by its number of outcomes in both groups. If no cell has both groups, both fields are empty (`-` in text output, `null` in JSON).

If `learned_success` is about as high as `control_success`, the cheaper picks are good enough. If it is clearly lower, the learned picks lose quality. Small `n` gives noisy rates.

For the command options, read [cli.md](cli.md).

## Quality and success

The `outcomes` view computes one quality value per suggestion from its signals.

| Signal | Source | Value | Weight |
|---|---|---|---|
| `report` | `spatz report` | `pass` 1, `partial` 0.5, `fail` 0 | 1.0 |
| `test` | Bash test command in a hook | success 1, failure 0 | 1.0 |
| `build` | Bash build command in a hook | success 1, failure 0 | 0.8 |

The rules:

1. If a report exists, the quality is the value of the latest report. Hook signals do not count.
2. Without a report, spatz takes the latest value per signal kind. The quality is the weighted mean over the kinds.
3. Without a signal, there is no outcome.

The used pair comes from the latest report. Without a report, it is the model with the most output tokens in the time window of the suggestion. Its effort is the latest known effort of that model from the hooks. If no hook reported an effort, the outcome does not count for learning.

An outcome is a success when quality `≥ 0.8`. `partial` is not a success.

## Worked example

The catalog has six candidates. The cost order puts Sonnet before Opus. The task is a bug fix. Jev classifies it as (`code.bugfix`, `leicht`), criticality `none`. The draw is `u = 0.5`, so spatz takes the normal path.

The cell (`code.bugfix`, `leicht`) has this history:

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
