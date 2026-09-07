# Pear Review working rules

Use KISS, YAGNI, and DRY in all Pear Review work.

- Add only the smallest change that meets a proved need.
- Add a dependency only when it removes more complexity than it adds.
- Keep one source of truth for each rule, term, contract, and decision.
- Link to an existing source instead of repeating it.
- Remove obsolete code and documents when a replacement is complete.
- Use the latest suitable stable tool. Test beta tools only in isolated experiments.
- Keep each experiment small. State its question and success measure before work starts.
- Do not add a product feature until an evaluation or user need earns it.
- Treat a user question as an alignment request unless the user clearly changes the scope.
- Make each part clear enough for the owner to explain, test, and maintain.

## Agent skills

### Issue tracker

Internal Wayfinder decisions live in `.scratch/` (local markdown) to keep OSS public noise low; public OSS issues use GitHub. See `docs/agents/issue-tracker.md`.

### Triage labels

Default 5-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. `CONTEXT.md` + `docs/adr/` are created lazily when a term/decision is actually resolved — not upfront. See `docs/agents/domain.md`.
