---
title: Measurement results for model and effort selection
description: A 4-hour benchmark of Claude and Codex models at different effort levels on hidden-test TypeScript tasks, with cost-per-pass analysis and empirical policy evaluation.
tags: [spatz, measurement, benchmark, learning, decision rule]
keywords: [pass rate, cost per pass, bench2, easy, hidden tests, cascade, cost-efficiency, difficulty, model selection, effort level, simulation, verification]
---

# Measurement results for model and effort selection

This document reports the results of a 4-hour measurement run conducted October 6, 2026. The goal is to measure pass rates, costs, and decision quality for model selection.

## Method

The test uses two task sets of private hidden-test TypeScript pairs. Pairs are input code and its hidden test.

| Set | Tasks | Difficulty | Claude runs | Codex runs | Total |
|---|---|---|---|---|---|
| Easy | 24 | Simple algorithms and utilities | 717 | 621 | 1,338 |
| Bench2 | 16 | Algorithms and tools with state | 384 | 239 | 623 |

The easy set runs at three difficulty levels. Bench2 has four tasks at medium difficulty and twelve at hard.

### Models and effort

Claude: `claude-opus-5-5` and `claude-sonnet-5-5` at low, medium, and high effort.
Codex: `gpt-6-luna` and `gpt-6.1-sol` at low, medium, and high effort.

### Isolation

Claude runs use `env -i` but restore the host `HOME` and `PATH`, with `claude -p --safe-mode` for safety. Codex runs use `env -i` with temp `HOME` and `CODEX_HOME`, filtering `GIT_*` and `CODEX_*` environment variables. Each run is spawned separately. The runner records wall time, tokens, and result. Contaminated attempts were excluded from analysis.

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

Easy-set pass rates are high for both Claude models. Bench2 shows model and effort effects. On easy tasks, sonnet-5-5/low achieves the best cost per pass ($0.052). On bench2, sonnet-5-5/medium costs $0.131 per pass while achieving 84.4% pass rate.

Codex aggregate pass rates on easy: 85.7% with all tasks, 89.6% excluding one task with a known hidden-test defect. Per-model rates: gpt-6-luna reaches 79.4–86.3% (effort-dependent), gpt-6.1-sol reaches 87.5–88.3%. On bench2, gpt-6.1-sol outperforms gpt-6-luna (93.0–94.6% vs 37.5–75.0%).

### Cost efficiency within easy difficulty

On the eight tasks labeled easy (not the full 24-task easy dataset), all three pairs reach 100% pass rate.

| Pair | n | Pass rate | Cost/pass | Median USD/run |
|---|---|---|---|---|
| sonnet-5-5/low | 40 | 100% | $0.035 | $0.035 |
| sonnet-5-5/medium | 40 | 100% | $0.036 | $0.036 |
| opus-5-5/medium | 38 | 100% | $0.074 | $0.072 |

On easy-difficulty tasks, sonnet at low or medium effort achieves the same pass rate as opus at half the cost. At whole-dataset level, sonnet/low is 93.3% ($0.052/pass) versus opus/low at 96.7% ($0.095/pass).

### Bench2 pass stability

Repeat agreement measures adjacent replicate pairs in the same task × model × effort group. A flip is a pass/non-pass change.

| Family | Flips | Adjacent pairs | Flip rate |
|---|---|---|---|
| Claude | 14 | 288 | 4.9% |
| Codex | 15 | 143 | 10.5% |

Codex shows more variability. Both are usable for learning.

## Empirical replay on bench2 data

The single-pick rule from the learned model selects the cheapest pair meeting n≥5 and estimated success ≥0.8. On bench2, an offline exploitation proxy using empirical probabilities and median tokens produces:

Hard-task estimates:
- Spatz single-pick rule: 90.3% success, 111,675 tokens/success
- Cheapest-first cascade: 100% success, 171,985 tokens/success (54% more tokens for higher success)

Medium-task estimates:
- Spatz single-pick rule: 100% success, 65,851 tokens/success
- Cheapest-first cascade: 100% success, 103,349 tokens/success

These are plug-in estimates pooling both model families, assuming independent cascade outcomes and using median tokens as cost. The replay implements a restricted proxy with a cheapest-pair fallback, not the full production router from recommendation.md.

## Synthetic policy comparison

A separate simulator evaluated 35 strategy variants on four synthetic worlds, each with 256 or 5,000 decisions. Variants include Thompson sampling, threshold tuning, exploration settings, and hierarchical pooling.

Results rank by expected regret (lower is better):

- Thompson threshold + escalate: regret −0.03 ± 0.01 at T=5,000 (top ranked)
- Exploration rates, control handling, and pooling choices show small effects
- Removal of control traffic reduces regret slightly, while strict cost/success rules increase it
- Decay and UCB variants rank lower

This synthetic ranking uses full policy logic on synthetic worlds and cannot transfer directly to observed task distributions.

## Eight-policy synthesis experiment

A separate 200-seed × 4-world experiment compared eight policies (including cascade, review, and single-pick variants). Each policy made 2,500 decisions per seed on synthetic tasks. Rankings use expected loss combining cost, failure cost, and latency.

| Rank | Policy | Expected loss | Cost/success | Success % |
|---|---|---|---|---|
| 1 | Cheapest-first cascade | 1.64 | 4.52 | 95.87% |
| 2 | Draft, review on weak signal | 3.35 | 4.91 | 88.27% |
| 6 | Current single pick | 7.67 | 10.21 | 91.08% |

On synthetic worlds, the cascade achieves 55.7% lower loss than the single-pick rule (comparing 4.52 vs 10.21 cost/success). This requires reliable test infrastructure to detect failures. The cost figures are synthetic units combining attempt cost, retry latency, and failure penalties, not measured USD.

## Data replay

139 production suggestions from October 4–6 were replayed. The copy holds 92 reported outcomes: 66 passes, 22 partials, 4 failures (71.7% full-pass rate, 95% CI 61.8–79.9%).

### Key findings

1. **Luna/low qualifies under the fractional-quality rule on review×medium.** It has 9 passes and 3 partials in 12 reports. The learned estimate (counting partials as 0.5) is 0.821, meeting the 0.8 threshold. Its observed full-pass rate is 75% (95% CI 47–91%). No measured cell/pair has a 95% lower confidence bound of 80% full-pass success.

2. **Cell coverage is sparse and uncertain.** Only 4 of 41 cell/pair combinations reach five outcomes. Only 13 of 24 cells have outcomes. 47 of 139 suggestions lack reported outcomes; missing data permits whole-traffic success rates between 47.5% and 81.3%.

3. **All production outcomes match the recommendation.** Only 14 of 92 outcomes have token evidence for the reported pair. Manual reports provide all outcome values; zero test or build signals appear in production data.

4. **The threshold is not a hard safety gate.** When no pair meets n≥5 and estimate≥0.8, the rule chooses the best estimate anyway. The threshold change from 0.8 to 0.9 alters zero historical picks at n≥5 with default pooling.

## Key findings

### Strongest pair cost tradeoffs

Within the easy-difficulty subset, sonnet-5-5/low (100% pass, $0.035/pass) and opus-5-5/medium (100% pass, $0.074/pass) both reach the same observed pass rate. At whole-dataset level, sonnet/low is 93.3% ($0.052/pass) versus opus/low at 96.7% ($0.095/pass)—a 3.4 percentage point gap for an 82% cost premium.

On bench2 whole dataset, opus/high reaches 93.8% ($0.328/pass) while sonnet/high reaches 92.2% ($0.174/pass). The 1.6 percentage point gap costs 89% more per pass. Both improvements and costs are subject to sampling uncertainty with n≤64 per pair and repeated-task dependency.

### Effort differences per model

Sonnet's pass rate is flat across efforts on easy (93.3% at all levels). Opus improves from 96.7% (low) to 98.3% (medium), then drops to 95.0% (high).

On bench2, hard-only results show sonnet reaching 72.9% (low), 83.3% (medium), and 89.6% (high). Opus reaches 83.3% (low), 89.6% (medium), and 91.7% (high). These are trends in repeated tasks; row counts do not represent independent problem instances.

High effort does not consistently improve both models or fully justify its cost. Learned routing should weigh per-model effort tradeoffs.

### Easy tasks do not separate models

All easy-task pairs except a few reach >90% pass rate. The easy set cannot rank models. Bench2 better differentiates.

### Token cost of different rules on bench2

Offline empirical replay using recorded pooled probabilities and median tokens, on hard tasks:

| Strategy | Success | Tokens/success | vs. always-most-expensive |
|---|---|---|---|
| Single-pick Spatz rule | 90.3% | 111,675 | 38.7% savings |
| Cascade | 100.0% | 171,985 | Increased cost for higher success |
| Always cheapest | 35.5% | 279,535 | —|

On medium tasks:

| Strategy | Success | Tokens/success | vs. always-most-expensive |
|---|---|---|---|
| Single-pick Spatz rule | 100.0% | 65,851 | 50.4% savings |
| Cascade | 100.0% | 103,349 | Same success, more cost |
| Always cheapest | 37.5% | 165,845 | —|

These are analytic plug-in estimates pooling both model families, not measured completions. Learning from repeated tasks saves 38–50% tokens per success compared to always using the most expensive pair.

## Pitfalls found

1. **Personal skills leak into Codex runs.** Codex uses hook scripts from the host. Presence of personal skills (e.g., `spatz:ponytail`) alters available tools and can change task outcomes.

2. **Router hooks and mod must be off.** Running with enabled router hooks or mod changes which model serves the run, invalidating isolation.

3. **Mod swaps pinned models.** If a mod pin is active, the actual model differs from the recorded model.

4. **Two easy-set tasks have prompt-test mismatches.** The hidden tests checked stated-behavior requirements that the prompt did not disclose: one task required exact error-message wording; another required input-format edge-case handling. These defects caused 0% Codex pass and 43% Claude pass on one task; the other shows similar low pass rates across models. These are confirmed defects; one bench2 task also has a prompt-test mismatch on whitespace and type handling, causing unusual pass-rate variance.

## Limits

- Task sets are small (24 easy and 16 bench2 tasks). Bench2 has 12 hard and 4 medium tasks.
- Repeated completions reuse the same tasks; row counts are not independent problem instances.
- Codex coverage is incomplete; easy set 621 runs vs. Claude 717; bench2 239 runs vs. Claude 384.
- Codex has no recorded USD cost; cost comparisons use token estimates only.
- Measurement took one day, a snapshot of one workload with no non-code task types.
- Production data: 92 manual reports (zero test/build signals), 47 missing outcomes, coverage 66.2%.
- Wilson intervals treat rows as independent; task clustering and repeat dependency are not modeled.
- Empirical replay assumes pooled independent outcomes and median-token costs across families.
- Synthetic experiments use separate error assumptions: cascade simulator (1% false acceptance, 2% false rejection); policy simulator (10% false pass, 5% false fail).

## How to reproduce

To run the benchmark suite:

1. **Isolation setup.** Claude: use `env -i` preserving `HOME` and `PATH`, with `claude -p --safe-mode`. Codex: use `env -i` with temporary `HOME` and `CODEX_HOME`, filtering `GIT_*` and `CODEX_*`.
2. **Execute.** Run each task 4–5 times per model × effort pair. Record wall time, token counts, and pass/fail result.
3. **Exclude contaminated runs.** Remove attempts from sessions with leaked tools or active hooks/mod.

To implement the learned rule:

1. Collect outcomes (model, effort, result, task type, difficulty) with clear attempt attribution.
2. Compute per-cell estimates: estimate = (1 + sum of quality) / (2 + n), where quality ∈ [0, 1].
3. For each task, apply the rule from [recommendation.md#decision-order](recommendation.md#decision-order): cheapest pair with n≥5 and estimate≥0.8. If none qualify, use the highest estimate among n≥5.
4. Compare against always using the most expensive pair to measure token savings.

The measurement suite and research code are private. This study is descriptive replay; it does not establish end-to-end production quality or USD savings guarantees.
