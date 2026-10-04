---
title: Claude Code hooks for spatz
description: How to connect spatz to Claude Code hooks, which hook events give which signals and token usage, how a suggestion links to a session, and the limits of the hooks.
tags: [hooks, claude-code, signals, spatz]
keywords: [settings.json, PostToolUse, PostToolUseFailure, Stop, SubagentStop, test detection, build detection, rtk, subagent, time window, session, async]
---

# Claude Code hooks for spatz

spatz learns which pair of model and effort succeeds. It needs results for that. Claude Code hooks give spatz these results without extra work from the agent: test and build results, and the models and tokens the session used. `spatz report` gives an explicit result. A report wins over all hook signals.

The hooks never block a session. `spatz hook` always exits with code 0, prints nothing and ignores all errors. The snippet below also runs each hook with `"async": true`, so Claude Code does not wait for it.

spatz supports only Claude Code. For the command reference see [cli.md](cli.md).

## Install the hooks

1. Make sure that `spatz` is on the `PATH` of a non-interactive shell. A shell alias is not enough. The [README](../README.md) shows a small wrapper script.
2. Select the settings file:
   - `~/.claude/settings.json` collects signals in all projects.
   - `<project>/.claude/settings.json` collects signals in one project.
3. Read the snippet below. Then merge it into the `hooks` key of that file.

```json
{
	"hooks": {
		"PostToolUse": [
			{
				"matcher": "Bash|Agent",
				"hooks": [{ "type": "command", "command": "spatz hook PostToolUse", "async": true }]
			}
		],
		"PostToolUseFailure": [
			{
				"matcher": "Bash",
				"hooks": [{ "type": "command", "command": "spatz hook PostToolUseFailure", "async": true }]
			}
		],
		"Stop": [
			{ "hooks": [{ "type": "command", "command": "spatz hook Stop", "async": true }] }
		],
		"SubagentStop": [
			{ "hooks": [{ "type": "command", "command": "spatz hook SubagentStop", "async": true }] }
		]
	}
}
```

spatz handles these four events. Other events do no harm, but they give no signal.

## What each event records

| Event | Condition | Records |
| --- | --- | --- |
| `PostToolUse` | Bash command is a spatz suggestion call | Links the session to the suggestion. See [Link a suggestion to a session](#link-a-suggestion-to-a-session). |
| `PostToolUse` | Bash command is a test or a build | Signal `test` or `build` with value 1 (success). |
| `PostToolUseFailure` | Bash command is a test or a build | Signal `test` or `build` with value 0 (failure). |
| `PostToolUse` | Tool is `Agent` | The subagent model from `tool_response.resolvedModel`, with 0 tokens and no effort. |
| `Stop` | Event has a `prompt_id` | Model, effort and tokens of the main session for this turn, read from the transcript. |
| `SubagentStop` | Always | Model, effort and tokens of the subagent, read from the subagent transcript. |

spatz ignores the `SubagentHandback` tool event and the second `UserPromptSubmit` that a subagent handback starts.

Signal weights: `test` 1.0, `build` 0.8, `report` 1.0. Without a report, spatz takes the newest value per signal kind. The quality is the weighted mean over the kinds. Without any signal, the suggestion has no outcome. Token usage alone does not make an outcome.

The hooks store no prompt text and no tool output. They store signals, model ids, efforts and token counts. See [privacy.md](privacy.md).

## Test and build detection

spatz reads the Bash command with regular expressions. It is not a shell parser.

| Kind | Commands |
| --- | --- |
| `test` | `bun test`, `npm test`, `pnpm test`, `yarn test`, the same with `run test`, `pytest`, `go test`, `cargo test`, `vitest`, `jest` |
| `build` | `bun build`, `npm build`, `pnpm build`, `yarn build`, the same with `run build`, `tsc`, `go build`, `cargo build`, `make` |

Rules:

- The command counts only when its exit status is the status of the test or build.
- In an `&&` chain, only the last segment counts. All segments before it must be `cd`, `pushd` or `export`.
- A pipe, `||`, `;`, `&`, a newline, backticks or `$(...)` make the status unclear. spatz then records no signal.
- spatz skips these prefixes before the command: `VAR=value` assignments, `rtk`, `rtk proxy`, `time`, `npx`, `bunx`, `pnpx`, `uv run`, `poetry run`, `python -m`, `python3 -m`.
- Text in quotes is an argument, never a command. spatz ignores redirections like `2>&1`.

| Command | Result |
| --- | --- |
| `bun test` | test |
| `rtk bun test` | test (the RTK hook rewrites `bun test` to this) |
| `cd pkg && bun test` | test |
| `rtk proxy npx vitest run` | test |
| `make` | build |
| `npm run build && bun test` | none: `npm run build` is not a setup segment |
| `bun test 2>&1 \| tail` | none: the pipe hides the status |
| `bun test; echo done` | none |

## Link a suggestion to a session

spatz does not know the Claude Code session when it makes a suggestion. The `PostToolUse` hook makes the link.

1. The agent runs `spatz "<task>" --models <list>` with the Bash tool.
2. The `PostToolUse` hook sees a Bash command whose segment starts with `spatz` or `<path>/spatz`. The first argument is not `report`, `hook` or `stats`.
3. spatz reads the suggestion id from the output. Text output gives the line `suggestion_id: <uuid>`. JSON output gives the field `"suggestion_id"`.
4. spatz stores `session_id` and `prompt_id` with the suggestion.

From then on, signals and token usage of this session go to this suggestion.

```mermaid
sequenceDiagram
    participant A as Agent (Claude Code)
    participant S as spatz CLI
    participant H as spatz hook
    participant D as ~/.spatz/spatz.db
    A->>S: spatz "<task>" --models ...
    S->>D: store suggestion (no session yet)
    S-->>A: suggestion_id: <uuid>, ranking
    A-->>H: PostToolUse (Bash, stdout with id)
    H->>D: link session_id and prompt_id
    A-->>H: PostToolUse / PostToolUseFailure (bun test)
    H->>D: signal test = 1 or 0
    A-->>H: Stop, SubagentStop
    H->>D: model, effort, tokens per window
    A->>S: spatz report <id> --model ... --result pass
    S->>D: report signal, close suggestion
```

The link works only when the command starts with `spatz` or a path that ends in `/spatz`. These calls are not linked:

- `SPATZ_NO_JEV=1 spatz "<task>" ...` (an environment assignment before `spatz`)
- `bunx spatz "<task>" ...`
- `bun packages/cli/src/cli.ts "<task>" ...`

### What the agent does

1. Run `spatz "<task>" --models <the pairs you can use>`.
2. Use `ranking[0]`. spatz does not switch the model. The agent starts a subagent with that model and effort, or the user switches.
3. Do the task. Run tests and builds as plain commands, so the hooks can read the result.
4. At the end, run `spatz report <suggestion_id> --model <m> --effort <e> --result pass|partial|fail`.

## Time windows

A suggestion is open from its creation until the first of these events:

- `spatz report` for this suggestion.
- The next linked spatz suggestion in the same session. The old suggestion ends where the new one starts.
- 2 hours without a hook event in the session. Each hook event of the session resets this time.

Signals go to the open suggestion of the session. Token usage goes to the suggestion whose window holds the time stamp of each transcript message. Messages before the first suggestion of the session count for no suggestion.

Hooks run async, so the link can arrive after `Stop` or `SubagentStop`. In that case spatz reads the transcripts again and puts each message in the correct window. A replayed or older transcript snapshot does not overwrite newer data.

## Subagents

spatz counts a subagent as its own usage.

- `SubagentStop` reads `<session>/subagents/agent-<agent_id>.jsonl`. spatz sums the tokens per model.
- `PostToolUse` on the `Agent` tool records the subagent model from `resolvedModel`. This record has 0 tokens and no effort, because the `effort.level` in this event belongs to the main session.

Without a report, the used pair is the model with the most output tokens over the main session and all subagents. Its effort is the newest effort that a hook gave for that model. A report always sets the used pair.

## Limits

- Only Claude Code. Other agents can still use `spatz "<task>"` and `spatz report`.
- A hook cannot set the model or the effort. spatz only recommends.
- Test and build detection is a set of keyword patterns. It misses tools that are not in the list, and it skips commands with an unclear status.
- `Stop` fires once per turn, not once per task.
- Claude Code gives the main session model only in the transcript, not in the hook input.
- `UserPromptSubmit` and `SubagentStart` have no `effort.level`.
- spatz does not use `SessionEnd`.
