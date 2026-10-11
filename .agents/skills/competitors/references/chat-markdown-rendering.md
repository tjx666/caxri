# Streaming chat Markdown rendering

_Researched 2026-10-11 from source in `competitors/`. Paths are relative to each clone._

How popular AI chat clients and Agent workbenches keep a streaming reply's Markdown cheap to render.
Caxri's resulting design lives in `docs/agent-chat.md` (Pane section) and
`packages/markdown/src/streaming-parser.ts`.

## Consensus

Every mature implementation stopped re-parsing the whole message per delta. They freeze a settled
prefix of top-level blocks, re-parse only the tail, and memoize each rendered block by its source
string or object identity rather than a deep structural comparison. All fall back to a full parse
when a link reference or footnote definition (document-global constructs) appears. None gates
Markdown performance in a blocking PR check; assistant-ui's count-based contracts come closest.

## Per product

- **Streamdown (Apache-2.0)**
  - Parse and reuse: `marked` block lexer; `packages/streamdown/lib/parse-blocks.tsx` `reuseParsedBlocks` re-lexes only after the last two blocks when the new text extends the old; `Block` memo compares the raw string. Removed `useTransition` because it starved under constant deltas.
  - Incomplete syntax: `packages/remend` closes `**`, backticks, `$$`, links on the tail.
  - Heavy features: Shiki lazy and cached once complete; Mermaid lazy, viewport-gated, debounced.
  - Performance tests: Vitest benches in `__benchmarks__/`, not run in CI.
- **LobeHub (`lobe-ui`, `@lobehub/streamdown`: MIT)**
  - Parse and reuse: `src/blockLexer.ts` freezes blocks followed by a blank `space` token and lexes only the tail; `useSmoothStreamContent.ts` paces commits with an EMA of arrival rate.
  - Incomplete syntax: remend on the tail; LaTeX keeps the last renderable version.
  - Heavy features: `@shikijs/stream` incremental highlighting; Mermaid debounced. Transcript virtualized with virtua.
  - Performance tests: Manual demo bench only.
- **Cherry Studio (AGPL-3.0, ideas only)**
  - Parse and reuse: Uses `streamdown`; source throttled with `experimental_throttle: 100` ("melts the renderer" without it); rAF smoothing by grapheme.
  - Incomplete syntax: Streamdown's.
  - Heavy features: Streaming code is not highlighted; completed code highlighted by Shiki in a worker. Transcript virtualized (virtua).
  - Performance tests: None.
- **LibreChat (MIT)**
  - Parse and reuse: `client/src/components/Chat/Messages/Content/splitMarkdown.ts` splits with mdast and re-parses from the second-to-last block; SSE deltas merged per animation frame.
  - Incomplete syntax: None; the unstable second-to-last block absorbs it.
  - Heavy features: Mermaid debounced.
  - Performance tests: `MarkdownBlocks.bench.tsx`; Lighthouse budget workflow fails PRs.
- **assistant-ui (MIT)**
  - Parse and reuse: Deep structural hast memoization (Caxri's previous approach), migrating to Streamdown.
  - Incomplete syntax: Tail-bounded remend.
  - Heavy features: Delegated.
  - Performance tests: `packages/x-performance` asserts exact render, commit, and parse counts with zero tolerance in CI; timing benches are advisory.
- **t3code (MIT)**
  - Parse and reuse: `apps/web/src/markdown-incremental.ts` caches the mdast prefix before the last closed fence and parses only the tail; falls back on definitions, `\r`, BOM.
  - Incomplete syntax: None.
  - Heavy features: Shiki resumes from the last complete line's grammar state; Mermaid after the stream ends.
  - Performance tests: `markdown-incremental.test.tsx` compares incremental and full parses at every prefix length.
- **Orca (MIT)**
  - Parse and reuse: `sidebar/markdown-top-level-blocks.ts` reuses remark top-level blocks, re-parsing from the second-to-last (`UNSETTLED_BLOCKS = 2`); block key is the source offset.
  - Incomplete syntax: remend on the last block only.
  - Heavy features: No Mermaid while streaming; transcript windowed.
  - Performance tests: None.
- **Paseo (Apache-2.0)**
  - Parse and reuse: markdown-it with inline rules disabled finds block boundaries (`utils/split-markdown-blocks.ts`); each block is a memoized component.
  - Incomplete syntax: markdown-it inline rules on the last inline token (`utils/streaming-markdown/`), never rewriting the source.
  - Heavy features: Mermaid in an isolated iframe after completion; transcript virtualized.
  - Performance tests: Opt-in E2E smoothness budgets (commit p95 under 12 ms), skipped in CI.
- **mux (AGPL-3.0, ideas only)**
  - Parse and reuse: `ChunkedStreamingMarkdown.tsx` seals ~2,000-character chunks of whole blocks; bypasses `useDeferredValue` while streaming because constant deltas kept deferring it.
  - Incomplete syntax: remend 1.4 on the last block (older remend cost 300 ms per frame on a 60k block).
  - Heavy features: Highlighting in a worker with a timeout and plain-text fallback.
  - Performance tests: Nightly Playwright wall-clock budgets, not PR-blocking.
- **Codex TUI (Apache-2.0)**
  - Parse and reuse: `tui/src/markdown_stream.rs` commits only complete lines; stable region goes to scrollback, a mutable tail is re-rendered.
  - Incomplete syntax: Tables held back until stable (`streaming/table_holdback.rs`).
  - Heavy features: Mermaid after the fence closes.
  - Performance tests: None.
- **Open WebUI, NextChat, Chatbox, Jean, Synara**
  - Parse and reuse: Full re-parse per update, mitigated by rAF batching (Open WebUI, NextChat, Jean) or 40 ms commit pacing (Synara).
  - Incomplete syntax: Mostly none; Jean runs remend on the whole text.
  - Heavy features: Chatbox skips highlighting and Mermaid while streaming.
  - Performance tests: Synara's perf tests are opt-in.

## Caxri decisions drawn from this

- Adopted: tail-only re-parse with identity reuse, keeping markdown-it as the only judge of block
  boundaries (reuse starts at a top-level construct whose first line and the line after it are complete
  and unchanged, which is
  stricter than "the last two blocks" and proven equal to a full parse character by character, as
  t3code tests it); fallback on link reference definitions; a count-based CI gate in the
  assistant-ui style instead of a wall-clock budget.
- Already in place: Server Core coalesces deltas into 16 ms patches (the rAF batching others add in
  the client), and fenced code is colorized only once the fence closes.
- Not adopted yet: transcript virtualization (Agent Chat bounds a Chat to 1,000 items), a worker for
  code colorization, and smoothing animations, which are product choices rather than parse cost.
