---
kind: living
status: current
---

# Share to a Session

The packaged macOS app ships a share extension, so **Caxri** appears in the system Share menu and in
apps that forward through it, such as WeChat's "Forward to other apps". Sharing files, images, a
link, or text into Caxri asks which Session should receive them, then puts them into that Session's
Agent Chat composer: files as file cards, text as the draft. Nothing is sent until the user sends it.

The entry point follows Dukou, which receives forwarded WeChat chats through the same macOS
Share menu; Caxri differs by letting the user pick the receiving Session and by never sending on
its own.

## Flow

1. The share extension (`apps/desktop/native/share-extension/ShareViewController.swift`) runs in the
   sharing app's process, sandboxed. It copies each shared file into its own request folder,
   `~/Library/Application Support/Caxri/Share Inbox/<request id>/`, and writes the manifest
   `request.caxrishare` beside them (file names plus any shared text or link).
2. It opens that manifest with Caxri. A sandboxed extension cannot reliably open a custom URL
   scheme, so the hand-off is an ordinary "open document" request for a document type Caxri owns
   (`com.caxri.share-request`, declared in the root `package.json` build settings).
3. Main holds every `open-file` request from the start of launch
   (`apps/desktop/src/main/external-activation/open-file-requests.ts`), so a share that cold-starts
   Caxri is not lost. Once the Workbench can receive it, Main validates the manifest
   (`apps/desktop/src/main/external-activation/share-inbox.ts`), raises the window, and sends the
   `desktop.shareReceived` event.
4. The Renderer shows the Send to Session picker
   (`apps/desktop/src/renderer/src/features/share/share-to-session-dialog.tsx`). Shares that arrive
   while it is open join the pending request. Choosing a Session selects it and fills its Agent
   Chat composer; a Session with only Terminals gets the file paths typed at its prompt, spelled as a
   drop would be, without the text, because a line break typed into a shell would run it.

## Trust boundary

Any app can ask Caxri to open a document, so Main accepts a manifest only when it is the
`request.caxrishare` of a folder named by a request id directly inside the Share Inbox. Every file
it lists must be a real entry of that folder: path separators, symlinks, and missing files reject
the whole request. Rejections are logged as `desktop.share_rejected` with a closed reason.

## Lifecycle

- Shared copies stay in the Share Inbox so an Agent that was handed them still finds them when the
  conversation continues. A packaged app removes request folders older than 30 days at startup
  (`desktop.share_inbox_pruned`).
- macOS registers a new share extension without enabling it. On startup a packaged app enables it
  only when the user never chose either way; an extension the user turned off in System Settings
  stays off (`desktop.share_extension_election`).
- Development builds do not contain the extension and never prune the inbox or change the
  extension's election, which belong to the installed app.

## Build

`bun run build:share-extension` (part of `bun run build`, macOS only) compiles the extension for
both Mac architectures and ad-hoc signs it with its sandbox entitlements into
`out/share-extension/`; packaging copies it to `Caxri.app/Contents/PlugIns/`. Release packaging does
not re-sign the app, so a future Developer ID build must sign the extension with the same
entitlements.
