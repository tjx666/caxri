# Editor state, search, and diff surfaces

Worker stall diagnostics, debugger-pause evidence, and recovery verification are documented in
[Editor Worker stalls](../../../../docs/editor-worker-stalls.md).

Import navigation resolves relative paths and tsconfig `paths`/`baseUrl` inside Server Core. It selects
the nearest `tsconfig.json` beneath the authorized Project, follows bounded relative `extends` chains,
and retains declaring-directory origins. Parsed JSONC is cached by file identity and metadata; each
request reauthorizes entries and checks ancestors again, so edits and newly created nearer configs
apply without a restart. Config reads are limited to 256 KiB, inheritance to 16 levels and 128 probes,
and candidate file probes to 4096 per request. Every candidate passes the existing workspace-link
authorization, and unresolved or invalid imports remain plain text. Click and keyboard navigation
share this resolver. [Import navigation](../../../../docs/editor-imports.md) documents resolution
order and limits.

The editor remains intentionally narrow: open, edit, save, in-file search, and diff. Broader IDE
surfaces require a separate product decision rather than growing incidentally from file operations.

The Files view resolves a curated, deterministic subset of local `@yutengjing/vscode-icons` file icons by exact filename, well-known directory, test suffix, and extension before falling back to generic file and folder assets. Expanded directories use matching open variants. Vite emits only the explicitly imported SVG subset as separate assets, so icons remain offline-capable without embedding the full upstream catalog in the initial Renderer JavaScript bundle.

Project search is a Session-scoped Server Core read, never a Renderer-supplied root or command. The standalone Server bundles a platform-specific ripgrep executable and invokes it by absolute artifact path with structured arguments, `--no-config`, hidden files enabled, and an independent fixed traversal policy for VCS metadata, dependencies, and build caches rather than `files.exclude` or repository ignore files. Ripgrep only enumerates candidate paths. A terminable Worker revalidates every candidate's canonical Project containment and file identity, rejects symlinks and hard-linked regular files, opens content with `O_NOFOLLOW`, skips binary and oversized documents, and performs JavaScript matching so existing regular-expression and UTF-16 column semantics remain stable without blocking Server Core. The parent owns the shared deadline, file, match, snippet, and total IPC payload limits; at most four Project searches execute across Sessions, and cancellation, timeout, result, payload, and file limits terminate the child process or Worker with an explicit reason. A newer search aborts the prior search only for the same Session and explicit consumer (`project-search` or `path-browser`), so the Search view and quick-open browser cannot cancel each other; the Renderer also keys results by the complete query so a stale response cannot replace a newer query, and it never presents an incomplete empty result as definitive `No results`. Content options cover case, whole word, regular expression, include, and exclude matching, while Monaco reveal intents remain keyed by the Session-specific model URI.

External disk changes always replace an open buffer, including a dirty buffer. This is a deliberate product choice for agent-driven workflows; the Renderer clears dirty state and shows a non-blocking notice rather than opening a conflict dialog. Editor buffers and Monaco model URIs are keyed by Session identity as well as path so Sessions sharing one root cannot reuse each other's dirty state. The Renderer document cache is the sole source of dirty truth because SQLite does not persist unsaved bodies: durable Session tabs are always clean, while a Server Core-only restart reconciles its clean snapshot with surviving Renderer documents before preview replacement or dirty indicators read it. A full Renderer/application restart has no recoverable dirty body and therefore resumes from clean disk state; legacy durable dirty flags are normalized on read. The Renderer reconciles a transient motion identity per Session so clean preview replacement and pinning preserve one visual tab instance, while actual add/close still enter or exit. Clean document contents share a 32 MiB Renderer cache budget across Sessions; dirty buffers are the only exception because reclaiming them would lose unsaved work, and they displace clean buffers first. Closed models do not retain Monaco view state. When a Session becomes active again, cached documents are compared with current disk version metadata; only actual disk changes replace its inactive dirty buffers.

Git file selections open read-only virtual editor tabs instead of embedding patch text in the Inspector. A single-file tab renders a Monaco side-by-side diff; a repository `Open Changes` tab renders its changed files as one scrollable multi-diff surface. Multi-diff rows load their bounded document and mount Monaco only near the viewport; a binary or transient per-file failure remains local to that row. The virtual tab key persists the opaque repository ID and repository-relative path so reload can reconstruct the diff without treating it as a writable filesystem document.

[Git diff review comments](../../../../docs/git-diff-review.md) describes the Session-scoped inline annotation lifecycle and batched Agent Terminal send path.

A `caxri-file-preview://` virtual tab renders a Project file instead of editing it. Which renderer a path receives comes from the Renderer's previewer registry, never from the scheme, so a new format changes the registry and one surface branch rather than the tab contract, persistence, or the explorer's open behavior. Markdown HTML is produced by the DOM-free `@caxri/markdown` package so a later mobile WebView reuses the same engine, and the Renderer sanitizes that output before insertion. Preview images resolve through the ordinary `files.readAsset` request against the Session's Project root and are assigned object URLs after mount, so the document never carries a filesystem path and no Electron-only protocol handler exists for a mobile client to reimplement. Full behavior and the steps for adding a format are in [docs/file-preview.md](../../../../docs/file-preview.md).

For a normal active file tab, Monaco publishes only cursor, selection length, and language identity to Renderer-local Status Bar state. Current-line blame is a bounded, Session-rooted Server Core Git request that selects the deepest approved repository containing the file and returns commit metadata only; diff tabs never masquerade as writable files or issue blame requests.

Package import navigation shares the bounded config metadata cache with tsconfig aliases and
resolves package exports and declarations inside the authorized Project's `node_modules` search
ancestry. Linked package targets keep their lexical workspace entry. Dependency file reads carry
`readOnly` through both ordinary results and binary-stream metadata; Renderer restore honors it,
and Server document writes enforce it independently. See [editor imports](../../../../docs/editor-imports.md).

Session content search is a separate desktop-owner Server read (`session.searchContent`) over
persisted Agent identities. It shares visible-message extraction with title generation, reads
through transcript authorization, and keeps only bounded process-memory text. Query cancellation,
coverage counts and partial outcomes are part of its contract; archived results require explicit
restore. See [Session content search](../../../../docs/session-content-search.md).
