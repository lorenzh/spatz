---
title: The spatz Claude Code mod
description: How the spatz mod for Claude Code recommends and applies model and effort, the five routing scopes with their trade-offs, the /spatz commands, all config keys with defaults, fail-open behaviour, usage recording and privacy.
tags: [claude-mod, claude-code, routing, spatz]
keywords: [dispatch, dispatches, requested_model, swapped, mod, plugin, scope, step, turn, subagent, session, escalate, apply, show, off, /spatz, record, spatz, main, prompt cache, fail open, userConfig, alias, effort, model switch]
---

# The spatz Claude Code mod

The `spatz-mod` plugin is the Claude Code mod in `packages/claude-mod`.
It asks the `spatz` CLI for a recommendation.
In `show` mode it shows the recommendation. In `apply` mode it also changes model and effort.
The mod needs Claude Code 2.1.287 or newer.
Its `spatz` executable option uses the plugin's `bin/spatz` launcher by default.
Set the option only to use a custom executable. The launcher needs Node.js (npx) or Bun.
See [installation](installation.md) for cache warm-up and update limits.

The mod runs the CLI through its bundled launcher, so a separate install is optional (see the [installation guide](installation.md)). The first call downloads about 60 MB; warm it once with `sh "<plugin root>/bin/spatz" --version`. Then run these commands in Claude Code:

```text
/plugin marketplace add lorenzh/spatz
/plugin install spatz-mod@spatz
```

For local development, use `claude --plugin-dir packages/claude-mod`.
The plugin name is `spatz-mod`. The workspace package remains `@spatz/claude-mod`.

The mod never edits a prompt. It stores no task text. [hooks.md](hooks.md) describes the other way to feed spatz: the settings hooks, which only observe.

## Modes

| Mode | What the mod does |
| --- | --- |
| `off` | Nothing. The mod makes no call. |
| `show` (default) | It asks spatz and shows the last recommendation with its scope in the status line under the prompt. It changes nothing. |
| `apply` | It also sets the model and effort. Subagents are rewritten by default. The main session is rewritten only when `main` is on. |

spatz stores every suggestion with its scope. `spatz stats --by scope` compares the scopes ([cli.md](cli.md)).

The CLI uses English difficulty values: `easy`, `medium` and `hard`.
The mod accepts responses from older clients with German difficulty values.
See [database migrations](how-it-works.md#migrations) for the v4 conversion.

## Routing scopes

One setting picks when spatz decides. The default is `subagent`. Every scope works with every mode.

| Scope | spatz decides | The mod rewrites | Trade-offs |
| --- | --- | --- | --- |
| `step` | At every model request of the main session and of subagents, before the request starts. | Model and effort of that request. | Costs the most latency: one spatz call per request. The model can change inside a turn, so the prompt cache breaks often. Use it for experiments. |
| `turn` | At the start of each user turn in the main session. | Every main-session request of that turn. | One call per turn. A switch between turns breaks the cache once. Subagents are not touched. |
| `subagent` | When the Agent tool starts a subagent, from the brief. | The model at spawn, and model and effort on every request of that subagent. | Adds latency only when an agent starts. The main session keeps its cache. Forks are skipped, because a fork inherits the parent model. |
| `session` | At the first turn of the session. | Every main-session request of the session. | One call in total. The decision cannot follow a change of task. Subagents are not touched. |
| `escalate` | Like `turn` for the main session and like `subagent` for subagents. | The same, plus a switch to the next stronger pair after repeated failures. | The only scope that steps up because of failures. `step` can also change the pair inside a turn, but it decides each request anew. |

How the pieces work:

- `turn` and `escalate` skip a prompt shorter than `minPromptChars` (20 characters). The turn then uses the last decision.
- `session` decides at the first turn that has text. Later turns of the main session reuse that decision. The mod does not rewrite subagent requests in this scope.
- `escalate` counts failing Bash results of test or build commands in the same turn or agent run. A failure is a Bash result that reports an error. After `escalateAfter` failures (2), the pair moves one step up. The mod keeps the new pair for the rest of that turn or run. The counter starts again after each switch.
- With explicit `models`, the ladder names the strongest model first. Efforts ascend through `max`.
  With empty `models`, the CLI supplies the resolved candidates in cost order.
  If the current pair is at the top or absent from the ladder, nothing changes.
  Older CLIs without a candidate ladder need explicit `models` for escalation.
- For a subagent, the agent id exists only after the spawn. The mod asks spatz without session or agent id. After the spawn it calls `spatz link` with the real agent id and the session ([cli.md](cli.md)). Until then the suggestion is in no session window. If the link fails, the mod still routes, but the suggestion has no agent id. Step and escalation use the real agent id from the start.

## What the mod rewrites

The Agent tool accepts only the aliases `sonnet`, `opus`, `haiku` and `fable` as model. At spawn the mod passes the alias that resolves to the chosen model. The table is fixed in the code. If the chosen model has no alias, the spawn stays unchanged. The model and effort are then set on each request of the agent. Requests accept full model ids.

The mod rewrites only agents it routed. Step and escalation changes apply to an agent only when the mod decided for it at spawn (or, in the `step` scope, did not skip it as pinned). A spawn with an explicit `model` or a named agent type stays as the caller chose ([`respectPinned`](#config-keys)).

Switching the model drops the prompt cache. This is why the main session needs its own setting.

## /spatz commands

| Command | Effect |
| --- | --- |
| `/spatz` or `/spatz status` | Shows mode, scope, main, record and the last decision. |
| `/spatz mode <off\|show\|apply>` | Sets the mode for this session. |
| `/spatz scope <step\|turn\|subagent\|session\|escalate>` | Sets the routing scope for this session. |
| `/spatz record <auto\|on\|off>` | Sets usage recording. |
| `/spatz main <on\|off>` | Allows or forbids main-session rewrites in apply mode. |

Changes last until the session ends. A wrong argument prints the usage line and changes nothing.

## Config keys

Set them as plugin options (`userConfig`). The `/spatz` commands override the first five per session.

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `show` | `off`, `show` or `apply`. |
| `scope` | `subagent` | The routing scope. |
| `main` | `false` | Rewrite the main session in apply mode. |
| `record` | `auto` | Usage recording, see below. |
| `minPromptChars` | `20` | Shortest prompt that gets a new decision in `turn` and `escalate`. |
| `escalateAfter` | `2` | Failing test or build results before `escalate` switches. |
| `respectPinned` | `true` | Do not route a subagent spawn that sets a `model` or names an agent type other than `general-purpose`, and leave all its requests alone. The hook cannot see whether an agent definition pins a model, so every named type counts as pinned. Set `false` to route those spawns too. |
| `exploreHard` | `false` | Allow [exploration](recommendation.md#exploration) picks on `hard` or critical tasks. By default the mod ignores such a pick and leaves the request unchanged. |
| `spatz` | `spatz` | The CLI executable. The default runs the plugin's launcher (`sh <plugin root>/bin/spatz`); any other value is used as is. |
| `models` | Empty | Use CLI defaults. A non-empty list overrides them, strongest model first. |

An unknown value falls back to its default.

Empty `models` omits `--models`. The CLI checks `SPATZ_MODELS`, then project and user config, then the Claude Code catalog preset.
The preset includes every enabled first-party model in the main picker, with its catalog efforts, including `none`, `xhigh` and `max`.
For `none`, the mod sets only the model. It leaves effort untouched in `agent.spawn` and `turn.step`.
Haiku uses `none`. When the catalog lists only `none`, spatz records missing usage effort as `none`.
Learning also counts older null-effort outcomes for these models. Other models keep unknown effort as `null`.
Escalation can move from a `none` model to a reasoning model with an explicit effort.
Claude Code has no `ultra`: the mod rejects an `ultra` recommendation and excludes it from escalation.
Critical tasks and cold start choose the most expensive pair, currently `claude-fable-5-1:max`.
To narrow candidates, set the mod option, config `models`, or `SPATZ_MODELS`.
For example: `claude-opus-5-5:high,claude-sonnet-5-5:low+medium+high`.
See [model defaults](configuration.md#harness-catalog) for cache and offline behavior.

## Dispatch tracking

Every mod suggestion includes `--requested <model|->`.
The model is the original spawn model before routing. `-` means that the caller supplied no model.
Named agents also send `--requested-agent <type>` so core can read the definition's `model:` when no explicit model is supplied.
Step routing keeps both original values for the agent's later requests.
Main-session suggestions use `-` because turn-start events carry no model request.

Once the agent exists, `spatz link` merges its suggestion into the dispatch row.
The key is the session id plus agent id.
The Agent hook adds the requested agent type and answering model.
A mod usage observation can also supply the answering model.
Each field keeps its first known value.
The CLI normalizes model ids and known Claude aliases before comparison.

`spatz stats` shows dispatch, mod-suggestion and model-swap counts.
This includes observed pinned spawns that the mod leaves unchanged.
The core resolver reads named agent definitions in project and user agent directories.
See [dispatch counts](cli.md#dispatch-counts) for the exact rules.

## Recording usage

After each request and at the end of each turn, the mod can call `spatz usage` with the token counts and the model that answered. It keys them by turn. The end-of-turn call holds the sum of the turn and replaces the last request's figures. The model is the one of the last response. A turn with several models is not split by model. The `step` scope records each request against its own suggestion. A turn or agent run that has no usage in its result records nothing.

`record` has three values:

- `on`: always record.
- `off`: never record.
- `auto` (default): always record routed subagents. For main-session usage, let an enabled hooks plugin record instead.

For main-session `auto`, the mod runs `claude plugin list --json` once per session.
It checks for an enabled plugin whose id starts with `spatz@` or the legacy `spatz-hooks@`.
The mod's id, `spatz-mod@spatz`, does not turn recording off.
When the hooks plugin is enabled, the mod shows one notice that hooks own main-session usage.
If the lookup fails, the mod records. The mod records usage only, without outcomes.
Subagent transcript output counts are unreliable ([#86](https://github.com/lorenzh/spatz/issues/86)).
The mod's counters replace hook usage for the same session and agent.
Later hook replays cannot add that usage again. Signals remain available from hooks.
With `record: off`, hooks keep their lower-bound subagent estimates.
The replacement uses agent identity. It never assumes that mod `turnId` equals hook `prompt_id`.

Hand-written hooks and `--plugin-dir` hooks are not installed plugins.
With manual hooks and main-session routing, set `record: off` to avoid duplicate main usage.
With subagent-only routing, `auto` keeps the more complete mod counters.

## Fail-open behaviour

The mod never blocks a request.

- A missing `spatz`, a non-zero exit, invalid JSON or an unsupported model leaves the request unchanged.
- The recommendation call stops after 6 seconds. A `spatz usage` call stops after 2 seconds. The check for `spatz` stops after 3 seconds.
- A denied spawn, or a spawn result without an agent id, creates no link to an agent. A failed `spatz link` call (2 seconds) changes nothing else.
- If the decision for a request fails with an error, the mod logs one debug line and sends the request unchanged.
- Each hook passes the event on exactly once.

## Privacy

For each decision the mod passes the task text to `spatz` as a command-line argument: the user prompt for the main session, the brief for a subagent. spatz does not store it. If Jev is on, spatz sends the text to TypeSafe AI, as for any call ([privacy.md](privacy.md)). The mod itself holds the text in memory only: for the `step` scope until the turn or run ends, in the other scopes only during the call. It never edits a prompt.
