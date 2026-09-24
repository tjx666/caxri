# Projects, Sessions, and Workbench Roots

A `Project` is a user-authorized folder and the durable owner of its `rootPath`, explicit Sidebar order, and path-security grant. A `Session` belongs permanently to one owning Project and owns permanent Terminal records, root-scoped Workbench state, layout, and optional Agent metadata. Its independently persisted `Workbench Root` selects the authorized Project used by Files, Editor, Search, Git, and the default cwd of newly created Terminals; it defaults and falls back to the owning Project. Existing Terminal cwd records and processes, Agent Endpoint ownership, Sidebar grouping, and Session identity never move when that selection changes. Workbench navigation and dirty document identity use the tuple `(sessionId, workbenchProjectId, path)`, so switching roots restores independent tabs, selection, Git mode, and dirty buffers without merging same-named paths. See [ADR 0001](../../../../docs/adr/0001-separate-session-owner-and-workbench-root.md).

Session identity isolates Renderer editor, layout, SecondarySidebar, and navigation state. Every new
Session-scoped state surface must key or reset that state when the selected Session changes.
An external file opened through the explicit-path Desktop browser is not a Project resource: it is a
read-only virtual Editor document scoped to the current Session and Renderer lifetime. Its display path
and content remain in Renderer memory, and its virtual tab is stripped from every Session persistence
write, so no external path or content enters SQLite and no Project or Session is created for it.

Archiving a Session hides it from active navigation without stopping or deleting its Terminals, and restore only clears that metadata. The Sidebar keeps one global Archived Sessions entry even when its count is zero; a Renderer-only management dialog derives search, Project/Agent filters, Project grouping, and newest-first order from the existing bootstrap snapshot, then delegates restore and delete to the unchanged structured Session methods. Every new Session starts with the automatic title `Untitled`, while its initial Terminal keeps the provider-specific title. The first Agent Terminal becomes the source of later automatic title promotion from useful metadata. If that primary Agent exits while another Agent Terminal is live, the live Terminal becomes primary; otherwise the stopped Terminal remains primary so the same provider session can be resumed. A user rename with a bound primary Agent first updates the provider-owned conversation through its public CLI boundary, then stores the provider-authoritative title under manual ownership; a provider failure leaves the Caxri title unchanged. A Session without a primary Agent has no external identity, so its rename remains local. Multiple Sessions can share one Project without duplicating its folder identity.

Project and Session deletion removes Caxri metadata only. It never removes the authorized Project
folder or user files.

Hiding a Project (`project.hide`) is the reversible alternative to deletion. It marks the Project and
the worktree Projects registered on its behalf with `hiddenAt`, parks their live Terminals through the
archive suspension path, and moves selection off them, but keeps every Project, Session, Terminal, and
layout row. `app.bootstrap`, `project.list`, CLI record queries, Terminal file links, Session content
search, Project Status background polling, and Session pull-request lookup all skip hidden Projects
and their Sessions. The root stays registered, so a later manual `project.create` of the same root
clears `hiddenAt` and returns the original Project with its order, icon, and Sessions; an automatic
worktree registration never un-hides. There is no hidden-Project list: re-adding the folder is the
only way back.

Every Session deletion path, including bulk and owning-Project deletion, retires Session runtime
state before deleting metadata. Retirement aborts automatic naming, clears naming retry and manual
revision bookkeeping, and releases Terminal view-size and input-epoch state. Late naming results
remain fenced by their cancelled owner and the current database identity.

Desktop notification history is a bounded Renderer-memory projection, separate from Sonner's
live toast queue. Only typed reminder preferences persist in `settings.jsonc`, through the
existing Server-owned scalar settings patch path. History never stores action closures or writes
message bodies to logs or disk. Main forwards accepted Agent banner decisions as transient
`agent.notification` events carrying only Session identity and attention kind; delivery history
uses the existing `projectStatus.alert`. Neither projection raises another popup or replays on
reconnect. Failures and persistent data-loss notices bypass reminder suppression.
See [Notifications](../../../../docs/notifications.md) for the user flow, retention boundaries,
producer ownership, and troubleshooting.

Unread Attention is also projected across Projects by the Activity view, the Primary Side Bar body
that replaces the Project tree and groups every visible Project's Sessions by whether they need the
user. It reads the existing bootstrap snapshot only and adds no Server state; see
[Activity view](../../../../docs/activity-view.md) for its grouping order, retention window, and
keyboard contract.
