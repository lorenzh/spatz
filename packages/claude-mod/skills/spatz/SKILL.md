---
name: spatz
description: Spatz model and effort selection. Use when an agent is about to dispatch a subagent, delegate a task, run codex exec, choose a model or effort, or verify or review another agent's work. Applies to Claude Code subagents, Codex, and other coding harnesses.
---

# Spatz

**Before every dispatch you route yourself, get a fresh ranking and use its first pair.** Task size, urgency, and a previous ranking do not replace this call.

When the spatz Claude Code mod is installed (the `spatz:spatz` skill is available or the `/spatz` command exists), do not call spatz for Claude Code subagents; the mod routes them. Still use spatz for other dispatches, such as Codex runs or other harnesses, and report outcomes as usual.

## Run the CLI

Use `spatz` when it is on PATH. Otherwise use this plugin's `bin/spatz`, resolved from the installed skill directory as `../../bin/spatz`. Quote the absolute launcher path. It tries PATH, then Bun, then npx.

If the launcher is unavailable, use `npx -y @spatz/cli@<version>`. Read `<version>` from the plugin's `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`. Use the same executable for suggestions and reports. The first download is about 60 MB. Warm the plugin's pinned CLI by running `"<plugin root>/bin/spatz" --version` once. Codex stores plugins under `~/.codex/plugins/cache/`; Claude's plugin path is shown by `/plugin` and is usually under `~/.claude/plugins/`. Codex hooks time out after 10 seconds.

## Select and dispatch

1. List only model and effort pairs that this harness can actually dispatch. Use `<model>:<effort>+<effort>,<model>:<effort>` syntax. For verification or review, include only the other model family: Claude after GPT, GPT after Claude. If no such model is available, disclose that independent review is unavailable.

   Done when the candidate list matches available dispatch controls and the review family constraint.

2. Write one task sentence without secrets or customer data. The sentence is sent to TypeSafe AI for classification. Run this command through the shell tool before the dispatch:

   ```sh
   spatz "<the task in one sentence>" --models <available model:effort pairs> --json
   ```

   Keep stdout unfiltered: hooks read `suggestion_id` from it. Add `--dry-run` when testing spatz itself, so tests do not count for learning. If spatz exits non-zero or returns no ranking, continue with the harness default and disclose the failure in one line. For a review, also disclose when this fallback cannot supply the other family.

   Done when the full output contains a ranking and suggestion ID, or the fallback is disclosed.

3. Dispatch `ranking[0]` at its selected effort through the harness's dispatch tool. Show the choice in this format:

   ```text
   spatz: <model> [<effort>] (<strategy>, n=<n>) · <suggestion_id>
   ```

   Take `strategy` from the response and `n` from the selected ranking entry. Require the agent to report the model actually answering. Check available runtime evidence against the pick. If the selected model is unavailable, say so and stop that dispatch. Do not silently substitute another pair or claim an independent review.

   Done when the dispatch uses the selected pair and its answering model is recorded, or its unavailability is disclosed.

## Report after verification

Run the report for the suggestion whose work was verified. Record the model and effort that actually performed that work:

```sh
spatz report <suggestion_id> --model <model used> --effort <effort used> --result pass|partial|fail
```

Choose `pass` for complete success, `partial` for incomplete success, and `fail` for failed verification. Report a separately routed review under its own suggestion ID. If routing failed before creating a suggestion, there is no ID to report. If reporting fails, disclose it.
