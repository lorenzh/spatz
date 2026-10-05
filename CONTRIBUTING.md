# Contributing to spatz

Thank you for your help. This file tells you how to set up the project, how to make a change and how to propose it.

## Propose a change

- For a small fix, open a pull request.
- For a larger change, open an issue first. Describe the problem and your plan. Wait for an agreement before you write the code. A larger change is a new command, a new flag, a schema change or a new dependency.
- For a security problem, do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Set up

1. Install Bun 1.4.
2. Clone the repository and install the dependencies.

   ```bash
   git clone https://github.com/lorenzh/spatz.git
   cd spatz
   bun install
   ```

   `bun install` also installs the Lefthook Git hooks.

3. Install the DuckDB sqlite extension. The end-to-end tests need it in `~/.spatz/duckdb-extensions`. `spatz stats` downloads it on the first run, but it needs a database first. Run one `--dry-run` suggestion, then `spatz stats`, with network access:

   ```bash
   bun packages/cli/src/cli.ts "test task" --models claude-sonnet-5-5 --dry-run
   bun packages/cli/src/cli.ts stats
   ```

   If you already have the extension in another folder, copy or link it to `~/.spatz/duckdb-extensions`. The test suites also read `SPATZ_DUCKDB_EXTENSION_DIR`. The CLI does not read this variable.

4. Run the gates to make sure that the setup works.

## Gates

Every change must pass all three gates.

| Command | What it checks |
| --- | --- |
| `bun test` | All tests, including the end-to-end tests in `packages/cli/src/e2e.test.ts`. |
| `bun run typecheck` | TypeScript types (`tsc --noEmit`). |
| `bun run lint` | Biome lint and format rules. `bun run format` fixes what it can. |

Unit tests make no network calls. The end-to-end tests run the CLI with a temporary `HOME`, a pre-filled OpenRouter cache and Jev turned off.

## TDD loop

Write the test before the code.

1. Write a failing test in a `*.test.ts` file next to the code.
2. Run `bun test --watch` and make sure that the test fails.
3. Write the minimum code that makes the test pass.
4. Clean up the code while all tests pass.

A bug fix starts with a test that shows the bug.

## Git hooks

Lefthook runs two Git hooks:

- `pre-commit` runs Biome on the staged files and stages the fixes.
- `pre-push` runs `bun test`.

## Code layout

| Path | Content |
| --- | --- |
| `packages/core` (`@spatz/core`) | All logic: `classify`, `catalog`, `recommend`, `signals`, `store`, `report`, `api`, `contracts`. |
| `packages/cli` (`@spatz/cli`) | The thin CLI. It parses arguments, calls `@spatz/core` and formats the output. |
| `packages/claude-hooks` | Claude Code `spatz` plugin (hooks). |
| `packages/claude-mod` | Claude Code `spatz-mod` plugin (mod). |
| `packages/codex-hooks` | Codex `spatz` plugin (hooks). |
| `scripts/` | Release, npm package and plugin build scripts, with their tests. |
| `skills/routing` | Source of the routing skill. |
| `catalog/harness-models.json` | Generated model catalog. `scripts/harness-catalog.ts` and the daily workflow write it. |

Plugin skill copies and `packages/*/bin/spatz` are generated. Edit `skills/routing/SKILL.md` and `scripts/plugin-assets.ts`, then run `bun scripts/plugin-assets.ts`.

Put new logic in `packages/core`. The CLI contains no domain logic. Each module keeps its tests next to its code.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), as in the Git log:

```text
feat: add the recommendation report to the CLI
fix: <what the fix changes>
docs: <what the docs change>
```

Write the subject in the imperative mood, in lower case, without a period at the end.
