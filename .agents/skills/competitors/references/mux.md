# Mux (coder/mux)

_Researched 2026-08-06._

- **Positioning**: Desktop & browser app for parallel agentic development: multiple AI agents in isolated workspaces (local, git worktree, or SSH) with centralized diff review. Unlike most competitors it embeds its own agent loop instead of hosting third-party CLIs.
- **Company/traction**: Coder Technologies ($90M Series C led by KKR, 2026-04); ~2k stars; formerly `coder/cmux` (renamed; distinct from manaflow-ai/cmux). Announced ~2026-01. Ties into Coder's enterprise "AI Governance" upsell.
- **Tech stack**: Electron + React, Bun monorepo, Vercel AI SDK across many providers, `@agentclientprotocol/sdk`, 1Password SDK for secrets.
- **License**: AGPL-3.0-only: reference-only for code.

## Architecture highlights

- Three runtime tiers with one UX: Local (in-place), Worktree (local git worktrees), SSH (remote execution), see `docs/runtime`.
- Custom agent loop with "opportunistic compaction" and a mode-prompt system inspired by Claude Code's Plan/Exec UX.
- IPC contract discipline mirrors Caxri's: backend types flow straight to the frontend, no ad-hoc duplication; frontend forbidden from synthesizing workspace IDs.
- "Self-healing" persistence: corrupted `chat.jsonl` entries are sanitized at load rather than crashing; startup init wrapped to never crash.
- Flat inspectable data layout: `~/.mux/config.json`, `~/.mux/src/<project>/<branch>` worktrees, `~/.mux/sessions/<workspace>/chat.jsonl`.
- Ships a debug CLI (`bun run debug`) for inspecting workspaces/costs/raw provider requests.

## Standout features

- Git-divergence-centric dashboard of what each agent branch changed, with integrated review.
- Per-workspace cost/token tracking and a context-management dialog for compaction.
- Mux Gateway proxy giving eligible OSS contributors free eval credits.
- Mobile-responsive "server mode", VS Code extension, and CLI-only mode (`npx mux run` / `npx mux server`) for CI.
- Windows still "alpha"; macOS/Linux signed and notarized.
