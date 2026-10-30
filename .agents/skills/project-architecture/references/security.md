# Desktop isolation and filesystem grants

BrowserWindows use `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderers, a restrictive CSP, blocked navigation, and denied new windows. Renderer may request only an HTTP(S) external open; Main re-parses and canonicalizes the URL, rejects credentials and unsupported protocols, and owns every system-browser call. Loopback origins are trusted by default. A configured exact origin or explicit wildcard matches only the same scheme and port; malformed rules fail closed. Every other origin requires a native confirmation, and choosing trust persists its canonical exact origin before opening. Passive navigation and new-window attempts remain denied rather than acquiring trust authority. No telemetry or remote upload exists.

The Renderer CSP's `img-src` is `'self' data: blob: https:`. `blob:` carries preview images, which are read through the ordinary authorized `files.readAsset` request and never as a `file:` URL. `https:` exists so a README badge renders in the Markdown preview, matching VS Code's default Markdown preview security; plain `http:` stays blocked. The cost is that opening such a document tells the remote host, and because the preview shares the Workbench document rather than a webview, that allowance applies to the whole Renderer. A surface that renders untrusted content must therefore contain it itself: the Markdown preview forbids `<style>` at the sanitizer and sets `contain: layout paint` on its body. Widening `img-src` further, or adding any other remote-fetching directive, is a product decision, not a local one.

Folder-picker results create single-use Main-process grants. A grant is revoked when the Agent choice or Workbench authorization is canceled, expires after 60 seconds if unused, and is consumed on successful Project creation. At pick time Main also captures the folder's canonical path, device, and inode in the grant; `project.create` injects that identity as `expectedRootIdentity` (a Renderer-supplied one is dropped) and sends the canonical path, and Server Core remains the final authority and answers `PATH_DENIED` when a different object now sits at the path, which spends the grant. An automatic worktree candidate carries an opaque ID and a display-only destination path to the Renderer. Choosing Continue submits only the ID: Main claims and canonicalizes its Server Core path, creates a single-use grant, and Server Core revalidates the candidate and linked-worktree topology before registering the Project. Once a Project exists, new Sessions reference its stable owning ID and cannot submit or broaden a root path. A Workbench selection may reference only an already authorized Project that current structured Git topology proves is a linked worktree of that owner. The Server Core persists the selected root's device and inode, revalidates identity and topology on access/focus/watch failure, and atomically falls back to the owning Project when the worktree disappears or is replaced.

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
- Caxri Bot's system Project, which Server Core registers for its own `caxri-bot`
  workspace inside the profile; no Client supplies that path.
- The external-caller delegation bootstrap: the profile owner's confirmed
  `caxri agent delegate access create --root <path> --register-project`. Server Core
  (`agent.delegation.access.bootstrap`, `apps/server/src/domains/db/delegation-context.ts`)
  canonicalizes the root, reuses an existing Project for that exact root (un-hiding it if the user
  hid it, so the delegated Session is visible) or creates an ordinary,
  visible Project only when `--register-project` is set, rejects a non-top-level (worktree) Project,
  and creates or reuses a dedicated Session in the same transaction without changing the Desktop's
  selection; see [external callers](../../../../docs/agent-delegation.md#external-callers-and-directory-authorization).
- The SSH Host folder browser. An SSH Host window has no native picker for the SSH Host's disk, so the
  Renderer submits the folder chosen in the browser that `project.browseFolders` serves, and Main
  forwards it to the SSH Host's own Server without a grant; that Server canonicalizes it. The window's
  account can already read that folder, so the authority is the user's choice in that browser; see
  [SSH Host](../../../../docs/ssh-host.md).
- Caxri Bot hand-over of an Agent conversation started outside Caxri. Server Core adds the
  conversation's folder as a Project when no visible Project contains it. Only the owner's Desktop and
  human CLI may call `bot.session.handOver`; Server Core refuses every other principal, including
  an Agent Endpoint holding an `agent:control` grant; see
  [Caxri Bot](../../../../docs/caxri-bot.md).
- `project.add` (`caxri project add <path>`) from any managed Agent Endpoint or the owner's human CLI,
  through the `projects.write` capability. Server Core canonicalizes the absolute path the CLI
  resolved from its working directory and registers that root as `mobile.project.add` does, without
  the home-directory restriction: an Agent already runs as the user, and the user chose to let Agents
  open repositories they have not added yet. It is idempotent by root and shows a hidden Project
  again; see [visible delegation](../../../../docs/agent-delegation.md#start-work-in-a-new-session).

## Main outbound requests

Electron Main makes only these outbound HTTP requests; a new one belongs in this list with its
trigger and caps, and every response body is read under a byte cap. None uploads source or app
content; the environment profile lookup includes its explicitly observed IP in the fixed URL. Status
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
  `packages/system/src/network/agent-provider-status.ts`): the fixed public Statuspage endpoints for
  Claude and OpenAI, polled every 60 s while a status bar tok/s item or an Agent status tab for that
  provider is mounted. 10 s timeout, 2 MiB body cap (a larger body reads as `invalidResponse`); cached per
  provider for 60 s after success and 30 s after failure. E2E launches read
  fixtures instead.
- **Environment public exit** (`apps/desktop/src/main/environment-monitor/public-ip.ts`): a fixed
  `GET https://api.ipify.org?format=json` through Electron `net.fetch`, once at launch and then at
  most every 60 s while public-IP change monitoring is enabled, plus an explicit manual check. 5 s
  timeout, `no-store`, 4 KiB body cap, and the only accepted value is an IP literal. After the first
  address, a changed address, or a manual check, a fixed `GET https://checkip.me/<observed-ip>`
  enriches that exact literal with third-party network context. It has the same timeout and cache
  policy with a 32 KiB body cap; a response for another address is rejected. Either failure retains
  the last proven state and is not an environment warning. The provider may serve cached context up
  to 30 days old; the UI reports the fetch time and labels the source as third-party context.
- **Update check and download** (`apps/desktop/src/main/updates/updates.ts`): the GitHub latest-release API,
  once automatically per packaged launch (skipped in E2E and acceptance discovery) and on a manual
  check. 15 s timeout and 1 MiB response cap; 404 and rate-limit responses degrade to
  `unavailable`. Only a user-started download fetches the release checksum (4 KiB cap) and DMG
  (1 GiB cap).

## Server outbound requests

Server Core makes only these outbound HTTP requests; a new one belongs here with its trigger and caps.
It uses Node's `fetch`, uploads no user data, and is replaced by an immediate failure under
`CAXRI_E2E=1`, so E2E and Acceptance runs stay offline.

- **Model price list** (`apps/server/src/domains/usage/pricing.ts`): `GET` of LiteLLM's public
  `model_prices_and_context_window.json` on raw.githubusercontent.com when a Usage report finds the
  cached copy older than a day. 15 s timeout; the body is streamed and dropped past 16 MiB. Any
  failure falls back to the cached copy, then the snapshot bundled at build time.
- **Agent provider status for mobile** (`mobile.agentUsage.read`,
  `apps/server/src/core/mobile/agent-usage-requests.ts`): the same fixed Claude and OpenAI status
  pages and caps as Desktop's `agentProviderStatus.read`, read through the shared
  `packages/system/src/network/agent-provider-status.ts` while the phone's Agent usage screen is
  open (it polls every 30 s; the 60 s cache bounds the requests). Node's `fetch` ignores the macOS
  system proxy, so a machine that can reach the pages only through a proxy shows them as
  unavailable on the phone. Under `CAXRI_E2E=1` it reads the same fixture directory instead.

### CLI-mediated egress

Server Core also reaches the network indirectly, through CLIs it spawns with structured argv. These
calls carry the user's own CLI credentials and are not covered by the Node `fetch` rule above.

- **External status** (`apps/server/src/domains/external-status/command.ts`): the delivery-metadata
  probes spawn `gh`, `git`, `lh`, `linear`, and `vc` (`ExternalStatusSource`). `git` is local; the
  others answer to a remote API budget and a per-source rate-limit circuit. Each call has an 8 s
  timeout and a 4 MiB output cap and runs with `CI=1` and `LC_ALL=C`.
- **GitHub token**: `gh` calls receive `GH_TOKEN` read once from `gh auth token` (a process-wide
  cache that is invalidated on a 401 or not-logged-in result). The token stays in the child
  environment and is never logged or returned to the Renderer.
- **Linear credential**: for `linear`, `LINEAR_API_KEY` is set to an empty string so the CLI cannot
  fall back to a `.env` file inside the repository it runs in; the user's configured workspace
  credentials stay authoritative.
- **GitHub references** (`apps/server/src/domains/external-status/github-reference.ts`): `gh api`
  is pinned with `--hostname github.com`, so a link never makes `gh` contact a host named by its
  configuration or `GH_HOST`.
- **Merge settings** (`apps/server/src/domains/project-status/merge-method.ts`): `gh repo view
--json` reads a repository's allowed merge methods, cached per repository slug.
- **Pull request merge** (`apps/server/src/domains/git/pull-request-merge.ts`): the only mutating
  call. It runs `gh repo view` then `gh pr merge` only for an explicit user merge action (Desktop
  or a `control` mobile device), with the method chosen from the repository settings.

## Renderer-requested path opener

`agentChat.openPathReference` lets the Renderer ask Main to open a path from a file or folder chip
in a sent message (`apps/desktop/src/main/agent-chat/path-picker.ts`, dispatched in
`apps/desktop/src/main/main-methods.ts`). The Renderer can supply only an absolute path string.
Main resolves it with `realpath`; a folder opens in Finder, while a file, an `.app`, or any
executable bundle (including a symlink resolving to one) is only revealed in its folder, so a click
never runs or launches anything. A missing path answers `NOT_FOUND`.

The path is not held to a Project root because it came from the user's own drop, paste, or pick
and the action is limited to reveal or open-folder, which grants no read or write of file contents.
It is classified `local-only` in `apps/desktop/src/main/environment-method-policy.ts`: an SSH Host
window cannot trigger it, because the path would name a file on the remote machine, not the
machine whose Finder opens. User-facing behavior is in [Agent Chat](../../../../docs/agent-chat.md).

## Chat video media scheme

`caxri-media:` (`apps/desktop/src/main/agent-chat/media-protocol.ts`) serves a video a Chat
message cites to the Renderer: its QuickLook poster frame and the file itself, streamed with range
requests so `<video>` can seek. The Renderer CSP forbids `file:` and a screen recording exceeds the
file channel's read cap, which is why a scheme exists at all. Main serves a path only when the
requested path and its `realpath` both end in a video extension (`isAgentChatVideoPath`) and the
target is a regular file; anything else answers 400 or 404, so the scheme cannot read arbitrary
files, including through a symlink named like a video. Like the path opener, the path is not held
to a Project root because it is the user's own drop or pick. An SSH Host window never builds these
URLs (`isAgentChatPlayableVideo`), since its paths name files on the remote machine.

## Accepted test seams

- **Preload E2E bridge** (`apps/desktop/src/preload/index.ts`): `window.caxriE2E` (request gates,
  call counters, the one-shot mobile pairing link bridge) and the poll-interval override are
  exposed only when the `CAXRI_E2E=1` environment variable is set at runtime. The code ships in
  every build; the gate is the environment, not a build-time removal, so a packaged app launched
  with that variable would expose it. They record no arbitrary requests and persist nothing.
  `__caxriWorktree` is exposed whenever `switch-worktree dev` sets
  `CAXRI_WORKTREE_PATH`; it holds only a local path.
- **Environment monitor fixture** (`apps/desktop/src/main/environment-monitor/e2e-fixture.ts`):
  `CAXRI_E2E=1` replaces both fixed public endpoints with documentation-only IP addresses and
  synthetic provider fields. `CAXRI_E2E_ENVIRONMENT_MONITOR_SCENARIO=changed` deterministically
  changes the second reading so the report and warning can be verified without network access;
  `changed-profile-unavailable` also rejects enrichment to prove that IP evidence remains usable.
- **Acceptance native-dialog fixtures** (`apps/desktop/src/main/acceptance-*.ts`, wired in
  `main-methods.ts` and `desktop-update-service.ts`; `acceptance-accessibility.ts` in `index.ts`).
  They ship in production Main and stay inert unless the isolated Acceptance launcher arms them.
  Each needs `CAXRI_ACCEPTANCE=1` plus its own variable: external open
  (`CAXRI_ACCEPTANCE_EXTERNAL_OPEN`, one fixed case and URL), Session deletion
  (`CAXRI_ACCEPTANCE_SESSION_DELETE`, an allowlisted case id), theme import
  (`CAXRI_ACCEPTANCE_THEME_IMPORT` or the explicit native authorization; an unarmed Acceptance
  launch fails visibly), and the update fixture (`CAXRI_ACCEPTANCE_UPDATE`, never in a packaged
  build). All but the accessibility switch also require `CAXRI_E2E=1`, and theme import
  additionally the test root. They replace only the native dialog's answer or release discovery
  from a one-shot, sequence-checked command file under the profile and write a receipt; Main
  authorization and the Server operation stay in the path under test. The accessibility switch
  (macOS with `CAXRI_ACCEPTANCE=1`) only enables Electron's full native Accessibility tree so
  Acceptance can read real sheets.
- **Root provider fault** (`apps/desktop/src/renderer/src/root-provider-fault.ts`,
  `root-provider-fault-probe.tsx`): a `sessionStorage` key makes the next root render throw so the
  recovery screen can be proven for a provider-level failure. Unlike the preload seams it is not
  gated by `CAXRI_E2E`. This is accepted: the only actor who can set the key is code already
  running in the Renderer, the effect is one self-clearing crash that Reload recovers from, and it
  exposes no data or capability.
