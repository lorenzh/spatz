---
title: Attempt identity for outcomes
description: A proposed attempt ledger that preserves retries, binds delayed events, and keeps legacy learning unchanged.
tags: [spatz, data-model, signals, learning]
keywords: [attempt, identity, retry, escalation, outcome, migration, prompt, turn, binding, cost]
---

# Attempt identity for outcomes

Status: design only. This proposal addresses [#34](https://github.com/lorenzh/spatz/issues/34) and [#35](https://github.com/lorenzh/spatz/issues/35). Implementation follows separately. [#41](https://github.com/lorenzh/spatz/issues/41) consumes the cost data described here.

The baseline is schema v4. Its [outcomes view](../../packages/core/src/store/index.ts) combines all signals for a suggestion. The [API](../../packages/core/src/api/index.ts) selects open suggestions for hooks. The [parsers](../../packages/core/src/signals/transcript.ts) discard identities before summing usage. Change all three boundaries together.

[PR #59](https://github.com/lorenzh/spatz/pull/59) tried to reconstruct attempts from signal order. Current behavior remains documented in [How spatz works](../how-it-works.md) and [Hooks](../hooks.md).

## Identity and lifecycle

An attempt is one execution of an actual model/effort pair toward a result. It includes generation and validation until completion or a retry boundary. A recommendation alone is not execution.

Each attempt has an immutable UUID and a durable caller execution key. The key identifies a replayed start. Its context contains the suggestion, harness, session, agent, and prompt/turn IDs. A suggestion can contain several attempts per turn. Neither the pair nor the turn is unique.

Within a suggestion, starts receive increasing ordinals in one `IMMEDIATE` transaction. Allocate before dispatch. A replay returns the existing UUID and ordinal. `A → B → A` produces ordinals `1/2/3` with three UUIDs. A same-pair retry also gets a new UUID. Delayed evidence never changes ordinals.

The actual pair comes from the execution adapter. Unknown fields stay null until evidence for that execution fills them. A later report cannot replace a known pair. A conflicting pair requires a new attempt or an explicit metadata repair. The recommended pair is never evidence that it ran.

| Recorder | Open | Close |
| --- | --- | --- |
| Claude Code hooks and routing skill | Register before dispatch or local work. Persist prompt and subagent links. For uninstrumented runs, reconstruct starts in transcript order using stable message IDs. | Report, Stop/SubagentStop, pair switch, or generation after failed validation. |
| Claude Code mod | Register before `turn.step` executes the selected pair. Reuse the attempt during uninterrupted work. Register again for a retry or pair switch. | `turn.complete`, report, or replacement by the next attempt. |
| Codex hooks | The skill registers before work. At Stop, replay rollout execution boundaries in source order when registration is missing. | Report, turn completion, or a retry/switch boundary in the rollout. |
| Direct `spatz report` | Use an existing attempt ID. Without one, a first report can create a completed attempt. | Commit the report and closure together. |

A failed validation seals that attempt before the next generation starts. Further checks of the same output still bind to that sealed attempt. Generation after failure opens a fix round. Repeating a check without generation does not create another attempt. Adapters must retain call/message IDs and source order to distinguish these cases.

Proposed CLI operations are `attempt start` and `report --attempt <id>`. Starts accept a caller `--execution-key`. Retries also name `--retry-of <id>`. Reports carry `--event-id` and increasing `--revision`. `--correct` changes the verdict without work or extra cost. A retry opens another attempt before work. If correction versus retry is ambiguous, changed reports without identity must fail. An identical replay of a sole implicit report remains idempotent.

Stop closes execution without implying success. Closure permits late evidence and corrections. Idle expiry or the next unrelated suggestion closes abandoned execution with unknown verdict. These operations never erase IDs or reopen execution. Later work needs a new start. Scope labels do not identify attempts. Parallel subagents have separate agent keys and require explicit parent links.

## Storage sketch

Proposed DDL sketch: Empty `agent_key` means main. A direct caller without a harness session gets a suggestion-scoped synthetic session key.

```sql
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  execution_key TEXT NOT NULL,
  model TEXT, effort TEXT,
  predecessor_id TEXT REFERENCES attempts(id),
  root_id TEXT NOT NULL REFERENCES attempts(id),
  state TEXT NOT NULL CHECK (state IN ('open','closed')),
  opened_at INTEGER, closed_at INTEGER, close_reason TEXT,
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
CREATE TABLE attempt_events (
  harness TEXT NOT NULL, session_key TEXT NOT NULL,
  agent_key TEXT NOT NULL, event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  attempt_id TEXT REFERENCES attempts(id),
  binding TEXT NOT NULL CHECK
    (binding IN ('pending','explicit','source','window','conflict')),
  prompt_id TEXT, turn_id TEXT, call_id TEXT,
  source_seq INTEGER, occurred_at INTEGER, received_at INTEGER NOT NULL,
  model TEXT, effort TEXT, kind TEXT NOT NULL,
  root_hint TEXT REFERENCES attempts(id),
  value REAL, weight REAL,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
  PRIMARY KEY (harness, session_key, agent_key, event_id, revision)
);
```

Bindings permit several attempts per prompt or turn. A call/message binding names exactly one attempt through an additional partial unique index. Main and subagent identities never share that index. Prompt and turn aliases become equivalent only through an explicit adapter link.

The store enables foreign keys and validates token ranges, revisions, pairs, and ownership. Start transactions validate predecessors and prevent cycles. They inherit `root_id`, allocate the ordinal, and insert bindings atomically. A root references itself. Event transactions reject conflicting payloads with the same identity/revision. Higher revisions correct observations. Older revisions remain historical. Reports use the stable event ID `report:<attempt_id>`. Store only derived fields, never prompts or command output.

## Binding signals, usage, and reports

All three use the same resolver. Known identity restricts candidates before any time lookup:

```text
bind(event):
  validate context and identity fields
  candidates = intersection of every supplied known binding
  if explicit attempt/call identity conflicts with prompt/turn:
    return conflict
  if any supplied identity is unresolved:
    persist pending; return
  if identities supplied:
    target = exact attempt/call binding, else source-order segment
    if target absent: target = unique compatible window within candidates
    return target or pending              # never another prompt
  if trustworthy source time is absent: return pending
  target = unique compatible window in this session and agent
  return provisional(target) or pending
```

An exact binding remains valid after closure or expiry. For example, p1 at a timestamp inside p2 still belongs to p1. Multiple attempts inside p1 require a call ID, execution key, or source segment. Missing transcripts cannot justify selecting the currently open suggestion. A main-session verifier names the attempt being checked. Its own model does not replace the worker's model. Without this link, its result remains pending.

Store source time and receipt time separately. Use source sequence for verdict order. Clock skew never changes an exact binding. Time fallback uses half-open windows only when both boundaries and events share a verified clock domain. Otherwise leave the event pending. Never clamp a timestamp to receipt time. Late traffic cannot extend the current suggestion's idle window.

When a link or transcript arrives, reconcile pending and provisional events in one transaction. Resolve signals and usage together. Explicit bindings never move through window repair. A newly discovered conflict removes provisional credit until resolved. A known turn without timestamps can still bind exactly.

Parsers must preserve message IDs, call IDs, turns, effort, and source sequence before aggregation. Reconstruct only from an ordered source prefix with stable boundary IDs. If missing history prevents ordering, keep events pending instead of allocating arrival-order attempts. Compaction is not deletion evidence. Merge messages by identity and revisions. An older snapshot cannot replace newer evidence or delete missing messages.

Usage events represent disjoint message/step increments. Cumulative snapshots replace earlier snapshots for the same measurement scope. Never add snapshots to their component increments. Keep one recorder per execution, as the mod's recorder selection already intends. Shared measurement IDs prevent hook/mod duplicates. Without shared IDs, the chosen recorder is authoritative.

The mod must stop assigning mixed turn totals to its last pair. Record step usage before summing. A cumulative Codex total spanning several attempts cannot be split without boundary counters. Keep that total as unresolved chain usage and mark attempt costs incomplete. Exact bindings preserve low-effort 100/high-effort 200 usage regardless of arrival order.

## Outcomes and cost

`attempt_outcomes` derives one row per attempt with quality evidence. The latest report revision wins within that attempt. Otherwise use the latest test and build by source order, with current weights 1.0 and 0.8. Unknown order between conflicting observations leaves quality unresolved. Usage alone creates no quality. Expose each attempt's token totals and derived verdict alongside its identity.

`outcomes` combines these rows with legacy outcomes below. `cellStats` counts each scored attempt once for its actual pair. Keep dry-run exclusion, difficulty normalization, and catalog-confirmed `none` normalization. Unknown pairs stay out of learning. Same-pair fail/pass gives `n=2, sum_quality=1`. Later success cannot remove the earlier failure.

A recovery chain contains the initial attempt and its retries, fix rounds, and escalations. `root_id` identifies the first actual pair. A retry using a fresh recommendation must explicitly name its predecessor to retain that root. Unrelated tasks start separate chains. A late older execution cannot be inserted ahead of a registered root without explicit repair.

Execution totals remain on the pair that consumed tokens. Decision cost sums the entire chain once under its root pair. Never join chain totals onto every outcome. `cheap → middle → strong` charges both later attempts to cheap. Costs of 10, 20, 70 produce a decision cost of 100 for cheap. Middle and strong keep their execution costs for inspection.

A `chain_complete` event names the terminal attempt and its root. That attempt determines task success at the existing threshold. Individual check success does not complete a chain. Cost per success divides all completed-chain costs by successful chains for that root pair. Failed chains contribute costs too. Zero successes gives null. Unknown verdicts and incomplete costs get separate counts. Unresolved chain usage needs a validated `root_hint` to enter the numerator. Dollar conversion and confidence intervals belong to #41.

Coverage counts distinct suggestions. Adoption and learned/control first-attempt quality use the root once. Final task success and chain cost remain separate measures. Scope statistics count completed chains once. Legacy statistics keep their previous meaning.

## Migration from v4

Do not infer historical attempts. Add one migration entry containing single SQL statements in the existing `IMMEDIATE` transaction. Recheck `user_version` inside the lock.

Before changing views, snapshot the exact v4 view:

```sql
CREATE TABLE legacy_outcomes AS SELECT * FROM outcomes;
CREATE UNIQUE INDEX legacy_outcome_id ON legacy_outcomes(suggestion_id);
```

Mark every existing suggestion as legacy, including those without signals. Keep its signals, usages, rowids, and usage watermarks unchanged. New storage handles new suggestions only. Late events use the identity resolver above, including legacy targets. The isolated legacy writer keeps v4 aggregation. Refresh affected legacy snapshot rows atomically. Never admit those rows to `attempt_outcomes`. Existing evidence keeps its v4 meaning.

For new suggestions, the old `signals_turn` index and usage uniqueness rule are irrelevant: writes use `attempt_events`. Keep those indexes for the legacy writer. The replacement `outcomes` uses `UNION ALL` over disjoint legacy and new identities. Legacy rows and their known prompt/turn bindings expose synthetic `legacy:<suggestion_id>` identities. Retry counts and first-pair costs remain unknown for legacy data.

Proof example: v4 suggestion S has three reports: `(t1,A,low,fail,10)`, `(t2,B,high,partial,20)`, `(t3,A,low,pass,30)`. Numbers are increasing observation/report times. V4 chooses the last report quality and latest reported pair. It returns exactly `(S,1.0,A,low)`. The snapshot returns the same row after migration. Learning remains `n=1, sum_quality=1` for A/low and zero rows for B/high. Its Beta estimate remains `2/3`. All original usage sums also remain unchanged. Splitting this history into three attempts would violate compatibility.

The snapshot copies the old relation directly. New events are empty. Their disjoint union equals the old relation with unchanged nulls and floating-point quality. Signals without usage keep null pairs. Suggestions without signals keep no outcome.

## Review failure cases

R1 and R2 denote the first and second supplied independent reviews. R2 contains five unresolved must-fixes.

| Finding | Design response |
| --- | --- |
| R1.1: same-pair failure disappears and tokens are absent | Persist execution UUIDs and expose attempt token totals. Fail/pass stays two outcomes. |
| R1.2: same-turn reports collide | Event identity includes execution context. Legacy turn uniqueness cannot delete new reports. |
| R1.3: delayed Codex signal and usage diverge | One resolver and atomic reconciliation bind both to the originating execution. |
| R1.4: missing transcript/time credits current suggestion | Known IDs restrict candidates. Unresolved events remain pending. |
| R1.5: timestamp-less Codex and malformed Claude input go uncounted | Record parse diagnostics, even when exact binding succeeds. Count affected turns by harness/session/agent/turn and reason. Unidentified malformed input counts separately, without invented turn identity. |
| R1.6: intermediate pairs pay escalation costs | Sum all recovery costs once under `root_id`. |
| R1.7: README describes suggestion-wide overrides | Implementation must update the quickstart and CLI/hooks references to attempt-local overrides. |
| R2.1: model-less hooks inherit the latest reported pair | Bind at production or source replay. Never infer from a later report. |
| R2.2: A→B→A overwrites first A | Three UUIDs and ordinals retain all executions and the first pair. |
| R2.3: migration splits reports across turns | Exact legacy snapshot and separate writer preserve v4 aggregation. |
| R2.4: known p1 falls through to p2's window | Candidate restriction is final. Timestamps cannot cross it. |
| R2.5: delayed usage ignores effort and turn | Preserve measurement identity and pair before summing. Never match by database write time. |
| R2 note: stale PR schema and test claims | Implementation PR must describe its final schema and actual gate results. |

Diagnostics stay local and contain no raw input. Hooks still exit successfully after recording errors. [#39](https://github.com/lorenzh/spatz/issues/39) owns full failure reporting.

## Test plan and open questions

Write failing fixtures first. Extend both Claude transcripts and both Codex rollout formats. Cover same-pair retries, A→B→A, ordinary skill verification, mod-only recording, and hooks plus mod. Assert attempt IDs, verdicts, learning rows, and all four token totals.

Permute delayed links, signals, Stop events, reports, and usage revisions. Include missing transcripts/timestamps, p1 timestamps inside p2, backward clocks, partial lines, compaction, and duplicate call mirrors. Check unresolved-to-bound transitions and conflict removal. Exercise 100/200 effort changes and 10/20/70 chain costs.

Use real temporary SQLite files with separate processes. Race identical starts, distinct starts, corrections, reconciliation, and migration. Assert unique ordinals, replay stability, atomic signal/usage binding, and rollback after injected failure.

Freeze a populated v4 fixture independently of new migrations. Include the three-report example, equal timestamps, null effort, multiple models, dry runs, usage-only suggestions, and open legacy sessions. Compare complete outcome multisets, `cellStats`, token totals, coverage, adoption, learned/control, and scope statistics before and after migration.

Before implementation, confirm which harness versions expose stable step boundaries and usage revisions. Where they do not, explicit start registration is required. Confirm CLI spelling and whether callers can propagate attempt IDs through verification. These are integration questions. Ambiguous evidence must remain uncredited.
