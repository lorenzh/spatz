# poc-model-suggestion

Bun workspace monorepo.

```
packages/
  package-a/  @poc/package-a  add(a, b)
  package-b/  @poc/package-b  sum(numbers), uses package-a
  cli-c/      @poc/cli-c      CLI that sums its arguments, uses package-b
```

## Commands

```bash
bun install          # install deps and git hooks (lefthook)
bun test             # run all tests
bun run lint         # biome check
bun run format       # biome check --write
bun run typecheck    # tsc --noEmit
bun packages/cli-c/src/cli.ts 1 2 3   # prints 6
```

Git hooks: pre-commit runs Biome on staged files, pre-push runs `bun test`.

## TDD loop

1. Write a failing test in `src/index.test.ts` next to the code.
2. Run `bun test --watch` and see it fail (red).
3. Write the minimum code to make it pass (green).
4. Clean up while the tests stay green (refactor).
