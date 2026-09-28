---
kind: adr
status: accepted
---

# Multi-Client identity and state ownership

- Date: 2026-08-25
- Note: post-cutover P2 product capability; implementation pending
- Supersedes: state-ownership portions of ADR 0001 and ADR 0002
- Implementation plan: [Server architecture refactor plan](../server-refactor-plan.md)

A Server accepts concurrent capability-scoped Clients. A Session owns shared domain state, including
its immutable owning Project, active Workbench Root, Terminals, revisioned document Drafts, Agent Runs,
Agent Activity, and Attention. The Server persists one Session View per `(Client ID, Session)` with
presentation state such as pane placement, open resources, active selection, and an optional Workbench
Root override; only that Client writes the View, and View updates do not participate in shared entity
revision conflicts. Terminal records remain Session-owned even when each Session View places them
differently. This retains the owning-Project and unified-pane semantics of
[ADR 0001](./0001-separate-session-owner-and-workbench-root.md) and
[ADR 0002](./0002-unified-pane-layout.md) without allowing one Client's layout to overwrite another.

Server ID identifies the durable Server, Server Boot ID one incarnation, Client ID one granted Client,
Connection ID one transport connection, and State Epoch one compatible state history. There is no
global Desktop lease: Terminal input and resize use a Terminal Control Lease, shared mutations use
entity revisions and preconditions, and native operations target an explicitly capable Client.
Acknowledging an Attention generation clears it for every Client. Draft bodies are Server-owned and
durable so every Client observes the same unsaved content. A Draft records its base disk identity;
editing checks the Draft revision, saving additionally checks that base, and an external disk change
produces a structured conflict rather than silently replacing either side. Caxri deliberately uses
optimistic conflicts rather than a Draft writer lease, CRDT, or operational transformation.
