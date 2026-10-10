---
kind: living
status: current
---

# Agent dispatch receipts

Managed dispatch records describe the launch request and its observed process lifetime. They do
not add a failure badge or notification to the Session UI.

A process that exits before the dispatch obtains running-process and Endpoint proof fails with
`launch_failed`, including exit code zero. Once running, a normal exit remains `stopped`.
Intentional suspension or detach settles the receipt as `interrupted`; a later launch rejection
must not overwrite an outcome already delivered to a waiter.
Explicit Terminal closure (`terminalClosed`) and a `serverShutdown` observation delivered while
launch proof is still pending retain their intentional `stopped` outcome; these are not
process-start failures. Orderly Server shutdown of live Terminals settles them as
`interrupted`. A later Core restart cannot preserve process ownership proof, so still-active
receipts recover as `failed` with `host_reset` and do not automatically spawn a replacement.
That recovery logs each transition but emits no `agent.dispatch.changed`: it runs before the durable
event journal exists, whose bounded startup queue could not hold one event per receipt. Nothing
depends on it: Desktop windows reload their state on reconnect, and a later `status` or `wait`
reads the retired receipt directly.

Terminal restart retires the previous Agent generation through the existing lifecycle event.
It does not depend on a synthetic `starting` event. Terminal Host loss and Terminal restart
carry distinct causes.

A manual start can win the race against a delegation resuming the same Terminal, because
`terminals.start` and `terminals.restart` join a launch already in flight and return successfully
to both. The dispatch that lost the Terminal settles as `interrupted` with `target_changed`, the
same outcome its delegation reports. The Agent process is left running: it belongs to the user who
started it, and the losing dispatch never signals it.

An archived target Session never receives a new launch. A start rechecks the archive inside the
same transaction that inserts its receipt and Terminal, so archiving while the dispatch validates
its working directory still fails with `CONFLICT` and writes no receipt. A resume rechecks after
its last wait and settles its receipt as `failed` with `CONFLICT` instead of restarting the Agent.

Every receipt status transition emits `agent_dispatch.transitioned`. Fields contain the dispatch
and Terminal identifiers, previous and current statuses, a closed reason, and elapsed lifetime.
Reasons distinguish launch readiness/failure, process failure/exit, Host or Terminal restart,
idle or untouched suspension, Session archive, and user detach. Logs exclude executable paths,
arguments, prompts, Terminal contents, and Endpoint credentials.

Idle suspension cannot use Server age as evidence against an Agent still starting without an
activation timestamp. Such a launch is governed by its launch timeout. After activation, the
ordinary idle and untouched rules use the new launch timestamp and retain their existing delays.
