---
title: Attempt identity for outcomes
description: A proposed attempt ledger that preserves retries, binds delayed events, and keeps legacy learning unchanged.
tags: [spatz, data-model, signals, learning]
keywords: [attempt, identity, retry, escalation, outcome, migration, prompt, turn, binding, cost]
---

# Attempt identity for outcomes

Design only for [#34](https://github.com/lorenzh/spatz/issues/34) and [#35](https://github.com/lorenzh/spatz/issues/35). [#41](https://github.com/lorenzh/spatz/issues/41) consumes the cost data.

Schema v4 (and v5, which only added `fallback_reason` and the `failures` table) combines all signals for a suggestion in its [outcomes view](../../packages/core/src/store/index.ts). This design gives each execution its own outcome. Current behavior remains documented in [How spatz works](../how-it-works.md) and [Hooks](../hooks.md).

## Attempts and reports

An attempt is work by one actual model/effort pair toward a result. Each attempt has a UUID, a start key for replay, and an increasing ordinal within its suggestion. `A → B → A` creates three attempts.

`spatz suggest` opens attempt 1 implicitly and its suggestion window. Its actual pair stays null until execution evidence or a report supplies it. The first execution fills this implicit attempt. The recommended pair does not prove execution. A new attempt starts only on explicit start, pair switch, new dispatch, or new work after a report. A report closes the suggestion window as in v4; later work needs a new suggestion. A failed test followed by a fix stays inside the attempt. The latest test/build wins.

Claude hooks and Codex record at turn granularity or coarser. Only the mod splits a turn into step segments. Stop/SubagentStop closes observed execution and finalizes turn evidence without implying success. Same-pair follow-up work keeps the attempt unless a listed boundary applies. A report closes the attempt and suggestion window. Late evidence can still bind to closed attempts.

```text
spatz suggest <task> [--retry-of <suggestion_id>]
spatz report <suggestion_id> --model <m> --effort <e> --result pass|partial|fail
             [--attempt <id>] [--correct]
# Mod only; context also supplies harness, session and agent:
spatz attempt start <suggestion_id> --key <turnId:index> --model <m> --effort <e>
```

The skill propagates suggestion IDs. It needs no start call or attempt ID. The mod registers each segment before execution. Hooks replay dispatch/turn boundaries in source order using stable IDs. Start replay returns the existing attempt. Allocate ordinals and insert bindings in one `IMMEDIATE` transaction.

Report selection also runs in that transaction:

```text
if --attempt: select that attempt; check suggestion ownership and pair
else: select highest ordinal with same model and effort null or equal
      (the unused implicit attempt with null model is also compatible)
if none: create next attempt with reported pair
if --correct: require a prior report; replace its verdict
else if selected report equals this report: return it unchanged
else if selected already has a report: create next attempt; store report
else: fill unknown pair fields; store report
close selected/new attempt; return its outcome
```

`--correct` does not change a known pair or add cost. Reports cannot overwrite known execution metadata. Pair conflicts need a new attempt. Without `--correct`, a changed verdict on a reported attempt means retry. No public `--event-id`, `--revision`, or ambiguity error is needed. Identical same-pair retries need an observed new start to differ from report replay.

## What each recorder knows

| Recorder | Identity and actual pair | Usage |
| --- | --- | --- |
| Claude hooks | `prompt_id`, `agent_id`, `tool_use_id`. Model from transcript `message.model` or Agent `resolvedModel`. `effort.level` is available on main-session hooks only. | Preserve message identity before summing. Subagent effort stays null unless the mod sets it. |
| Claude mod | `turn.step`: `turnId`, `index`, `agentId`, model and sent effort. `tool.call` has `tool_use_id`, but `TurnStepResult.toolUses` has no ID. | Record `TurnStepResult.usage` per step with its answering model and step effort. Join tool calls by `tool_use_id` and agent identity by `agent_id`. |
| Codex | `turn_context` gives turn ID, model and effort. Legacy calls/results bind by `call_id`; completed `CommandExecution` events bind by `item.id`. Hook `tool_use_id = exec-placeholder` is not identity. | Keep the last cumulative snapshot per turn. Never sum snapshots. |

With hooks plus mod, bind `tool.call.e.tool_use_id` to hook `tool_use_id`; this also joins the Agent call to `agent.spawn.e.tool_use_id`. Bind subagent identity by `agent_id`/`agentId`. Do not assume mod `turnId` equals hook `prompt_id`: they are different UUIDs, and `turn.start` carries only text and `turnId`. Hooks write signals only; the mod writes per-step usage because it knows the model and sent effort. Hooks skip usage only for sessions whose mod start bindings are flagged as owning usage. The mod sets that flag only when it also writes usage: with hooks present, `record: auto` therefore means "on" for the mod, and `record: off` suppresses mod starts so hooks fall back to turn-level usage. This splits ownership by data type, avoids double counting, and never loses usage.

Do not assign the mod's mixed turn total to its last pair. Use disjoint step measurements. For Codex, an in-turn pair change without separate counters leaves pair cost incomplete. Keep its measured total once in suggestion totals with a null attempt. Never invent a split or a `root_hint`.

The fixture spike is in `packages/core/src/signals/fixtures/`. Trust the mod's `turn.step` sent effort per step and Codex `turn_context.payload.effort`. Trust main-hook `effort.level` only when no mod rewrites main steps: the spike confirms main hooks carry the field, but does not establish that it still matches the effort sent by a rewriting mod. `SubagentStart`, `SubagentStop`, and subagent `PostToolUse` have no effort in the captured session. Subagent effort stays null unless the mod sets it. `tool.call.e.tool_use_id` matches `PostToolUse.tool_use_id`, including subagent calls; `TurnStepResult.toolUses` has no ID. Filter the extra `UserPromptSubmit` whose prompt starts `<agent-message` and `PostToolUse` named `SubagentHandback`.

The mod's sent effort records the requested value. The spike does not confirm that the API received or applied it.

The sanitized `main-identity-transcript.jsonl` and `subagent-identity-transcript.jsonl` excerpts each contain two assistant entries from one API message. Their entry `uuid`s differ but their `message.id` and usage repeat. Deduplicate usage by `message.id` within the session and agent transcript. Do not use the entry `uuid` or `tool_use` block ID as the message deduplication key. The block's `id` matches hook/mod `tool_use_id` and binds the tool call. The fixture tests check both transcript variants through the production usage parsers.

`codex-exec-identity.json` captures both rollout formats for one `codex exec` turn. The legacy call/output share `call_yLMKZWo1O7DKBsXwzCrZpUge`. The completed command has `item.id = exec-bec398ff-1a9f-4445-997e-664871e34504`. These IDs differ and the captured completed item has no `call_id` link. Keep their ID namespaces separate; a shared turn does not prove an exact call binding. `parseCodexRollout` prefers completed commands and deduplicates them by `item.id`, suppressing legacy mirrors. This capture's legacy output wraps `exit_code` in JSON; the parser also reads this structured result when completed events are absent. The tests serialize the records as JSONL and check the parsed model, effort, command and `token_usage_record.turn_token_usage`.

## Storage sketch

Empty `agent_key` means main. Direct callers use a suggestion-scoped synthetic session. Bindings name external IDs. Events hold derived observations only.

```sql
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  execution_key TEXT NOT NULL,
  model TEXT, effort TEXT,
  root_id TEXT NOT NULL REFERENCES attempts(id),
  opened_at INTEGER, closed_at INTEGER,
  chain_closed_at INTEGER, -- root only
  UNIQUE (suggestion_id, ordinal),
  UNIQUE (suggestion_id, execution_key)
);
CREATE TABLE attempt_bindings (
  harness TEXT NOT NULL, session_key TEXT NOT NULL,
  agent_key TEXT NOT NULL, id_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  PRIMARY KEY (harness, session_key, agent_key,
               id_kind, external_id, attempt_id)
);
CREATE UNIQUE INDEX attempt_exact_binding ON attempt_bindings
  (harness, session_key, agent_key, id_kind, external_id)
  WHERE id_kind IN ('call', 'message', 'start');
CREATE TABLE attempt_events (
  harness TEXT NOT NULL, session_key TEXT NOT NULL,
  agent_key TEXT NOT NULL, event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  suggestion_id TEXT REFERENCES suggestions(id),
  attempt_id TEXT REFERENCES attempts(id),
  binding TEXT NOT NULL CHECK (binding IN ('bound','window','pending')),
  prompt_id TEXT, turn_id TEXT, call_id TEXT,
  source_seq INTEGER, occurred_at INTEGER, received_at INTEGER NOT NULL,
  model TEXT, effort TEXT, kind TEXT NOT NULL,
  value REAL, weight REAL,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
  PRIMARY KEY (harness, session_key, agent_key, event_id, revision)
);
```

Prompt/turn bindings can name several mod segments. Exact call/message/start bindings name one attempt. Internal event IDs identify reports or measurements. Revisions replace snapshots and corrections. Equal identity/revision with different payloads is an error. Older revisions cannot replace newer ones.

Enable foreign keys. Check token ranges, pair values, source ownership and matching suggestion/attempt IDs. A new chain root references itself. Other members copy an existing root without changing it. No `predecessor_id` or cycle checks are needed.

DuckDB reads latest event revisions only. It needs `attempt_id`, `suggestion_id`, `binding`, `kind`, `value`, `weight`, pair fields and all four token columns. Binding context/IDs support attribution audits. Source order and times support reconciliation. Store no raw prompts or command output.

## One binding rule for signals and usage

`bound` means source identity selected the attempt. `window` means time selected it. `pending` means no safe target exists. The store logs conflicts and keeps them pending without credit.

```text
bind(event):
  check context, ownership and supplied identity fields
  candidates = intersection of bindings that ALREADY EXIST for supplied IDs
  if existing bindings disagree: log conflict; persist pending; return
  if any existing binding:
    target = exact attempt/call, else source segment within candidates
    if absent: target = unique compatible window within candidates
    # Never search outside candidates, even when their window has expired.
  else:
    if no trustworthy source time: persist pending; return
    target = unique compatible suggestion/attempt window in session + agent
  if main-session evidence in a suggestion with a delegated attempt:
    # An Agent tool_use in source order within the window proves delegation.
    # Orchestration never fills or opens an attempt; apply even with a prompt binding.
    usage: attribute to suggestion totals with null attempt
    signal: target = latest closed delegate within the selected suggestion window
  if no unique target: persist pending; return
  persist event and bind previously unbound prompt/turn IDs to target
  # Window-derived aliases stay provisional through their supporting events.
```

An unbound follow-up prompt/turn can use the window. A known p1 cannot fall through to p2, even with p2's timestamp. Exact IDs still work without timestamps. Missing transcripts never justify selecting the open suggestion by receipt time.

Time windows are half-open and use a shared source clock. Receipt time cannot replace source time. Clock skew cannot change exact identity. Late events cannot extend today's idle window. Explicit adapter links connect prompt and turn aliases.

On new links or transcripts, reconcile pending/window events and their provisional aliases together. Move signals and usage in one transaction. Exact bindings stay fixed. Conflicting window credit returns to pending. Preserve message IDs and source order before aggregation. Partial or older transcripts cannot erase evidence.

Main-session orchestration usage in a delegated suggestion's window belongs to suggestion totals with a null attempt. Main-session test/build signals bind to the most recent closed delegated attempt, even when the prompt is already bound. Detect delegation from an Agent tool use in source order within the window, not hook arrival order. Persist the signal choice; later reports cannot retarget it. The orchestrator's model does not replace the worker's pair. Limit: main-session self-fixes also land on that delegated attempt. Explicit attempt identity can override this fallback.

## Outcomes, consumers and cost

`attempt_outcomes` has one row per attempt with quality evidence. The report wins. Otherwise combine the latest test and build with weights 1.0 and 0.8. Conflicting observations without source order stay unresolved. Usage alone creates no quality. Expose UUID, ordinal, root, actual pair, quality and four token totals.

`cellStats` counts scored attempts once. Same-pair reported fail/pass gives `n=2, sum_quality=1`. An internal TDD fail/pass gives one passing outcome. Keep dry-run exclusion, difficulty normalization and catalog-confirmed `none` normalization. Unknown pairs cannot train learning.

`usage_totals` exposes `suggestion_id`, nullable `attempt_id`, pair fields and all four token columns.
The sketch below predates #67. Implementation must also carry `cost_usd`, `cost_source`, `tokens_complete` and `tokens_schema` from `usages`.
Reuse suggestion price snapshots for legacy usage. Exclude `tokens_schema = 1` from all USD comparisons.
The attempt migration must preserve these fields and snapshots.

Token-only sketch:

```sql
CREATE VIEW usage_totals AS
SELECT suggestion_id, NULL AS attempt_id, model, effort,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
FROM usages
UNION ALL
SELECT suggestion_id, attempt_id, model, effort,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
FROM attempt_usage;
```

`attempt_usage` sums latest authoritative measurements once, including suggestion-bound totals with unknown attempt. Pending measurements without a suggestion contribute nothing. Never sum a snapshot and its component increments.

Update [report/index.ts](../../packages/core/src/report/index.ts) together with the new views:

- Replace both direct `db.usages` reads with `usage_totals`. Aggregate tokens before outcome joins.
- Coverage counts distinct scored suggestions over distinct non-test suggestions.
- Adoption and learned/control compare first-attempt quality once per root. Pair learning still counts individual attempts.
- Scope statistics count completed chains once under the root suggestion's scope. Legacy statistics keep v4 meaning.

Define `store.outcome(id)` as the latest ordinal of that suggestion, even when its quality is null. Legacy IDs return their single v4 row. `report --json` returns the attempt selected by that report, not an arbitrary `.get()` result. Preserve `suggestion_id`, `quality`, `model`, `effort`. Add `attempt_id`, `ordinal`, `root_id` and four token totals. Legacy attempt fields are null. Update the contract, CLI fixtures and callers together.

A recovery chain groups retries under the first attempt's `root_id`. `suggest --retry-of` copies the named suggestion's root. Unlinked suggestions start new chains. Unlinked review suggestions stay separate. #41 reports their costs separately.

The store evaluates chain completion after a report or finalized Stop/SubagentStop evidence. The first member verdict at least `successQuality` closes the chain successfully. Raw intermediate tests do not close it. The next unlinked suggestion in the same session/agent closes it as failed; idle expiry is derived at read time in the chain view. The store writes `chain_closed_at` on the root for transactional closures. Late evidence and `--correct` recompute the result and closure.

Chain statistics use the root suggestion's `task_type × difficulty`, learned/control flags and first actual pair. Each execution keeps its own tokens. Decision cost sums the chain once under the root pair. Costs `10 → 20 → 70` produce root cost `100`, not repeated charges on each outcome. Failed completed chains also contribute cost. Orchestration usage (null attempt, suggestion totals) counts in the chain's decision cost and is also reported separately as orchestration overhead, like review cost. Divide by successful chains. Zero successes gives null. Incomplete Codex pair costs still belong to chain tokens through the suggestion total; mark only per-attempt execution cost and its dollar slice incomplete, so #41 cost per success is not biased low. #41 owns dollar conversion and confidence intervals.

## Migration after v6

The outcomes view is unchanged since v4; v5 only added `suggestions.fallback_reason` and the `failures` table. Schema v6 adds normalized tokens and cost (#67). The attempt migration must use the next free version after v6.

Close and mark all existing suggestions as legacy in one migration. Keep signals, usages, rowids and usage watermarks unchanged. Recheck `user_version` inside the existing `IMMEDIATE` transaction. Each migration array entry is one SQL statement.

SQLite cannot rename a view. Recreate the same v4 SELECT under `legacy_outcomes`, then replace `outcomes`:

```sql
ALTER TABLE suggestions ADD COLUMN is_legacy INTEGER NOT NULL DEFAULT 0;
UPDATE suggestions SET is_legacy = 1, closed_at = COALESCE(closed_at, unixepoch() * 1000);
-- CREATE VIEW legacy_outcomes AS <unchanged v4 SELECT>;
DROP VIEW outcomes;
CREATE VIEW outcomes AS
SELECT suggestion_id, quality, model, effort FROM legacy_outcomes
UNION ALL
SELECT suggestion_id, quality, model, effort FROM attempt_outcomes;
```

The legacy marker routes late events to a drop with a local log. Never fall through to a new suggestion. New writes use only attempt storage. No snapshot table, legacy writer or refresh step is needed. Old indexes remain untouched.

Proof fixture: S has reports `(t1,A,low,fail,10)`, `(t2,B,high,partial,20)`, `(t3,A,low,pass,30)`. Report times increase. V4 returns `(S,1.0,A,low)`. The unchanged view returns the same row. A/low keeps `n=1, sum_quality=1` and Beta estimate `2/3`. B/high has no learning row. Token sums stay unchanged. Null pairs stay null. Suggestions without signals still have no outcome. Historical retry counts and first-pair costs remain unknown.

## Review failure cases

R1 denotes the first review of [#59](https://github.com/lorenzh/spatz/pull/59). R2 denotes its five remaining must-fixes.

| Finding | Revised design response |
| --- | --- |
| R1.1: same-pair failure disappears; tokens absent | Separate reported retries keep UUIDs and token totals. Internal TDD checks stay within one attempt. |
| R1.2: same-turn reports collide | Reports belong to attempt slots. Old turn uniqueness does not apply. |
| R1.3: delayed Codex signals and usage diverge | Shared resolver and atomic reconciliation use the originating turn. |
| R1.4: missing transcript/time credits current suggestion | Only trustworthy source windows allow fallback. Other events stay pending. |
| R1.5: malformed or timestamp-less input goes uncounted | Parse diagnostics move to [#39](https://github.com/lorenzh/spatz/issues/39). Known IDs can still bind without time. |
| R1.6: intermediate pairs pay escalation costs | Charge chain cost once to the root pair. |
| R1.7: README describes suggestion-wide overrides | Implementation updates README and CLI/hooks references to attempt-local reports. |
| R2.1: model-less hooks inherit the latest report pair | Bind hooks to execution identity. Fill only that attempt's unknown pair. Mod always registers pair metadata. |
| R2.2: A→B→A overwrites first A | Three UUIDs/ordinals preserve all outcomes and the first pair. |
| R2.3: migration splits reports across turns | Unchanged legacy view and frozen legacy writes preserve exact v4 aggregation. |
| R2.4: known p1 falls through to p2's window | Existing bindings restrict candidates. Only unbound IDs can use a new window. |
| R2.5: delayed usage ignores effort and turn | Preserve turn/message/step identity and actual effort before sums. Codex snapshots replace rather than add. |

Conflicts log locally without raw input. Hooks still exit successfully. Full parse and failure reporting belongs to #39.

## Implementation checks

Write failing fixtures first for both Claude transcript variants and both Codex rollout formats. Cover skill reports, main-session verification, mod-only recording and hooks plus mod. Check:

- Same-pair retries, `--correct`, A→B→A and a TDD red-to-green loop.
- Unbound follow-up prompts; known p1 inside p2; delayed links; missing time/transcripts; duplicate snapshots; window repair.
- Low-effort 100/high-effort 200 usage; mod step attribution; Codex unsplittable totals; root cost 10/20/70; failed and review chains.
- Stats coverage without duplicated rows, all four token totals, latest `outcome(id)` and the selected report's JSON.

Use one temporary SQLite race test for ordinal allocation and start replay. Keep transaction rollback checks for combined signal/usage repair. Compare a frozen v4 fixture before and after migration: outcome multisets, learning, tokens, coverage, adoption, learned/control and scope statistics. Include the three-report example, null effort, equal times, dry runs, usage-only suggestions and open legacy sessions.
