---
kind: living
status: current
---

# File preview

Caxri can render a Project file instead of editing it: Markdown as formatted text, `.svg` as an
image, `.pdf` as pages, `.csv` / `.tsv` as a table, and `.mmd` / `.mermaid` as a diagram. A preview is a virtual editor tab, so it opens, splits, persists, and restores exactly like
a source tab, and the same file can sit open as source in one pane and as a preview in another.

This document covers the shipped behavior, the contracts a new format has to satisfy, and the
reasons behind the decisions that are easy to get wrong later: where HTML is produced, where
binary bytes come from, and how the PDF engine loads its data inside a `file://` Renderer.

## Using it

| Action                               | How                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Open a preview for the active editor | `Cmd+Shift+V`, or **Editor: Open Preview**                                           |
| Open it beside the source            | **Editor: Open Preview to the Side**, or the eye icon at the right of the tab rail   |
| Open it from a tab or the explorer   | Right-click the editor tab or the file in Files → **Open Preview**                   |
| Go from a preview back to its source | The file icon at the right of the tab rail, or right-click the tab → **Open Source** |
| Copy a fenced code block             | Hover the block, click the copy button                                               |
| Jump to a heading                    | Click an in-page link                                                                |
| Follow a link to another document    | Click it: Caxri opens that file as a new editor tab                                  |
| Follow an external link              | Click it: opens in the system browser                                                |

A Markdown file opened from outside every Project (an external document) previews too, rendered
from the editor's buffer. Its relative images and links resolve against the document's own folder
and the folders below it: a link that climbs out (`../`) or reaches outside through a symbolic link
is refused, and a linked file opens as another external document. An external `.svg` has no
preview, because the image view loads its asset through Project file reads.

Double-clicking a Markdown, SVG, CSV/TSV, or Mermaid file in the explorer still opens the source.
Those formats are readable as text, so the preview stays an explicit command; VS Code makes the
same call with `priority.textEditor: 'option'`. A PDF has no useful text form, so it registers
`defaultView: 'preview'`: every open path (Files, Quick Open, a Terminal link) lands on its preview
tab without attempting a text read, and nothing else about the surface changes. Because a PDF tab
is the file's only view, its tab is titled with the bare file name; a preview of a text format
keeps the `Preview:` prefix so it stays distinct from the source tab beside it. On a preview tab
the rail action and the tab menu offer **Open Source** instead of opening another preview; a PDF
has no source, so it offers neither.
Moving a file or folder to the Trash closes its preview tabs along with its source tabs.

Edits re-render live. The preview follows the source editor's scroll position one way: scrolling
the editor moves the preview, and scrolling the preview does not move the editor. Every preview
shows the same **Loading preview…** label while it reads, whatever the format, so one wait never
reads as two steps. A failed read replaces the loading state with a readable cause and one
keyboard-accessible action chosen from the error's structured code
([`document-load-recovery.ts`](../apps/desktop/src/renderer/src/features/editor/document-load-recovery.ts)):
**Retry** for a failure that can go away (a missing file, an interrupted read), and **Open with
Default App** for one that fails the same way every time (a file over a size ceiling, reported as
`CAPACITY` with the limit in MB, or a damaged or protected PDF). The editor and Markdown preview
share the read-attempt lifecycle; switching Session, Workbench Root, or file discards the old
failure, and late results cannot overwrite the current attempt.

Markdown, CSV/TSV, and PDF previews remember where they were per pane and file
([`preview-view-state.ts`](../apps/desktop/src/renderer/src/features/preview/preview-view-state.ts),
a bounded in-memory LRU like the editor's view state): switching to another tab and back returns to
the same scroll position, and a PDF to the same page and zoom. The memory does not survive a
restart. The same file previewed in two panes keeps two positions.

Markdown support is CommonMark plus GitHub task lists, linkified bare URLs, heading anchors,
`mermaid` diagrams, and the raw inline HTML real READMEs depend on (`<details>`, centered banners).
Smart typography is deliberately off, so what you typed is what you see.

## Formats

| Format             | Opens as | Reads                                 | Limits                                 |
| ------------------ | -------- | ------------------------------------- | -------------------------------------- |
| Markdown           | Source   | Editor buffer                         | None beyond the editor's               |
| SVG                | Source   | `files.readAsset`                     | 8 MiB                                  |
| PDF                | Preview  | `files.readAsset` (`application/pdf`) | 32 MiB                                 |
| CSV / TSV          | Source   | Editor buffer                         | First 50,000 data rows and 256 columns |
| `.mmd`, `.mermaid` | Source   | Editor buffer                         | One diagram per file                   |

### PDF

The view is a continuous scroll of pages rendered by
[pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) onto canvases, with a text layer so
text is selectable and copyable, and link annotations so internal links jump and `http(s)` /
`mailto` links open in the system browser. The toolbar above the pages has Previous Page and Next Page buttons
around a page field (type a number and press Enter to jump; Escape restores the current page) and
the page count; the buttons disable at the first and last page. Then come Zoom Out and Zoom In, and the zoom percentage, which opens a menu of Fit Width, Fit Page, and fixed
scales from 50% to 300%. `Ctrl` + wheel (trackpad pinch) zooms around the pointer. `Cmd+=`,
`Cmd+-`, and `Cmd+0` stay window zoom, because the native menu consumes those chords before the
Renderer sees them. Zoom is clamped
to 25% to 500%, and a document opens at page width; a fit keeps following the pane as it resizes
until the user picks a fixed zoom. A screen reader hears the page and zoom after a jump or zoom
from the toolbar, not at every page boundary while scrolling. Pages keep their own colors in every
theme, with a hairline `--border` edge so a white page stays distinct from a light theme; only the
chrome and the gap between pages follow the Caxri theme, the way every PDF reader treats paper.

A damaged or non-PDF file, a password-protected one, and one over 32 MiB each show a readable cause
with **Open with Default App**; a read failure keeps **Retry**. When the file is rewritten on disk
(a save from another app, an Agent regenerating it), the view reads it again after the burst of
watcher events settles and returns to the same page and zoom. A PDF opened from outside every
Project follows Main's external-document watcher instead of the Project's. The old copy stays on screen until
the new one parses, so the reader never sees the view blank out. A reload whose read fails,
usually because it caught a half-written file or a delete-then-rename replacement midway, keeps the
old copy and reads once more a second later; only a second failure replaces the view with the
failure and **Retry**. **Retry** itself always starts over from the loading state. The decisions
live in [`pdf-reload.ts`](../apps/desktop/src/renderer/src/features/preview/pdf-reload.ts). A
watcher batch that overflowed its per-file list does not trigger a re-read, because re-reading
every open PDF on a large checkout costs more than the rare stale view; reopening the tab reads
the file again.

Electron's built-in Chromium viewer was the other option. It needs `plugins: true` plus an
`object-src` / `frame-src` CSP opening, renders inside its own frame where the theme cannot reach,
and has no API for page or zoom state, so pdf.js in the Workbench document was chosen.

pdf.js asks for data files while parsing: binary CMaps for CJK text in non-embedded fonts, the
Symbol and ZapfDingbats standard fonts (other non-embedded standard fonts are drawn with a local
system font), and WebAssembly decoders for JBIG2 and JPEG 2000. Its default is to
`fetch` them from a URL, which a packaged Renderer served from `file://` cannot do.
[`pdf-binary-data.ts`](../apps/desktop/src/renderer/src/features/preview/pdf-binary-data.ts)
instead maps each file to an inline module in its own lazy chunk through a custom
`BinaryDataFactory`, so a document pulls in only the CMap or decoder it uses, and parsing works the
same in development and in the packaged app. The worker is bundled with Vite's `?worker` import
like Monaco's workers. None of this is in the initial Renderer bundle; the size cost is recorded in
[bundle-size.md](bundle-size.md).

Every open PDF shares that one worker through a single long-lived `PDFWorker` passed to each
`getDocument` call, never through `GlobalWorkerOptions.workerPort`. With the global port, pdf.js
lets each loading task tear down the shared `PDFWorker` on `destroy()`, and a PDF opened during that
round trip (switching from one PDF to the next) failed with "the worker is being destroyed" instead
of its own result
([`pdf-document.test.ts`](../apps/desktop/src/renderer/src/features/preview/__tests__/pdf-document.test.ts)).

### CSV and TSV

The table parses the editor's buffer with [Papa Parse](https://www.papaparse.com/), so quoted
fields, escaped quotes, delimiters inside quotes, and line breaks inside a quoted field follow
RFC 4180, and edits in the source pane re-render the table. `.tsv` splits on tabs; `.csv` guesses
among comma, tab, pipe, and semicolon. The first record is the header. Rows are virtualized, so a
50,000-row file scrolls like a short one; numeric columns align right with tabular figures. The
row-number gutter widens with the largest row number, and a cell cut off by its column shows its
full value in a tooltip on hover. A footer reports the row and column count. A row filter above
the table (`Cmd+F`, named in its placeholder) narrows the rows; Escape clears it, and Escape on an
empty filter returns focus to the table. A filter that matches nothing says so and offers
**Clear Filter**. When parsing stops at
the row or column cap, or the parser reports a malformed record, a warning bar above the table says
so (naming the first bad row) and offers **Open Source**, since the table is then not the whole
file. The table exposes ARIA `table`, `rowgroup`, `row`, `columnheader`, and `cell` roles.

### Mermaid

A `.mmd` or `.mermaid` file is one diagram rendered through the same path as a `mermaid` fence in
the Markdown preview (`renderMermaidDiagram`), so both share theme colors, the render permit, the
cache, and the error presentation. A syntax error keeps the last diagram that rendered, dimmed,
with the parser's message below it, until the source parses again; a diagram that never parsed
shows the message alone. The diagram is a `figure`, not an `img`, so the message is readable by a
screen reader. The source is deferred, so typing re-lays out the diagram at low priority, and a
diagram wider than the pane scrolls rather than losing its left edge.

### SVG

An SVG preview reads the file through `files.readAsset` into its own object URL, and reads it again
when the file is rewritten on disk. A failed read shows the cause with the same recovery choice as
every other preview (**Retry**, or **Open with Default App** over the 8 MiB limit). The image's
alternative text is the file name.

## How a preview tab is addressed

`caxri-file-preview://<url-encoded absolute path or external document tab path>`, see
[`packages/protocol/src/domain/file-preview.ts`](../packages/protocol/src/domain/file-preview.ts).
The scheme carries only the source path. Which renderer that path gets is decided by the Renderer's
previewer registry, so adding a format never changes the tab contract or the persisted workspace
layout.

## Pipeline

```text
source text
  └─ @caxri/markdown            renderMarkdown()  → HTML + assets/codeBlocks/diagrams/links
       └─ Renderer              sanitizeMarkdownHtml()  (DOMPurify)
            └─ React            dangerouslySetInnerHTML
                 └─ after mount images, code blocks, diagrams, scroll anchors
```

### `packages/markdown` renders; the host sanitizes

The engine is [markdown-it](https://github.com/markdown-it/markdown-it) behind
[`renderMarkdown`](../packages/markdown/src/render-markdown.ts). It returns an HTML string plus
four side tables: the assets, code blocks, diagrams, and links the document referenced, each
keyed by an id that also appears as a `data-` attribute in the HTML.

Two properties of that package are load-bearing and enforced, not conventions:

- **It has no DOM.** `tsconfig.build.json` drops the `DOM` lib, so touching `document` is a build
  error rather than a runtime one. A mobile client will render this same HTML inside a WebView from
  a React Native runtime that has no `document`; keeping the engine DOM-free is what makes that
  reuse possible. (The test config keeps the lib, because Vitest's own types need it.)
- **Its output is untrusted.** `html: true` passes inline HTML through, so the host must sanitize
  before insertion. That is the same split VS Code uses between its Markdown engine and its preview
  webview. In the Renderer that step is
  [`markdown-sanitize.ts`](../apps/desktop/src/renderer/src/features/preview/markdown-sanitize.ts),
  a DOMPurify pass that forbids `script`, `iframe`, `object`, `embed`, `form`, `link`, `meta`,
  `base`, `style`, and `srcdoc`.

  `style` is on that list for a reason VS Code does not have: its preview owns a separate webview
  document, while this one renders inside the Workbench, so a document-supplied stylesheet would
  restyle the whole application. The other half of that containment is `contain: layout paint` on
  `.caxri-markdown`, which makes the preview the containing block for positioned descendants: a
  document can still ask for `position: fixed` through a `class` or an inline `style`, and the
  worst it can then cover is its own pane.

### Decoration after mount

The sanitized HTML goes into the tree with `dangerouslySetInnerHTML`, and four effects decorate it
afterward, each driven by one of the side tables:

| Module                      | Does                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| `markdown-images.ts`        | Resolves each `<img>` to an object URL                           |
| `markdown-code-blocks.ts`   | Highlights with Monaco, attaches the copy button                 |
| `markdown-diagrams.ts`      | Lazy-loads Mermaid, renders each diagram into its placeholder    |
| `markdown-scroll-follow.ts` | Maps an editor line to a scroll offset using `data-line` anchors |

Every step is abortable via an `AbortSignal` so a fast edit stream never paints a stale document,
and the two expensive ones are memoized by content in a small LRU
([`memo-cache.ts`](../apps/desktop/src/renderer/src/lib/memo-cache.ts)):
Monaco colorization (`lib/code-colorize.ts`, shared with Agent Chat) keyed by theme, language, and source, Mermaid output keyed by diagram source. Typing
one character therefore re-renders the Markdown but reuses every untouched block.

Code highlighting reuses `monaco.editor.colorize()` against the live `caxri-active` theme. That
adds no highlighting dependency and makes a code block in the preview exactly the colors it has in
the editor next to it. Mermaid is loaded on demand with a dynamic `import()` and initialized with
`securityLevel: 'strict'` and theme variables derived from the active Caxri theme tokens; changing
the theme re-initializes it and drops the cache. Mermaid layouts share one Renderer-wide permit,
including theme initialization, and yield an event-loop task between diagrams so input and tab
changes can run. Leaving the preview skips queued layouts and prevents stale DOM writes. One
individual Mermaid layout still runs on the main thread.

### Images never carry a filesystem path

The rendered HTML emits `<img data-caxri-asset="…">` with **no `src`**. The Renderer reads the
bytes through `files.readAsset` (a normal typed request, authorized against the Session's Project
root like every other file read) and assigns a `blob:` object URL after mount. Object URLs are
reference-counted in
[`preview-asset-client.ts`](../apps/desktop/src/renderer/src/features/preview/preview-asset-client.ts)
so the same image in two open previews is read once and revoked when the last one closes.
Across mounted previews, at most four distinct reads run concurrently; the permit includes IPC,
base64 decoding, and Blob creation. Electron's native `Uint8Array.fromBase64` replaces a JavaScript
loop per byte while retaining an `ArrayBuffer`-backed view. The focused preview E2E compares both
decoders in the same Renderer at the 8 MiB ceiling and records timings without asset contents.

`files.readAsset` returns base64 over the ordinary request channel rather than through an Electron
custom protocol handler, and its media type comes from a Server-side allowlist that never echoes a
caller-supplied value (`previewAssetMediaTypes`; 8 MiB for images, 32 MiB for PDF). Both choices exist for the same
reason: a mobile client gets images through the identical request, with no Electron-only path to
reimplement.

The Renderer CSP allows `img-src 'self' data: blob: https:`. `blob:` is the mechanism above.
`https:` lets README badges render, matching VS Code's default Markdown preview security: the
tradeoff is that opening such a document tells the badge host. Plain `http:` stays blocked.

## Adding a format

Everything format-specific lives in two places.

1. Add the extensions to `PREVIEWERS` in
   [`preview-registry.ts`](../apps/desktop/src/renderer/src/features/preview/preview-registry.ts)
   with a view id and a `defaultView`.
2. Add the matching branch to `PreviewSurface` in
   [`preview-surface.tsx`](../apps/desktop/src/renderer/src/features/preview/preview-surface.tsx).
   Keep the view itself in its own lazily imported module, as the PDF and table views are, so its
   dependencies never enter the initial Renderer bundle.

The commands, the tab scheme, split-to-the-side, persistence, and the explorer's open behavior all
read from the registry and need no change. A format that renders from text reads it with
`useDocument` like `MarkdownPreviewSurface`; a binary format reads bytes with `files.readAsset`
like `ImagePreview` or `PdfPreview`, and extends `previewAssetMediaTypes` in
[`preview-asset.ts`](../packages/protocol/src/domain/preview-asset.ts) if its type is not on the
allowlist yet. A document type larger than an image gets its own ceiling in
`previewAssetByteLimit` instead of raising the 8 MiB image cap.

If a future format needs its own rendering engine, put the engine in a `packages/*` package under
the same two rules as `@caxri/markdown` (no DOM, untrusted output) so the mobile client can reuse
it.

## Known limits

- Scroll sync is one-way by design: the source editor drives the preview. It applies to Markdown
  only.
- PDF previews need a Project: a PDF opened from outside every Project has no preview yet. There
  is no in-document search, password prompt, or outline sidebar.
- PDF ICC color profiles are not applied: pdf.js turns ICC conversion off when it cannot fetch its
  data from the worker, and draws those colors through the profile's alternate color space.
- A preview of an unsaved buffer renders the buffer; images and relative links still resolve
  against the file's on-disk location.
- **Open Preview to the Side** falls back to opening in place when the source is the only tab in
  its pane, because splitting would leave an empty pane behind.
- Styling lives in
  [`markdown-preview.css`](../apps/desktop/src/renderer/src/styles/markdown-preview.css) and uses
  only semantic theme tokens, so an imported theme restyles the preview with everything else.
