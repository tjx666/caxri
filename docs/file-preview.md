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

| Action                               | How                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Open a preview for the active editor | `Cmd+Shift+V`, or **Editor: Open Preview**                                         |
| Open it beside the source            | **Editor: Open Preview to the Side**, or the eye icon at the right of the tab rail |
| Open it from a tab or the explorer   | Right-click the editor tab or the file in Files → **Open Preview**                 |
| Copy a fenced code block             | Hover the block, click the copy button                                             |
| Jump to a heading                    | Click an in-page link                                                              |
| Follow a link to another document    | Click it: Caxri opens that file as a new editor tab                                |
| Follow an external link              | Click it: opens in the system browser                                              |

A Markdown file opened from outside every Project (an external document) previews too, rendered
from the editor's buffer. Its relative images and links resolve against the document's own folder
and the folders below it: a link that climbs out (`../`) or reaches outside through a symbolic link
is refused, and a linked file opens as another external document. An external `.svg` has no
preview, because the image view loads its asset through Project file reads.

Double-clicking a Markdown, SVG, CSV/TSV, or Mermaid file in the explorer still opens the source.
Those formats are readable as text, so the preview stays an explicit command; VS Code makes the
same call with `priority.textEditor: 'option'`. A PDF has no useful text form, so it registers
`defaultView: 'preview'`: every open path (Files, Quick Open, a Terminal link) lands on its preview
tab without attempting a text read, and nothing else about the surface changes.
Moving a file or folder to the Trash closes its preview tabs along with its source tabs.

Edits re-render live. The preview follows the source editor's scroll position one way: scrolling
the editor moves the preview, and scrolling the preview does not move the editor. A failed source
read replaces the loading state with a readable cause and a keyboard-accessible **Retry** button.
The editor and Markdown preview share the read-attempt lifecycle; switching Session, Workbench
Root, or file discards the old failure, and late results cannot overwrite the current attempt.

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
`mailto` links open in the system browser. A toolbar above the pages shows **Page N of M** and
offers Zoom Out, Zoom In, and Fit Width; `Ctrl` + wheel (trackpad pinch) zooms around the pointer.
Zoom is clamped to 25% to 500%, and a document opens at page width, which it keeps as the pane
resizes until the user picks another zoom. Pages keep their own colors in every theme; only the
chrome and the gap between pages follow the Caxri theme, the way every PDF reader treats paper.

A damaged or non-PDF file, a password-protected one, and one over 32 MiB each show a readable cause
with **Retry**. The bytes are read once when the tab opens; the view does not follow later changes
on disk (Retry, or reopening the tab, reads it again).

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

### CSV and TSV

The table parses the editor's buffer with [Papa Parse](https://www.papaparse.com/), so quoted
fields, escaped quotes, delimiters inside quotes, and line breaks inside a quoted field follow
RFC 4180, and edits in the source pane re-render the table. `.tsv` splits on tabs; `.csv` guesses
among comma, tab, pipe, and semicolon. The first record is the header. Rows are virtualized, so a
50,000-row file scrolls like a short one; numeric columns align right with tabular figures. A
footer reports the row and column count. When parsing stops at the row or column cap, or the parser
reports a malformed record, a warning bar above the table says so and names the first bad row.

### Mermaid

A `.mmd` or `.mermaid` file is one diagram rendered through the same path as a `mermaid` fence in
the Markdown preview (`renderMermaidDiagram`), so both share theme colors, the render permit, the
cache, and the error presentation: a syntax error shows the parser's message in place of the
diagram until the source parses again. The source is deferred, so typing re-lays out the diagram
at low priority.

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
