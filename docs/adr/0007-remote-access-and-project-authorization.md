# Remote access and Project authorization

- Status: accepted (target; implementation pending)
- Date: 2026-08-25
- Implementation plan: [Server architecture refactor plan](../server-refactor-plan.md)

Local, direct, and Relay access establish the same public Server protocol. Local access uses a private
loopback bootstrap credential. Direct access uses TLS with a pairing-delivered certificate pin,
revocable Client Grants, one-use short-lived WebSocket tickets, and per-method scopes. Project browsing
and authorization always execute on the Server behind an operator-grade `projects:authorize` scope;
a native directory picker is only a same-machine Client optimization and never transfers a Client path
to a remote Server.

The local Desktop path browser follows that boundary explicitly. Project-local directories continue
through Server Core's Session/Workbench-root resolver. Home, absolute, and parent traversal outside
added Projects first require Electron Main's native directory selection; Main keeps the canonical root,
directory location, and entry paths behind opaque IDs and returns only display labels and bounded entry
metadata to the Renderer. The temporary browse context is read-only and expires when the dialog closes,
after one file is opened, or after its short timeout. Opening a file then reuses the existing root-grant
handoff to create or reuse a Project, select or create a no-Agent Session, and issue an identity-bound
`desktop.openFile` target. Remote Clients do not inherit this same-machine browse grant or gain a way to
submit a local Client path to Server Core.

A future Relay is a separately deployed access service reached outbound by the Server. It stores no
Caxri domain state and cannot read relayed payloads; end-to-end encryption keeps it outside the Server's
trust boundary. Relay discovery and notification may be added without creating a second Remote Server
implementation or coupling Server deployment to Caxri-operated infrastructure.
