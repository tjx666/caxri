---
kind: living
status: current
---

# Session content search

Run **Search Session Content** from the Command Palette, the Session menu, or Archived Sessions.
It searches case-insensitive literal text in user and assistant messages from stored Claude,
Codex and Grok Sessions across every added Project. Tool output, reasoning, metadata and Terminal
screen contents are excluded. Grok's consecutive same-role text chunks are joined before matching.

Results show the Session, Project, provider, archive status and a short matching excerpt. Activate
a result with its button or keyboard focus and Enter. Active results open the original Session;
archived results open Archived Sessions, where Restore remains an explicit user action.

The Server derives transcript paths from durable provider identity and reuses the provider's safe
single-link reader. Renderer requests carry only the query. This desktop-owner capability does
not expose arbitrary paths or discover external conversations. Neither a persistent index nor
transcript bodies are written to SQLite or logs.

Each request has a five-second deadline, at most 200 Sessions, 16 MiB of total reads, 4 MiB per
transcript and 100 result excerpts. Parsing retains at most 128 Ki characters of visible text per
transcript; oversized or malformed records mark coverage partial. A metadata-validated process
cache holds at most 64 entries and 8 MiB of text. Even cache hits reauthorize the transcript.

**Partial results** reports searched/total coverage, missing or unsafe data, and result or scan
limits. An incomplete empty result is never described as a definitive absence. Narrow the query
for result limits; retry after unavailable data or resources recover. A query change hides old
results immediately and cancels abandoned work. Two actual scans may run at once; canceled or
timed-out filesystem calls retain their slot until they settle, and cooperative cancellation
stops subsequent reads and directory entries. No Agent CLI is invoked by search.
