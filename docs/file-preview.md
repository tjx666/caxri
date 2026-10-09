---
kind: living
status: current
---

# File preview

Caxri can render a Project file instead of editing it: Markdown as formatted text, `.svg` as an
image. A preview is a virtual editor tab, so it opens, splits, persists, and restores exactly like
a source tab, and the same file can sit open as source in one pane and as a preview in another.

This document covers the shipped behavior, the contracts a new format has to satisfy, and the
reasons behind the two decisions that are easy to get wrong later: where HTML is produced, and
where images come from.

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

Double-clicking a Markdown or SVG file in the explorer still opens the source. Both formats are
readable as text, so the preview stays an explicit command; VS Code makes the same call with
`priority.textEditor: 'option'`. A format with no useful text form registers `defaultView:
'preview'` instead and nothing else about the surface changes.

Edits re-render live. The preview follows the source editor's scroll position one way: scrolling
the editor moves the preview, and scrolling the preview does not move the editor. A failed source
read replaces the loading state with a readable cause and a keyboard-accessible **Retry** button.
The editor and Markdown preview share the read-attempt lifecycle; switching Session, Workbench
Root, or file discards the old failure, and late results cannot overwrite the current attempt.

Markdown support is CommonMark plus GitHub task lists, linkified bare URLs, heading anchors,
`mermaid` diagrams, and the raw inline HTML real READMEs depend on (`<details>`, centered banners).
Smart typography is deliberately off, so what you typed is what you see.

## How a preview tab is addressed

`caxri-file-preview://<url-encoded absolute path>`, see
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
caller-supplied value (`previewAssetMediaTypes`, 8 MiB cap). Both choices exist for the same
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

The commands, the tab scheme, split-to-the-side, persistence, and the explorer's open behavior all
read from the registry and need no change. A format that renders from text reads it with
`useDocument` like `MarkdownPreviewSurface`; a binary format reads bytes with `files.readAsset`
like `ImagePreview`, and extends `previewAssetMediaTypes` if its type is not on the
allowlist yet.

If a future format needs its own rendering engine, put the engine in a `packages/*` package under
the same two rules as `@caxri/markdown` (no DOM, untrusted output) so the mobile client can reuse
it.

## Known limits

- Scroll sync is one-way by design: the source editor drives the preview.
- A preview of an unsaved buffer renders the buffer; images and relative links still resolve
  against the file's on-disk location.
- **Open Preview to the Side** falls back to opening in place when the source is the only tab in
  its pane, because splitting would leave an empty pane behind.
- Styling lives in
  [`markdown-preview.css`](../apps/desktop/src/renderer/src/styles/markdown-preview.css) and uses
  only semantic theme tokens, so an imported theme restyles the preview with everything else.
