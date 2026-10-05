# Security policy

## Report a vulnerability

Report vulnerabilities privately. Do not open a public issue.

1. Open the **Security** tab of the repository on GitHub.
2. Select **Report a vulnerability**. This opens a private security advisory.
3. Describe the problem, the steps to reproduce it and the effect.

Do not put real API keys or other secrets in the report. Use placeholders like `<your-key>`.

You get an answer in the advisory. The fix and the advisory become public after the fix is available.

## Supported versions

spatz is a proof of concept. Only the `main` branch gets security fixes. Older releases do not receive backported fixes.

## Scope

These parts are in scope:

| Area | What to report |
| --- | --- |
| Secret filter | A secret in the task text that the filter does not find, so spatz sends it to TypeSafe AI. |
| Data sent to TypeSafe AI | Data that goes to Jev other than the documented task text, candidate list and API key. Any request to Jev when Jev is off. |
| Data sent to OpenRouter | Task data or other local data in the model-list request. The optional `OPENROUTER_API_KEY` header is expected. |
| Local database | Prompt text, tool output or API keys in `~/.spatz/spatz.db` or in other files in `~/.spatz`. |
| Logs and output | An API key in the output, in an error message or in a log. |

Out of scope: problems in Bun, Claude Code, TypeSafe AI or OpenRouter. Report these to their maintainers.

[docs/privacy.md](docs/privacy.md) describes the data flows that spatz promises.
