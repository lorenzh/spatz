---
title: Measurement results for model and effort selection
description: A 4-hour benchmark of Claude and Codex models at different effort levels on hidden-test TypeScript tasks, with cost-per-pass analysis and decision-rule validation.
tags: [spatz, measurement, benchmark, learning, decision rule]
keywords: [pass rate, cost per pass, bench2, easy, hidden tests, cascade, cost-efficiency, difficulty, model selection, effort level, simulation, verification]
---

# Measurement results for model and effort selection

This document reports the results of a 4-hour measurement run conducted October 6, 2026. The goal is to measure pass rates, costs, and decision quality for model selection.

## Method

The test uses two task sets of private hidden-test TypeScript pairs. Pairs are input code and its hidden test.

| Set | Tasks | Difficulty | Runs |
|---|---|---|---|
| Easy | 24 | Simple algorithms and utilities | ~720 |
| Bench2 | 16 | Algorithms and tools with state | ~384 |

The easy set runs at three difficulty levels. Bench2 has four tasks at medium difficulty and twelve at hard.

### Models and effort

Claude: `claude-opus-5-5` and `claude-sonnet-5-5` at low, medium, and high effort.
Codex: `gpt-6-luna` and `gpt-6.1-sol` at low, medium, and high effort.

### Isolation

Each run uses `env -i` (no inherited environment). Claude runs use `claude -p --safe-mode` with a temp `HOME` and temp `CLAUDE_CONFIG_DIR`. Codex runs create a temp `CODEX_HOME` per run.

Each run is spawned in its own shell. The runner records wall time, tokens, and result.

### Grading

A result is `PASS` when all hidden tests pass. Any other outcome counts as non-pass. Token totals sum input + output + reasoning for Codex (cached input excluded). Claude totals sum input + output + cache read + cache create + thinking.

## Results

Pass rates use 95% Wilson confidence intervals. Cost per pass divides recorded USD cost by passes.

### By model, effort, and dataset

| Dataset | Family | Model | Effort | n | Pass rate [95% CI] | Median s | Median tokens | Cost/pass |
|---|---|---|---|---|---|---|---|---|
| Easy | Claude | opus-5-5 | low | 120 | 96.7% [91.7%, 98.7%] | 15.4 | 66473 | $0.095 |
| Easy | Claude | opus-5-5 | medium | 118 | 98.3% [94.0%, 99.5%] | 22.9 | 67232 | $0.119 |
| Easy | Claude | opus-5-5 | high | 120 | 95.0% [89.5%, 97.7%] | 26.4 | 75964 | $0.144 |
| Easy | Claude | sonnet-5-5 | low | 119 | 93.3% [87.3%, 96.6%] | 11.6 | 50386 | $0.052 |
| Easy | Claude | sonnet-5-5 | medium | 120 | 93.3% [87.4%, 96.6%] | 12.6 | 51366 | $0.057 |
| Easy | Claude | sonnet-5-5 | high | 120 | 93.3% [87.4%, 96.6%] | 20.2 | 86458 | $0.081 |
| Bench2 | Claude | opus-5-5 | low | 64 | 84.4% [73.6%, 91.3%] | 37.0 | 98862 | $0.214 |
| Bench2 | Claude | opus-5-5 | medium | 64 | 92.2% [83.0%, 96.6%] | 58.4 | 147836 | $0.294 |
| Bench2 | Claude | opus-5-5 | high | 64 | 93.8% [85.0%, 97.5%] | 77.1 | 158092 | $0.328 |
| Bench2 | Claude | sonnet-5-5 | low | 64 | 73.4% [61.5%, 82.7%] | 29.5 | 99380 | $0.139 |
| Bench2 | Claude | sonnet-5-5 | medium | 64 | 84.4% [73.6%, 91.3%] | 33.1 | 103456 | $0.131 |
| Bench2 | Claude | sonnet-5-5 | high | 64 | 92.2% [83.0%, 96.6%] | 52.0 | 143058 | $0.174 |

Easy-set pass rates are high for both models. Bench2 shows model and effort effects. On easy tasks, sonnet-5-5/low achieves the best cost per pass ($0.052). On bench2, sonnet-5-5/medium costs $0.131 per pass while achieving 84.4% pass rate.

Codex pass rates: gpt-6.1-sol outperforms gpt-6-luna on bench2 (93–94.6% vs 37.5–75.0% across efforts). On easy, both reach 85.7–89.6% (excluding the m4-shapes task, which has a known issue).

### Cost efficiency on easy set

The easy set supports finding a cheap sufficient pair.

| Pair | Pass rate | Cost/pass | Cost/run |
|---|---|---|---|
| sonnet-5-5/low | 100% | $0.035 | $0.035 |
| sonnet-5-5/medium | 100% | $0.036 | $0.036 |
| opus-5-5/medium | 100% | $0.072 | $0.072 |

Sonnet at low or medium effort matches opus on easy tasks and costs half as much.

### Bench2 pass stability

Repeat agreement measures adjacent replicate pairs in the same task × model × effort group. A flip is a pass/non-pass change.

| Family | Flips | Adjacent pairs | Flip rate |
|---|---|---|---|
| Claude | 14 | 288 | 4.9% |
| Codex | 15 | 143 | 10.5% |

Codex shows more variability. Both are usable for learning.

## Simulation results

A simulator replayed 35 strategy variants on bench2 data. Variants include threshold changes, Thompson sampling, exploration tuning, and hierarchical pooling.

The top variant is TS threshold + escalate. On hard tasks it achieves:
- Success rate: 90.3%
- Expected tokens/success: 111,675
- Expected tokens/run: 100,868

The cascade variant improves cost:
- Cheapest-first cascade: 100% success, 171,985 tokens/success
- Current Spatz rule: 90.3% success, 111,675 tokens/success

On medium tasks, the current rule stays efficient:
- Current rule: 100% success, 65,851 tokens/success
- Cascade: 100% success, 103,349 tokens/success

### Simulation finding

Escalate-on-failure and adjacent exploration help. Decay, UCB, and removing the control group hurt. Pooling across difficulties and strict cost/success ratios do not improve the learned ordering.

## Cascade simulation

A second simulation (200 seeds × 4 worlds) compared eight policies including cascades. Each policy made 2,500 decisions per seed. Rankings use regret relative to an oracle.

| Rank | Policy | Regret/task | Cost/success | Success % |
|---|---|---|---|---|
| 1 | Cheapest-first cascade | 1.64 | 4.52 | 95.87% |
| 2 | Draft, review on weak signal | 3.35 | 4.91 | 88.27% |
| 6 | Current single pick | 7.67 | 10.21 | 91.08% |

The cascade saves 55% of cost per success versus the current rule on this synthetic workload. It requires reliable tests to detect failures.

## Data replay

139 production suggestions from October 4–6 were replayed. The copy holds 92 reported outcomes: 66 passes, 22 partials, 4 failures (71.7% full-pass rate, 95% CI 61.8–79.9%).

### Key findings

1. **Luna/low qualifies on review×medium.** It has 9 passes and 3 partials in 12 reports. The learned estimate is 0.821, meeting the 0.8 threshold. Its observed full-pass rate is 75% (95% CI 47–91%).

2. **Cell coverage is sparse.** Only 4 of 41 measured cell/pair combinations reach five outcomes. Only 13 of 24 cells have any outcome.

3. **The threshold is not a hard gate.** When no pair meets n≥5 and estimate≥0.8, the rule takes the best estimate anyway. Raising the threshold from 0.8 to 0.9 changes zero picks in this data.

4. **Reports override token evidence.** All 92 production outcomes match the recommendation. Only 14 have token evidence for the pair. This records adoption, not independent verification.

## Key findings

### Strongest pair not cost-efficient

On easy, both sonnet-5-5 and opus-5-5 near 100% pass rate. Sonnet at low effort costs $0.035 per pass. Opus costs $0.095 at the same rate. The expensive pair brings no quality gain on easy tasks.

On bench2, opus reaches 93.8% while sonnet reaches 92.2%, a 1.6 percentage point gap. Sonnet/high costs $0.174 per pass; opus/high costs $0.328. The gap does not justify a 2× cost multiplier.

### Effort differences per model

Sonnet's pass rate is flat across efforts on easy (93.3% at all levels). Opus improves from 96.7% to 98.3% from low to medium, then drops to 95% at high.

On bench2 hard, sonnet improves from 73.4% to 92.2% as effort increases. Opus stays near 93–94% across efforts.

High effort does not always improve pass rate and increases cost. Learned routing should adapt per model and task type.

### Easy tasks do not separate models

All easy-task pairs except a few reach >90% pass rate. The easy set cannot rank models. Bench2 better differentiates.

### Learned rule replay saves tokens

Replaying the learned rule on the actual bench2 data (simulating 4 runs each, pooling results):

- Full cascade: 100% success, 103,349 tokens/success
- Escalate-on-failure: 90.3% success, 111,675 tokens/success
- Cheapest pair only: 35.5% success, 279,535 tokens/success

When data is dense (repeated tasks), learning which pair to try first saves ~39–50% tokens per success vs always picking cheapest.

## Pitfalls found

1. **Personal skills leak into Codex runs.** Codex uses hook scripts from the host. Presence of personal skills (e.g., `spatz:ponytail`) alters available tools and can change task outcomes.

2. **Router hooks and mod must be off.** Running with enabled router hooks or mod changes which model serves the run, invalidating isolation.

3. **Mod swaps pinned models.** If a mod pin is active, the actual model differs from the recorded model.

4. **Unstated behavior in prompts fails correct solutions.** Two easy-set tasks (m4-shapes, h6-tokenbucket) show high fail rates for Claude. Manual inspection found the issue is task description, not model limitation.

## Limits

- Task sets are small (24 and 16 tasks).
- Bench2 has 12 hard and 4 medium; runs repeat the same task, so sample sizes overstate independent problems.
- 40 total tasks executed, not independent.
- Runs are not independent across models; each task gets one random seed per run.
- Codex has no recorded USD cost, so token estimates drive cost comparisons.
- Measurement took one day, a snapshot of one workload.
- No measurement of non-code types.
- Wilson intervals treat rows as independent; task clustering is not modeled.
- Simulation assumes known verifier error rates (1% false negative, 2% false positive).

## How to reproduce

To run the benchmark suite:

1. Set up isolation: temp `HOME`, temp `CLAUDE_CONFIG_DIR`, temp `CODEX_HOME`.
2. Use `claude -p --safe-mode` for Claude runs; `env -i` for Codex.
3. Run each task 4–5 times per model × effort pair.
4. Record wall time, token counts, and pass/fail result.

To replay the learned rule:

1. Collect outcomes from production (model, effort, result, task type, difficulty).
2. Compute per-cell estimates using (1 + sum of quality) / (2 + n).
3. For each new task, apply the learned rule from [how-it-works.md](how-it-works.md#how-spatz-picks-a-model-and-effort): cheapest pair with n≥5 and estimate≥0.8.
4. If no pair qualifies, use the best estimate among those with n≥5.
5. Compare selected pair tokens vs. Oracle tokens.

The full simulator code is in the repo's `lab/` directory. See `lab/chain/REPORT.md` for cascade details and `lab/sim/results/tables.md` for all 35 variant rankings.
