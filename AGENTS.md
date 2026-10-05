# Agent Instructions

## Package Manager
- Use **Bun 1.4**: `bun install`. Never npm, pnpm, yarn or Node tooling.
- Prefer Bun APIs: `bun:sqlite`, `Bun.file`, `Bun.$`, `Bun.semver`. Add no dependency for what Bun covers.

## Commands
| Task | Command |
|------|---------|
| Test one file | `HOME=$(mktemp -d) bun test path/to/file.test.ts` |
| All tests | `bun test` |
| Typecheck | `bun run typecheck` |
| Lint / fix | `bun run lint` / `bun run format` |
| Run the CLI | `bun packages/cli/src/cli.ts "<task>" --dry-run --json` |
| Validate plugins | `claude plugin validate .` |
| Mod tests | `claude plugin test packages/claude-mod` |
| Regenerate plugin skills + launchers | `bun scripts/plugin-assets.ts` |
| Update harness catalog | `bun scripts/harness-catalog.ts` |

## Safety
- Never read or write the real `~/.spatz` from tests or ad-hoc runs: set `HOME` to a temp dir.
- End-to-end and report tests need the DuckDB extension: copy `~/.spatz/duckdb-extensions` into the temp `HOME/.spatz/` (read-only use).
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
- Schema changes: append to `MIGRATIONS` in `packages/core/src/store/index.ts`, one SQL statement per entry (`bun:sqlite` `run()` skips errors in multi-statement strings).
- Every user-visible change updates `docs/*.md` (keep the frontmatter: `title`, `description`, `tags`, `keywords`) and `README.md` when it affects the quickstart.
- Workflows: pin actions to full SHAs, no `${{ }}` inside `run:`, least-privilege `permissions`.
- Feature PRs carry no version bump; releases follow `RELEASING.md`.

## Commits and PRs
- Conventional Commits, imperative, lower case, no period.
- No AI attribution, generated-by lines or `Co-Authored-By` trailers.
- Changes reach `main` and `release/*` only through pull requests.

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
