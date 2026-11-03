---
kind: adr
status: accepted
---

# One Workbench window reaches This Mac and every connected SSH Host

- Date: 2026-11-04
- Refs: issue #3600
- Amends: [ADR 0014](0014-ssh-remote-server.md) (replaces its one-environment-per-window Desktop shape)
- Amends: [ADR 0017](0017-per-window-session-presence.md) (a window key now spans several Servers)

ADR 0014 gave every SSH Host its own Workbench window. With two or three Hosts that turns into
window juggling, and the same repository checked out on several machines shows up as unrelated
windows. The Workbench window now lists the Projects of the local Server and of every connected SSH
Host in one side bar. Each Server still owns its own Projects, Sessions, Terminals, and Agents; only
Desktop composes them.

- **Main owns connections, not windows.** One environment registry in Desktop Main holds exactly
  one connection per environment (`local`, or an SSH Host keyed by its resolved host identity).
  Windows never open their own connection: a second connection to one Server would take over its
  lease and detach the first.
- **The Renderer names the target, Main validates it.** A Renderer request carries an outer
  `environmentId` beside the Server request. The Renderer resolves it from the Session or Project the
  request is about (both are UUIDs, unique across Servers) or from an explicit choice, and global
  calls that create something (a Project, a folder browse) must name it. Main rejects an unknown or
  disconnected environment with a classified reason and never falls back to the local Server, so a
  stale id cannot act on this Mac's disk. The ADR 0014 method table is evaluated per request against
  the target environment instead of per window.
- **Events and recovery are per environment.** Every event Main forwards is tagged with its
  environment, and the Renderer keeps one event cursor and one ready gate per environment, so one
  Host's gap or hang never recovers or blocks another.
- **Presence spans Servers.** A window has one window key that Main sends to every connected Server.
  The Server that owns the viewed Session receives it as viewed; every other connected Server
  receives the window as visible with nothing viewed, so it does not suspend Terminals or watchers.
  Each Server persists only its own Sessions in the window's Open Sessions strip, and the Renderer
  composes the strip across Servers.
- **The same repository merges by remote URL.** The side bar groups Projects from different
  environments under one heading when their normalized `origin` URL matches, following T3 Code,
  Paseo, and Superset. Projects without an `origin`, or two Projects of one environment, never merge.
  The merge is a Desktop presentation; no Server learns about another Server's Projects.
- **Host preferences live in Desktop Main.** Display name, icon, and Reconnect on Launch are stored
  per host identity on this Mac, because they must be readable exactly when the Host is offline.

## Considered options

- **Keep one window per Host and add a window switcher.** Rejected: it keeps the juggling and cannot
  show one repository's Sessions from several machines together.
- **Prefix every Project and Session id with its environment in the Renderer.** Rejected: ids are
  already UUIDs, so the prefix would touch every store and query key for no correctness gain.
- **Let Main infer the environment from an id index.** Rejected: the index lags a just-created
  Session and would misroute or fail; the Renderer already knows which row it acted on.
