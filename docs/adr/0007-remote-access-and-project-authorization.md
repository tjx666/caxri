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

A future Relay is a separately deployed access service reached outbound by the Server. It stores no
Caxri domain state and cannot read relayed payloads; end-to-end encryption keeps it outside the Server's
trust boundary. Relay discovery and notification may be added without creating a second Remote Server
implementation or coupling Server deployment to Caxri-operated infrastructure.
