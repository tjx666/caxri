# Warp (warpdotdev/Warp)

_Researched 2026-08-06._

- **Positioning**: Agentic development environment "born out of the terminal": bring-your-own CLI agent (Claude Code, Codex, Gemini CLI) or Warp's built-in Agent, plus the proprietary Oz cloud layer for orchestrating many agents.
- **Company/traction**: Founded by Zach Lloyd; Sequoia/GV/Sam Altman-backed; ~1M active developers, >50% of Fortune 500. Open-sourced 2026-04-28 (OpenAI as "founding sponsor"); ~63k stars, 500+ contributors within two months.
- **Tech stack**: Rust workspace, ~60+ crates (`ai`, `mcp`, `persistence`, `lsp`, `virtual_fs`, `sum_tree`, `warp_terminal`, `warpui`); Tokio, Alacritty, NuShell, Fig completion specs.
- **License**: AGPL-3.0-only core (reference-only for code); `warpui_core`/`warpui` UI crates are MIT: note the deliberate licensing/architecture split between UI framework and business logic.

## Architecture highlights

- `crates/persistence` uses Diesel migrations + `schema.rs`: structured DB-backed state, not flat files.
- `crates/sum_tree`: specialized tree for efficient text/scrollback operations (Zed lineage).
- `crates/virtual_fs` abstracts filesystem access for sandboxing/testability.
- Explicit `workspace/` module for session/workspace management, separate from terminal rendering.
- Agent workflows live in the external Oz cloud platform; the OSS repo is the terminal/ADE client only.

## Standout features

- Blocks model: command + output as discrete, shareable units.
- Multi-harness agent support (Claude Code, Codex, Gemini CLI, or Warp's own agent).
- Warp Drive (shareable notebooks/workflows); BYOK and custom OpenAI-compatible endpoints on all plans; cloud agent runs viewable in a web-compiled terminal.

## Recent news / sentiment

- Open-sourcing (2026-04-28) was received positively as reducing "closed-source moat" risk, but criticized (e.g. by Kilo Code) for routing contributions toward the proprietary single-vendor Oz platform.
- Pricing consolidated into a $20/mo "Build" plan + BYOK (2025-10 → 2025-12); seat limits and per-user credit metering added 2026-05-21.
