# PandaCode (aicodeking/pandacode)

_Researched 2026-10-29 against release 0.3.77 (commit `f1e3f0d`)._

- **Positioning**: A small native desktop workspace that runs many coding CLIs side by side (Claude Code, Codex,
  Kimi Code, OpenCode, ACP agents such as Copilot CLI and Grok Build, Pi), with projects, Git, a Terminal, and a
  browser in one window. Adds agent teams (an architect plus workers), a local model router, chat bots, cloud
  sandboxes, simulators, and a task board.
- **Tech stack**: Tauri 2, Rust, SQLite, and plain TypeScript that drives the DOM directly. It uses the system webview:
  no bundled Chromium, resident Node server, React runtime, or embedded editor engine.
- **License**: The MIT License plus one clause: a fork used commercially or released publicly must say it is a fork of
  PandaCode and link the repository.

## Performance work (0.3.74 to 0.3.77)

The author publicly compared 0.3.75 with T3 Code 0.1.3 on one machine, single runs: idle app memory, Renderer work
while streaming a 50 KB reply, memory growth during that stream, and Renderer work for 600 tool updates. The changes
behind those numbers:

- **Delta coalescing in Rust**: consecutive text or thinking deltas merge for up to 33 ms or 8 KB before reaching the
  webview; any other event flushes the buffer first, so ordering holds (`src-tauri/src/providers.rs`, `Coalescer`).
- **Incremental streaming Markdown**: settled top-level blocks stay painted and only the open tail is parsed again;
  block boundaries are found by a line scan that gives up when document-wide syntax (reference definitions,
  footnotes, `<details>`) appears (`src/streaming-markdown.ts`, `blockBoundaries`).
- **Size-bounded caches**: the formatted-Markdown cache is an LRU of about 4 M UTF-16 code units (8 MB) of source plus
  HTML, and text that is still changing never enters it (`src/dom.ts`).
- **Long-session memory**: freed memory is returned to the OS when the last agent ends, sub-agent transcripts keep a
  200-message window, background file tabs keep at most 64 MB, and idle caches are dropped (`src-tauri/src/memory.rs`).
- **Diffs**: Shiki WASM highlighting in a worker pool, virtualized hunk groups mounted in frame slices, and diffs
  primed on hover (`src/diff-viewer.ts`, `src/diff-prefetch.ts`).

## Relevance to Caxri

Caxri already coalesces deltas in Server Core (`chat-projection.ts`, 16 ms) and parses streaming Markdown
incrementally (`packages/markdown/src/streaming-parser.ts`). The idle-memory gap comes mostly from the stack (Electron
and React against a system webview with no framework) and is not a portable technique.
