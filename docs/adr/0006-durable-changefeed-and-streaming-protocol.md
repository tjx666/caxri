---
kind: adr
status: accepted
---

# Durable changefeed and streaming protocol

- Date: 2026-08-25
- Note: local changefeed and binary streams implemented; Multi-Client completion pending P2
- Implementation plan: [Server architecture refactor plan](../server-refactor-plan.md)

Authoritative state tables remain Caxri's source of truth rather than a globally event-sourced model.
Every structural mutation appends a content-free changefeed record in the same transaction, and every
effectful command carries a Client-generated command ID whose durable receipt is committed with the
mutation. Clients resume from `(serverId, stateEpoch, sequence)` through snapshot or catch-up followed
by an explicit live barrier; an expired cursor or mismatched epoch falls back to a bounded snapshot.
Agent Run and Attention lifecycle metadata may use a durable ledger, while Terminal bytes remain
ephemeral and recover display state from bounded screen snapshots.

The public protocol defines logical control, Terminal, file, and liveness lanes without binding them
to one physical connection. The initial mapping uses one JSON control WebSocket and independently
attached binary WebSockets for Terminal and file streams, all with bounded queues, chunking, explicit
high-water behavior, and the same short-lived ticket mechanism. Caxri does not build an application
multiplexer over one WebSocket, mirror commands as REST, or add SSE. The handshake carries build ID,
protocol version, State Epoch, capabilities, and framing support; compatibility is gated per feature.
Each Terminal stream ticket is bound to the Server, Session, Terminal, PTY generation, attachment, and
permitted operation; stale attachments and generations fail closed. Terminal Control Leases are the
multi-Client generalization of ADR 0002's view attachment fencing: the Server Core grants control and
the Terminal Host enforces both layers.
[Issue caxri#366](https://github.com/tjx666/caxri/issues/366) is a compatible control-transport slice,
not the authority for the final ownership or streaming model.
