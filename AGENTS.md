# Agent Instructions

## Package Manager
- Use **Bun 1.4**: `bun install`. Never npm, pnpm or yarn for dependencies and development commands (release workflows use npm on purpose).
- Prefer Bun APIs: `bun:sqlite`, `Bun.file`, `Bun.$`, `Bun.semver`. Add no dependency for what Bun covers.

## Commands
| Task | Command |
|------|---------|
| Test one file | `SPATZ_DUCKDB_EXTENSION_DIR=~/.spatz/duckdb-extensions HOME=$(mktemp -d) bun test path/to/file.test.ts` |
| All tests | `SPATZ_DUCKDB_EXTENSION_DIR=~/.spatz/duckdb-extensions HOME=$(mktemp -d) bun test` |
| Typecheck | `bun run typecheck` |
| Lint / fix | `bun run lint` / `bun run format` |
| Run the CLI | `HOME=$(mktemp -d) SPATZ_NO_JEV=1 bun packages/cli/src/cli.ts "<task>" --dry-run --json` |
| Validate plugins | `claude plugin validate .` |
| Mod tests | `claude plugin test packages/claude-mod` |
| Regenerate plugin skills + launchers | `bun scripts/plugin-assets.ts` |
| Update harness catalog | `bun scripts/harness-catalog.ts` |

## Safety
- Never write to the real `~/.spatz` from tests or ad-hoc runs (even `--dry-run` stores a suggestion): set `HOME` to a temp dir.
- Exception: tests may read an existing DuckDB extension from `~/.spatz/duckdb-extensions` via `SPATZ_DUCKDB_EXTENSION_DIR`.
- Without it, bootstrap in a temp home and point at that: `B=$(mktemp -d); HOME=$B bun packages/cli/src/cli.ts setup --models claude-sonnet-5-5 --dry-run; HOME=$B bun packages/cli/src/cli.ts stats; export SPATZ_DUCKDB_EXTENSION_DIR=$B/.spatz/duckdb-extensions`.
- Set `SPATZ_NO_JEV=1` and `SPATZ_NO_NETWORK=1` for offline runs.
- Never touch `~/.claude` or `~/.codex`; use a temp `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.

## Code Layout
- Domain logic goes in `packages/core`; `packages/cli` only parses, calls core and formats.
- Plugins: `packages/claude-hooks` (`spatz`), `packages/claude-mod` (`spatz-mod`), `packages/codex-hooks` (Codex `spatz`).
- Tests live next to the code as `*.test.ts`; write the failing test first.

## Generated Files — do not edit by hand
- Plugin skill copies and `packages/*/bin/spatz`: edit `skills/routing/SKILL.md` and `scripts/plugin-assets.ts`, then regenerate.
- Versions in manifests and marketplaces: only via `bun scripts/release-version.ts`, only in release PRs.
- `catalog/harness-models.json`: produced by `scripts/harness-catalog.ts` and the daily workflow.

## Key Conventions
- Schema changes: add one `MIGRATIONS` entry per schema version in `packages/core/src/store/index.ts`, as an array of single SQL statements (`bun:sqlite` `run()` skips errors in multi-statement strings).
- Every user-visible change updates `docs/*.md` (keep the frontmatter: `title`, `description`, `tags`, `keywords`) and `README.md` when it affects the quickstart.
- Workflows: pin actions to full SHAs, no `${{ }}` inside `run:`, least-privilege `permissions`.
- Feature PRs carry no version bump; releases follow `RELEASING.md`.

## Commits and PRs
- Conventional Commits, imperative, lower case, no period.
- No AI attribution, generated-by lines or `Co-Authored-By` trailers.
- Changes reach `main` and `release/*` only through pull requests.

## Working on an Issue
- Branch as `<prefix>/<issue>-<slug>` (e.g. `feat/42-store-cache`) and put `Closes #<issue>` in the PR body.
- The "spatz dev board" Status then updates itself (`.github/workflows/board-status.yml`); do not set it by hand while that works.
- If the workflow cannot run (no `BOARD_TOKEN` secret, fork PR, actor without write access), run the managing-spatz-projects board-sync instead.

## External References
| Need | File |
|------|------|
| Setup, gates, TDD | `CONTRIBUTING.md` |
| Release strategy and process | `RELEASING.md` |
| Security policy | `SECURITY.md` |
| CLI reference | `docs/cli.md` |
| Settings and env vars | `docs/configuration.md` |
| Recommendation logic | `docs/recommendation.md` |
| Architecture and data flow | `docs/how-it-works.md` |
| Hooks and mod | `docs/hooks.md`, `docs/claude-mod.md` |
