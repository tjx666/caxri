# Desktop isolation and filesystem grants

BrowserWindows use `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderers, a restrictive CSP, blocked navigation, and denied new windows. Renderer may request only an HTTP(S) external open; Main re-parses and canonicalizes the URL, rejects credentials and unsupported protocols, and owns every system-browser call. Loopback origins are trusted by default. A configured exact origin or explicit wildcard matches only the same scheme and port; malformed rules fail closed. Every other origin requires a native confirmation, and choosing trust persists its canonical exact origin before opening. Passive navigation and new-window attempts remain denied rather than acquiring trust authority. No telemetry or remote upload exists.

The Renderer CSP's `img-src` is `'self' data: blob: https:`. `blob:` carries preview images, which are read through the ordinary authorized `files.readAsset` request and never as a `file:` URL. `https:` exists so a README badge renders in the Markdown preview, matching VS Code's default Markdown preview security; plain `http:` stays blocked. The cost is that opening such a document tells the remote host, and because the preview shares the Workbench document rather than a webview, that allowance applies to the whole Renderer. A surface that renders untrusted content must therefore contain it itself: the Markdown preview forbids `<style>` at the sanitizer and sets `contain: layout paint` on its body. Widening `img-src` further, or adding any other remote-fetching directive, is a product decision, not a local one.

Folder-picker results create single-use Main-process grants. A grant is revoked when the Agent choice or Workbench authorization is canceled, expires after 60 seconds if unused, and is consumed before Project creation reaches the Server Core. An automatic worktree candidate carries an opaque ID and a display-only destination path to the Renderer. Choosing Continue submits only the ID: Main claims and canonicalizes its Server Core path, creates a single-use grant, and Server Core revalidates the candidate and linked-worktree topology before registering the Project. Once a Project exists, new Sessions reference its stable owning ID and cannot submit or broaden a root path. A Workbench selection may reference only an already authorized Project that current structured Git topology proves is a linked worktree of that owner. The Server Core persists the selected root's device and inode, revalidates identity and topology on access/focus/watch failure, and atomically falls back to the owning Project when the worktree disappears or is replaced.

The local Desktop's free-path browser is an explicit-input, developer-tool capability, not a durable
root grant. It exposes bounded enumeration and one file snapshot per opened file. Opening a file
registers it in Main's per-lifetime external document registry, and that registry is the whole authority
of the `externalDocument.*` methods: saving the file in place, revealing it, opening it with the default
app, starting a Terminal in its folder through the Main-only `terminal.createInExternalDirectory`,
re-reading it after Main's folder watch reports an outside change, and loading preview images or
opening linked files held to the document's folder and the folders below it. That Terminal's cwd is persisted on its Terminal record like any other cwd. The browser cannot authorize
Files, Search, Git, Project creation, or a Renderer-supplied Terminal cwd; see
[Files and paths](files-and-paths.md) for the save checks. Add Project
and Agent folder selection use the native picker and single-use grants above. The Workbench Root
picker discovers all available linked worktrees without registering Projects or emitting Agent
follow prompts. Its explicit authorization confirmation displays the destination and submits only
a worktree ID bound to the repository, Session, canonical path, device, and inode. Main resolves
that ID through fresh Server topology and consumes a single-use grant; Server checks the ID again
before registration. Unknown creation times remain unknown; ordering uses the linked checkout's
`.git` pointer birth time, never its changing modification time. Detected Agent worktrees use
explicit Continue or the user's standing automatic-follow policy described above. Remote Clients
receive neither the same-machine free-path capability nor a way to submit a local Client path to
Server Core.

Every path that registers a Project is one of these authorities; a new one belongs in this list:

- The Desktop native folder picker, through the single-use Main grant above (Add Project, Agent folder
  selection).
- A linked worktree of an existing Project: a detected Agent worktree (explicit Continue or the
  standing automatic-follow policy) or a Workbench Root picker choice, each revalidated against the
  owning Project's linked-worktree topology before registration.
- `mobile.project.add` from a paired device with the `control` role. Server Core resolves the typed
  path inside the Server user's home directory, registers the owning root, and grants the new Project
  to that device; see [mobile authorization](../../../../docs/mobile/authorization.md#adding-a-project-from-mobile).
- The Agent Commander system Project, which Server Core registers for its own `agent-commander`
  workspace inside the profile; no Client supplies that path.
- The external-caller delegation bootstrap: the profile owner's confirmed
  `caxri agent delegate access create --root <path> --register-project`. Server Core
  (`agent.delegation.access.bootstrap`, `apps/server/src/domains/db/delegation-context.ts`)
  canonicalizes the root, reuses an existing Project for that exact root or creates an ordinary,
  visible Project only when `--register-project` is set, rejects a non-top-level (worktree) Project,
  and creates or reuses a dedicated Session in the same transaction without changing the Desktop's
  selection; see [external callers](../../../../docs/agent-delegation.md#external-callers-and-directory-authorization).
- The SSH Host folder browser. An SSH Host window has no native picker for the SSH Host's disk, so the
  Renderer submits the folder chosen in the browser that `project.browseFolders` serves, and Main
  forwards it to the SSH Host's own Server without a grant; that Server canonicalizes it. The window's
  account can already read that folder, so the authority is the user's choice in that browser; see
  [Remote SSH](../../../../docs/remote-ssh.md).
- Commander hand-over of an Agent conversation started outside Caxri. Server Core adds the
  conversation's folder as a Project when no visible Project contains it. Only the owner's Desktop and
  human CLI may call `commander.session.handOver`; Server Core refuses every other principal, including
  an Agent Endpoint holding an `agent:control` grant; see
  [Agent Commander](../../../../docs/agent-commander.md).

## Main outbound requests

Electron Main makes only these outbound HTTP requests; a new one belongs in this list with its
trigger and caps, and every response body is read under a byte cap. None uploads user data. Status
reads use Electron's `net.fetch`, so the system proxy, cookies, and Chromium's HTTP cache apply.
Link favicons and previews happen without a click, so they go through `createPublicHttpsFetch`
(`apps/desktop/src/main/public-https-fetch.ts`) over `net.request` (system proxy and HTTP cache, no
session cookies): every hop must be `https:` and its host must be, or resolve through Chromium's
resolver only to, public addresses. Loopback, `localhost`, RFC 1918 private, carrier-grade NAT,
link-local (including `169.254.169.254`), multicast, reserved, and IPv6 unique-local or link-local
addresses are refused before any request; `198.18.0.0/15` stays allowed because fake-IP proxy
clients answer public hosts from it. A hostname the local resolver cannot resolve is still requested
(only the URL-only checks apply): behind an HTTP or PAC proxy on a network without outside DNS,
the proxy resolves the name, and a name this machine cannot resolve cannot reach a local service
over a direct connection. Redirects are followed manually, at most 5, each target vetted
the same way. A refused link keeps the globe icon and a card without a page preview; clicking it is
unchanged. DNS rebinding between the check and the connection is out of scope for the single-user
threat model.

- **Link favicons** (`links.favicon`, `apps/desktop/src/main/link-favicons.ts`):
  `GET <origin>/favicon.ico` when a transcript renders a web link (GitHub links use a bundled mark).
  The contract accepts only an `https://` origin. 5 s timeout, 32 KiB body cap, one cached result
  per origin for the app's lifetime (at most 256 origins, oldest inserted evicted first); an
  outright failure is not cached.
- **Link previews** (`links.preview`, `apps/desktop/src/main/link-previews.ts`): `GET` of the linked
  `https:` URL only while the user hovers that link's card. 5 s timeout, reads at most 256 KiB and
  stops at `</head>`, parses only title, description, and an `https:` share image; cached per URL
  with the same 256-entry, insertion-order eviction and no caching of outright failures.
- **Agent provider status** (`agentProviderStatus.read`,
  `apps/desktop/src/main/agent-provider-status.ts`): the fixed public Statuspage endpoints for
  Claude and OpenAI, polled every 60 s while a status bar tok/s item or an Agent status tab for that
  provider is mounted. 10 s timeout, 2 MiB body cap (a larger body reads as `invalidResponse`); cached per
  provider for 60 s after success and 30 s after failure. E2E launches read
  fixtures instead.
- **Update check and download** (`apps/desktop/src/main/updates.ts`): the GitHub latest-release API,
  once automatically per packaged launch (skipped in E2E and acceptance discovery) and on a manual
  check. 15 s timeout and 1 MiB response cap; 404 and rate-limit responses degrade to
  `unavailable`. Only a user-started download fetches the release checksum (4 KiB cap) and DMG
  (1 GiB cap).

## Server outbound requests

Server Core makes only this outbound HTTP request; a new one belongs here with its trigger and caps.
It uses Node's `fetch`, uploads no user data, and is replaced by an immediate failure under
`CAXRI_E2E=1`, so E2E and Acceptance runs stay offline.

- **Model price list** (`apps/server/src/domains/usage/pricing.ts`): `GET` of LiteLLM's public
  `model_prices_and_context_window.json` on raw.githubusercontent.com when a Usage report finds the
  cached copy older than a day. 15 s timeout; the body is streamed and dropped past 16 MiB. Any
  failure falls back to the cached copy, then the snapshot bundled at build time.
