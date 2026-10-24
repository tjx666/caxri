---
kind: adr
status: accepted
---

# Extension view requests carry their own Session scope

- Date: 2026-10-24
- Amends: [ADR 0017](./0017-per-window-session-presence.md)

[ADR 0017](./0017-per-window-session-presence.md) routed "extension context" and "mobile panel checks"
through **Current**, the focused window's Session. That made every extension view (Status, Git) a
single-Session surface: a second window or a phone viewing another Session got its reads cancelled, and
the mobile Status tab could only ask the user to open the Session on the computer first.

Every extension view request now names its Session scope (`{ kind: 'session', sessionId,
workbenchProjectId }`) and Server Core serves it whether or not that Session is Current:

- **Authorization** resolves the named Session through the internal `app.sessionContext` method and
  rejects the request with `CANCELLED` only when that Session no longer exists or its Workbench Root no
  longer matches. The extension's Project grant is checked against that Session's Projects.
- **Nested API calls** (`workspace.getProjectStatus`, `workspace.request`) inherit the scope of the
  provider request that issued them through the Host's request-local context, so a provider never reads
  another Session's data by accident.
- **Tree handles** are partitioned per scope inside the Extension Host, bounded to the 64 most recently
  read scopes per view. A refresh fired inside one scope retires only that scope's handles.
- **Domain events** that name Sessions (`projectStatus.changed`, `git.changed`) refresh each named
  Session's scope, not only the Current one.

Current keeps its meaning for questions that are genuinely about focus: `onDidChangeActiveContext`, the
CLI `current` selector, and notification inputs. Extension commands also run in the scope their caller
names; a command without a Session is rejected.

## Considered Options

- **Keep Current-only views and let mobile focus the Session on Desktop.** Rejected: a phone would steer
  the desktop window, and two Desktop windows would still fight over one view scope.
- **Server-native mobile Status, separate from the extension tree.** Rejected: a second implementation of
  the same view, which would drift from the Desktop one and leave the multi-window case unsolved.
- **Per-view opt-in to multi-Session scope.** Rejected: every bundled view already partitions its state
  by `scopeId`, and an opt-in would keep two authorization paths alive.

## Consequences

A provider that cached state globally rather than by `scopeId` would mix Sessions; bundled providers
partition by `scopeId` and the Status provider's forced refresh token is per scope. Mobile panels still
read on demand; live tree invalidation for a non-visible Session is limited by the file watcher, which
follows visible Sessions only.
