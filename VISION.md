# Vision — Pear Review

Status: **Wayfinder map `pear-vision` 4/5 product decisions resolved** — ready for `to-spec`. Private learning is separate in `pear-review-workbench`.

## One sentence

> **Pear Review is a portable, evidence-gated companion that helps you ship one contribution with proof, in your current agent session, under human direction.**

See `CONTEXT.md` for 5 terms.

## Product scope (public)

- **Contribution**: staged + unstaged vs shown base; untracked only after you pick.
- **Evidence rule**: 3-path OR — observed failure | traceable rule | causal path else gap.
- **ReviewResult**: findings + gaps + checks + resource (tokens/tools/time) + readiness + version + contribution identity.
- **Eval**: starter 30 (15 visible/15 hidden, hash), floor 300; judge kappa ≥0.7; OTEL `llm.token_count.*`, `gen_ai.*`; bearer RFC6750 deterministic throwaway.
- **Plugin**: 2 files only — `plugin.json` + `skills/pear-review/SKILL.md` (<500 lines), references on demand, assets for pics. Portable by spec, test OpenCode first; second client later.
- **Out for now**: Hunk viewer inside Pear, MCP server, dashboard, auto-fix, broad style lists. All gitignored via `.scratch/`.

## Not in this repo

Your growth to become best Applied AI Engineer is tracked privately in `../pear-review-workbench` (`NEXT.md` + `.scratch`). No learning state lives here. See `archive/2026-09-07-pre-reset/` for prior release.

Next: `to-spec` (one spec) → `to-tickets` (5 slices, chain 01→05, public only).
