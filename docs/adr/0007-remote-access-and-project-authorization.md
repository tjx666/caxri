---
kind: adr
status: accepted
---

# Remote access and Project authorization

- Date: 2026-08-25
- Implementation plan: [Server architecture refactor plan](../server-refactor-plan.md)
- Amended by: [ADR 0013](0013-editable-external-documents.md) (external documents are editable and can open a Terminal in their folder)
- Amended by: [ADR 0014](0014-ssh-remote-server.md) (adds an SSH access path beside local, direct, and Relay)

Local, direct, and Relay access establish the same public Server protocol. Local access uses a private
loopback bootstrap credential. Direct access uses TLS with a pairing-delivered certificate pin,
revocable Client Grants, one-use short-lived WebSocket tickets, and per-method scopes. Project browsing
and authorization always execute on the Server behind an operator-grade `projects:authorize` scope;
a native folder picker is only a same-machine Client optimization and never transfers a Client path
to a remote Server.

The local Desktop `Cmd+P` browser is a deliberately narrow same-machine exception for explicit paths.
It starts behind a removable Project anchor, where directories continue through Server Core's
Session/Workbench-root resolver. Removing the anchor enables a read-only path field that accepts the
current user's `~`, parent and relative paths, and `/`-rooted absolute paths. Main lists matching folders
and files directly; it never opens the native folder picker for this flow. Only the user's typed path
crosses from Renderer to Main. Main owns canonical locations and candidates behind opaque browser and
entry IDs, bounds enumeration concurrency and result count, rejects symbolic-link traversal, and
revalidates directory and file identity before returning one size-bounded regular-text-file snapshot.

Selecting a file inside the current Project still uses its existing authorized editable Editor path.
An external file opens as a read-only virtual Editor tab in the current Session. Its display path and
content live only in Renderer memory for that Renderer lifetime, and the tab is stripped from every
Session persistence write. The external flow neither creates nor reuses a Project for the file and never
creates another Session. It grants no Files, Search, Git, Terminal cwd, save, or Project authority (ADR 0013 later made the
file editable and allowed a Terminal in its folder; Files, Search, Git, and Project authority stay
withheld). Remote
Clients do not inherit this same-machine capability or gain a way to submit a local Client path to
Server Core. Add Project, Workbench-root selection, Agent folder selection, and other durable-root
workflows continue to use native selection and single-use Main grants.

Terminal file links outside every Project reuse the same external snapshot instead of forcing a Project
to be added. Server Core reports the explicit target as `external` without reading it; Main confirms
with Open, Trust Folder and Open, or Cancel, and skips the prompt when the `security.trustedFolders`
Setting already contains the file's folder. A trusted folder is a persisted prompt-skip preference, not
a root grant: it never creates a Project, never widens Files, Search, Git, Terminal cwd, or save
authority, and the resulting tab stays read-only and ephemeral.

A future Relay is a separately deployed access service reached outbound by the Server. It stores no
Caxri domain state and cannot read relayed payloads; end-to-end encryption keeps it outside the Server's
trust boundary. Relay discovery and notification may be added without creating a second Remote Server
implementation or coupling Server deployment to Caxri-operated infrastructure.
