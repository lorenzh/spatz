---
title: Privacy and data in spatz
description: What data spatz sends to TypeSafe (Jev) and OpenRouter, what it downloads as bench snapshot, what it stores locally in ~/.spatz, the secret filter, the Jev opt-out and how to delete the data.
tags: [spatz, privacy, security]
keywords: [data, network, jev, typesafe, openrouter, bench snapshot, spatz-measurements, github release, secret filter, opt-out, SPATZ_NO_JEV, .spatz.json, retention, delete, gdpr, telemetry]
---

# Privacy and data in spatz

Only the task text of `spatz "<task>"` leaves the machine with task content. It goes to Jev (TypeSafe AI). spatz does not store the task text. Hooks process prompts, commands and transcripts only on the machine. They store only derived values.

## What goes where

| Data item | Where it goes | When | How to stop it |
|---|---|---|---|
| Task text and the candidate list (`model:effort` and a short description per model) | TypeSafe API (`https://api.typesafe.ai`), model `jev-1.13.0` | Each `spatz "<task>"` call, also with `--dry-run` | Set `SPATZ_NO_JEV=1`, add `.spatz.json` (see [Opt-out](#opt-out)), or unset `TYPESAFE_AI_API_KEY`. The secret filter also stops it. |
| `TYPESAFE_AI_API_KEY` | TypeSafe API, as the request credential | With each Jev request | Unset the variable. |
| Request for the OpenRouter model list. It holds no task data. | `GET https://openrouter.ai/api/v1/models` | Each `spatz "<task>"` call that finds no cache or a cache older than 24 h. After a failed request or a failed cache write, the next call tries again. | No switch. Only a successfully written cache stops the requests for 24 h. |
| `OPENROUTER_API_KEY` | OpenRouter, as `Authorization: Bearer` header | With the model list request, only when the variable is set | Unset the variable. The request then goes without a key. |
| Download of the bench snapshot and its checksum. It holds no task data and uploads nothing. | `GET https://github.com/lorenzh/spatz-measurements/releases/latest/download/snapshot.json` and `snapshot.json.sha256` | Each `spatz "<task>"` call that finds no cache or a cache older than 24 h | Set `bench.snapshot` to `false` (see [configuration](configuration.md#bench-evidence-bench-settings)) or `SPATZ_NO_NETWORK=1`. |
| Classification, Jev probabilities, ranking, reason, flags | Local SQLite file `~/.spatz/spatz.db` | Each suggestion | Do not run `spatz`. |
| Session id, prompt id, signals, model, effort, token counts | `~/.spatz/spatz.db` | Hook events and `spatz report` | Remove the spatz hooks from the Claude Code settings. |
| `--rounds` and `--note` of `spatz report` | `~/.spatz/spatz.db`, as you typed them | Each `spatz report` call | Do not pass `--note`. Do not put secrets or task text in it. |
| OpenRouter model list (ids, names, prices) | Local cache `~/.spatz/openrouter-models.json` | After each successful model list request | Delete the file. spatz loads the list again. |
| Bench snapshot (aggregated benchmark counts) | Local cache `~/.spatz/bench-snapshot.json` | After each verified download | Delete the file. spatz downloads it again or uses its bundled copy. |

spatz sends nothing else. It has no telemetry. The hooks make no network requests.

### What the hooks read

`spatz hook` reads the hook JSON from stdin. It uses these parts and drops the rest:

- The Bash command text. A regex finds test commands, build commands and `spatz` calls. spatz does not store the command.
- The output of a `spatz "<task>"` call. spatz reads only the suggestion id from it.
- The transcript files of the session and its subagents. spatz reads only model names, token counts and message times.
- The session id, prompt id, agent id and effort level.

The hooks never store prompt text, command text or tool output. For the hook setup, read [hooks.md](hooks.md).

### What the database holds

The database holds no task text, no prompt text and no tool output. The `reason` field is a fixed sentence with model ids. The table list is in [how-it-works.md](how-it-works.md#data-model).

## Secret filter

Before spatz sends a task text to Jev, a local filter checks the text for secrets. If the filter finds a match, spatz does not send the text. It classifies the task with the keyword rules instead. The output then shows `fallback_used: true`.

| Pattern | Example of a match |
|---|---|
| `sk-` followed by 20 or more key characters | OpenAI or Anthropic style API keys |
| `AKIA` followed by 16 characters | AWS access key ids |
| `-----BEGIN ... PRIVATE KEY-----` | PEM private keys |
| `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` | GitHub tokens |
| `glpat-` | GitLab tokens |
| `xoxa-`, `xoxb-`, `xoxp-`, `xoxo-`, `xoxs-`, `xoxr-` | Slack tokens |
| `AIza` followed by 35 characters | Google API keys |
| `sk_live_`, `sk_test_`, `rk_live_`, `rk_test_` | Stripe keys |
| `npm_` followed by 36 characters | npm tokens |
| `eyJ....eyJ....` | JSON Web Tokens |
| `password`, `passwd`, `pwd`, `secret`, `token`, `api_key`, `api-key` or `apikey`, then `=` and a value, or `:` and a quoted value | `password=hunter2`, `DB_PASSWORD=x`, `{"token": "abc"}` |

The last pattern ignores case. Plain prose such as `password: reset it` does not match.

The filter only finds these patterns. It does not find every secret. Do not put secrets in a task text.

## Opt-out

You can turn off Jev in two ways. Then spatz sends no task text. It uses the keyword rules for every task.

1. For all projects, set the environment variable:

   ```bash
   export SPATZ_NO_JEV=1
   ```

   Only the value `1` turns Jev off.

2. For one project, create the file `.spatz.json` in the project folder:

   ```json
   { "jev": false }
   ```

   spatz reads this file only from the current working directory. It does not search the parent folders. If you run `spatz` from a subfolder, the file has no effect. Run `spatz` from the folder that holds the file.

Without `TYPESAFE_AI_API_KEY`, spatz also uses the keyword rules.

The opt-out does not stop the OpenRouter request or the local database. The keyword rules are explained in [how-it-works.md](how-it-works.md#rule-fallback).

## Retention and deletion

spatz keeps learned data until you delete it. Old outcomes also stay in the learned estimates.
Schema upgrades keep the current backup and up to two other schema-version backups. See [database backup and restore](configuration.md#database-backup-and-restore).

The files are in `~/.spatz`. spatz finds the home folder through the `HOME` variable.

| File | Content |
|---|---|
| `~/.spatz/spatz.db` | Suggestions, usage, signals |
| `~/.spatz/spatz.db-wal`, `~/.spatz/spatz.db-shm` | SQLite WAL files of the same database |
| `~/.spatz/spatz.db.bak-v*` | Database backups and any incomplete backup files left after an interrupted process |
| `~/.spatz/openrouter-models.json` | OpenRouter model list cache |
| `~/.spatz/bench-snapshot.json` | Bench snapshot cache |
| `~/.spatz/aliases.json`, `~/.spatz/descriptions.json` | Your optional configuration files |

To delete the learned data:

1. Check that no `spatz` process runs. Close the Claude Code sessions that use the spatz hooks, or remove the hooks first.
2. Delete the database, its WAL files and its backups:

   ```bash
   rm -f ~/.spatz/spatz.db ~/.spatz/spatz.db-wal ~/.spatz/spatz.db-shm
   rm -f ~/.spatz/spatz.db.bak-v*
   ```

3. spatz creates an empty database on the next call.

To delete all spatz data and your configuration files, delete the folder:

```bash
rm -rf ~/.spatz
```

spatz cannot delete data at TypeSafe. For the retention of task texts at TypeSafe, read the terms of TypeSafe AI.
