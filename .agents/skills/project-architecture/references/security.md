# Desktop isolation and filesystem grants

BrowserWindows use `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderers, a restrictive CSP, blocked navigation, and denied new windows. Renderer may request only an HTTP(S) external open; Main re-parses and canonicalizes the URL, rejects credentials and unsupported protocols, and owns every system-browser call. Loopback origins are trusted by default. A configured exact origin or explicit wildcard matches only the same scheme and port; malformed rules fail closed. Every other origin requires a native confirmation, and choosing trust persists its canonical exact origin before opening. Passive navigation and new-window attempts remain denied rather than acquiring trust authority. No telemetry or remote upload exists.

The Renderer CSP's `img-src` is `'self' data: blob: https:`. `blob:` carries preview images, which are read through the ordinary authorized `files.readAsset` request and never as a `file:` URL. `https:` exists so a README badge renders in the Markdown preview, matching VS Code's default Markdown preview security; plain `http:` stays blocked. The cost is that opening such a document tells the remote host, and because the preview shares the Workbench document rather than a webview, that allowance applies to the whole Renderer. A surface that renders untrusted content must therefore contain it itself: the Markdown preview forbids `<style>` at the sanitizer and sets `contain: layout paint` on its body. Widening `img-src` further, or adding any other remote-fetching directive, is a product decision, not a local one.

Folder-picker results create single-use Main-process grants. A grant is revoked when the Agent choice or Workbench authorization is canceled, expires after 60 seconds if unused, and is consumed before Project creation reaches the Server Core. An automatic worktree candidate carries an opaque ID and a display-only destination path to the Renderer. Choosing Continue submits only the ID: Main claims and canonicalizes its Server Core path, creates a single-use grant, and Server Core revalidates the candidate and linked-worktree topology before registering the Project. Once a Project exists, new Sessions reference its stable owning ID and cannot submit or broaden a root path. A Workbench selection may reference only an already authorized Project that current structured Git topology proves is a linked worktree of that owner. The Server Core persists the selected root's device and inode, revalidates identity and topology on access/focus/watch failure, and atomically falls back to the owning Project when the worktree disappears or is replaced.

The local Desktop's free-path browser is an explicit-input, developer-tool capability, not a durable
root grant. It exposes bounded enumeration and one file snapshot per opened file. Opening a file
registers it in Main's per-lifetime external document registry, and that registry is the whole authority
of the `externalDocument.*` methods: saving the file in place, revealing it, opening it with the default
app, and starting a Terminal in its folder through the Main-only `terminal.createInExternalDirectory`.
That Terminal's cwd is persisted on its Terminal record like any other cwd. The browser cannot authorize
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
