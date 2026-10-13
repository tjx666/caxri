# Cross-Agent session history search

_Researched 2026-10-13 from source (`competitors/` clones plus the session tools below). Paths are
relative to each clone._

How Agent workbenches and standalone session browsers find, index, and reopen the conversations
Claude Code, Codex, and other CLIs leave on disk. Caxri's resulting design is
`docs/session-search.md`.

## Consensus

- One discovery adapter per provider lists files by `stat` only; content is parsed later, newest
  first, so recent conversations become searchable before old history.
- A persistent SQLite FTS5 index with an external content table, updated incrementally from a
  per-file cursor (identity plus byte offset). A shrunk or replaced file is re-read from the start.
- Only user and assistant text is indexed, with tool output excluded or truncated and inline images
  stripped. Subagent and scripted runs are hidden or nested under their parent; on a busy machine
  they are most of the files.
- Title, ID, and folder matches outrank message matches. A pasted conversation ID should land first.

## Per product

- **Wake (MIT, Rust, <https://github.com/iAmCorey/Wake>)**
  - Discovery: adapters for 23 Agents behind one contract
    (`crates/wake-core/src/adapters/mod.rs`); Claude titles from `custom-title`, then the first
    real prompt; Codex metadata from `state_5.sqlite` `threads` when readable.
  - Index: `messages_fts` external content table with `trigram case_sensitive 0`, a separate
    `titles_fts`, messages capped at 32 KB, a format version that forces a rebuild
    (`crates/wake-core/src/db.rs`).
  - Query: terms quoted and ANDed; any term under three code points falls back to a `LIKE` scan
    with a visible "short query" note; rank is bm25 times a 30-day recency boost.
  - Gaps: ignores Claude `ai-title` records; one result row per message rather than per session.
- **Orca (MIT)**: opt-in FTS5 with user, assistant, tool, and identifier columns; a `files` table
  with inode, size, mtime, and byte offset; content-hash folding of forked sessions; Claude title
  order `custom-title`, `ai-title`, first prompt
  (`src/main/ai-vault/session-scanner-agent-sources.ts`). No CJK tokenization.
- **cmux (GPL-3.0, ideas only)**: richest query syntax (`agent:`, `repo:`, `before:`, quoted
  phrases); content search shells out to `rg --fixed-strings` without snippets.
- **Kooky (MIT)**: metadata only (first 256 KB per file, 150 newest per provider); jumps to an
  already-open tab instead of resuming twice.
- **Jean, Paseo (Apache-2.0)**: real "import external session" flows that hide already-imported
  ones; Paseo's lives in `Cmd+K` with a workspace scope toggle.
- **agentsview (MIT, Go, <https://github.com/kenn-io/agentsview>)**: resumes appended JSONL from
  a recorded byte offset; optional jieba-segmented FTS table for Chinese.
- **agent-sessions (MIT, Swift, <https://github.com/jazzyalex/agent-sessions>)**: indexes a 48k
  character sample per session; scans files written in the last 120 seconds live at query time.
- **coding_agent_session_search (MIT plus usage restrictions; review before copying)**: bm25 with
  a 14-day recency half-life; a full rebuild of 3.7M messages peaked at 13 to 17 GB of memory.

## Pitfalls observed

- Forks and continuations copy their parent's history, so per-message results duplicate.
- Codex `response_item` user messages carry the injected AGENTS.md; titles should come from the
  thread name or the first real prompt.
- Claude encodes the folder lossily in its directory name; read `cwd` from records instead.
- Single transcripts reach hundreds of megabytes: parse as a stream with a per-line ceiling.
- Resume needs the original folder; when it is gone, say so instead of starting elsewhere.
