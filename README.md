# spatz

spatz recommends a model and effort for a coding task. The motto is "nicht mit Kanonen auf Spatzen schießen": do not use the strongest model when a cheaper one is good enough.

spatz classifies the task with Jev (TypeSafe), ranks the candidates that you pass, and learns success rates from Claude Code hooks and explicit reports. spatz does not run tasks and does not switch models. You or your agent pick the model.

```
packages/
  core/  @spatz/core  library: classify, catalog, recommend, signals, store, report, api
  cli/   @spatz/cli   thin CLI, bin "spatz", calls @spatz/core only
```

## Install

Requirements: Bun 1.4.

```bash
bun install
```

Put `spatz` on your `PATH` with a small wrapper. Hooks run in a non-interactive shell, so a shell alias is not sufficient.

```bash
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec bun "%s/packages/cli/src/cli.ts" "$@"\n' "$PWD" > ~/.local/bin/spatz
chmod +x ~/.local/bin/spatz
```

Optional environment variables:

| Variable | Effect |
| --- | --- |
| `TYPESAFE_AI_API_KEY` | Enables Jev classification. Without it, spatz uses the keyword rules. |
| `SPATZ_NO_JEV=1` | Opt-out: never send the task text to Jev. |
| `OPENROUTER_API_KEY` | Sent with the OpenRouter model-list request when set. |

A project can also opt out of Jev with `.spatz.json` in the working directory: `{"jev": false}`.

## Commands

Every command accepts `--json` for machine-readable output.

```bash
# Recommendation. --models lists the pairs you can use: <id>[:<effort>+<effort>...],...
spatz "Fix the off-by-one error in src/list.ts" --models claude-opus-5-5:high+medium,claude-sonnet-5-5:medium+low
spatz "<task>" --models gpt-6-sol --json        # no efforts: low, medium, high (as listed by OpenRouter)
spatz "<task>" --models gpt-6-sol --dry-run     # is_test: never counts for learning or stats

# Report the pair you used and the result. A report overrides all hook signals.
spatz report <suggestion_id> --model claude-sonnet-5-5 --effort medium --result pass|partial|fail [--rounds 2] [--note "..."]

# Hook entry point: reads the hook JSON from stdin. Always exits 0 and prints nothing.
spatz hook <event>

# Evaluation per task_type: n, success rate per pair, adoption rate, tokens, coverage.
spatz stats [--type code.bugfix]
```

Exit codes: 0 success, 1 runtime error (for example an unknown suggestion_id), 2 usage error. `spatz hook` always exits 0.

The text output of a recommendation starts with `suggestion_id: <id>`. The hooks use this line to link the session to the recommendation.

Model IDs: `claude-opus-5-5` becomes `anthropic/claude-opus-5.5`, and `gpt-6-sol` becomes `openai/gpt-6-sol`. IDs that contain `/` are used as given. `~/.spatz/aliases.json` (`{"<id>": "<openrouter id>"}`) overrides the rule. `~/.spatz/descriptions.json` (`{"<openrouter id>": "<short text>"}`) gives Jev a description per model.

## Claude Code hooks

The snippet below is documentation only. Copy it into `.claude/settings.json` of a project if you want spatz to collect signals there. The hooks store only derived signals, model names, efforts and token counts. They never store prompt text or tool output.

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

What each hook records:

| Hook | Records |
| --- | --- |
| `PostToolUse` on Bash with a `spatz "<task>"` call | Links session_id and prompt_id to the suggestion_id in the output |
| `PostToolUse` / `PostToolUseFailure` on Bash | Test or build signal (success 1, failure 0) |
| `PostToolUse` on Agent | Model of the subagent (`resolvedModel`) |
| `Stop` | Model and tokens of the main session for the turn, from the transcript |
| `SubagentStop` | Model and tokens of the subagent, from its transcript |

Signals go to the open recommendation of the session. A recommendation stays open until the next spatz call of the same session, a `spatz report` for it, or 2 hours without events.

## Data

- Database: `~/.spatz/spatz.db` (SQLite, WAL). spatz migrates the schema on start.
- OpenRouter model list cache: `~/.spatz/openrouter-models.json` (24 h; a stale cache is used when the fetch fails).
- DuckDB extensions for `spatz stats`: `~/.spatz/duckdb-extensions`. The first `spatz stats` downloads the sqlite extension; later runs work offline.
- Optional files: `~/.spatz/aliases.json`, `~/.spatz/descriptions.json`.

To reset all learned data, delete `~/.spatz/spatz.db`.

## Privacy

- Only the task text of `spatz "<task>"` goes to TypeSafe (Jev). spatz does not store the task text.
- A local filter checks the task text for secrets (API keys, private keys, `password=`). When it finds one, spatz uses the keyword rules and sends nothing.
- `SPATZ_NO_JEV=1` or `.spatz.json` with `{"jev": false}` turns Jev off.
- The OpenRouter request sends no task data.
- Hooks store no prompt text and no tool output, only derived signals, model, effort and token counts.
- spatz never logs API keys.

## Development

```bash
bun test             # all tests, including end-to-end tests that spawn the CLI
bun run lint         # biome check
bun run format       # biome check --write
bun run typecheck    # tsc --noEmit
```

Unit tests make no network calls. The end-to-end tests in `packages/cli/src/e2e.test.ts` use a temporary HOME, a pre-filled OpenRouter cache, Jev disabled, and the pre-installed DuckDB sqlite extension from `~/.spatz/duckdb-extensions` (or `SPATZ_DUCKDB_EXTENSION_DIR`).

Git hooks: pre-commit runs Biome on staged files, pre-push runs `bun test`.

## TDD loop

1. Write a failing test in `<module>/*.test.ts` next to the code.
2. Run `bun test --watch` and see it fail (red).
3. Write the minimum code to make it pass (green).
4. Clean up while the tests stay green (refactor).
