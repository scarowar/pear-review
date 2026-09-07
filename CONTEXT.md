# Context — Pear Review

## Language

**Pear Review**: A portable, evidence-gated companion that helps you ship one contribution with proof, in your current agent session, under human direction.
_Avoid_: reviewer-as-judge, auto-fixer, dashboard

**Contribution**: The exact local change under review (staged and unstaged against a shown base). Untracked files only after human selection. Not a changeset, not a PR.
_Avoid_: changeset, diff as product term

**Evidence-gated finding**: A material concern admitted only after one complete path: (1) observed failure — deterministic check / trace / reproducible input shows defect, (2) traceable project rule — intent / repo rule / test contract / accepted spec conflicts with contribution, (3) complete causal path — code links each step from changed behavior to material consequence. If none, discard concern; if required check blocked, report coverage gap.
_Avoid_: suggestion, preference, style note, model intuition as finding

**Human-directed**: The human controls intent, code changes, and external actions. Pear is read-only and describes repair outcome + verification, never mutates.
_Avoid_: auto-fix, agent-writes-code

**Agent session**: The user's current agent interaction (OpenCode or other Agent Plugins host). Pear works via `PLUGIN_ROOT` + `PLUGIN_DATA` and `skills/pear-review/SKILL.md` — no separate service.
_Avoid_: hosted Pear model, MCP server as core
