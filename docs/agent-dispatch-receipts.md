# Agent dispatch receipts

Managed dispatch records describe the launch request and its observed process lifetime. They do
not add a failure badge or notification to the Session UI.

A process that exits before the dispatch obtains running-process and Endpoint proof fails with
`launch_failed`, including exit code zero. Once running, a normal exit remains `stopped`.
Intentional suspension or detach settles the receipt as `interrupted`; a later launch rejection
must not overwrite an outcome already delivered to a waiter.
Explicit Terminal closure and orderly Server shutdown retain their intentional stopped outcome
even if launch proof was still pending; these are not process-start failures.

Terminal restart retires the previous Agent generation through the existing lifecycle event.
It does not depend on a synthetic `starting` event. Terminal Host loss and Terminal restart
carry distinct causes. A Server Core restart cannot preserve process ownership proof, so its
recovery remains `failed` with `host_reset`, without automatically spawning a replacement.

Every receipt status transition emits `agent_dispatch.transitioned`. Fields contain the dispatch
and Terminal identifiers, previous and current statuses, a closed reason, and elapsed lifetime.
Reasons distinguish launch readiness/failure, process failure/exit, Host or Terminal restart,
idle or untouched suspension, Session archive, and user detach. Logs exclude executable paths,
arguments, prompts, Terminal contents, and Endpoint credentials.

Idle suspension cannot use Server age as evidence against an Agent still starting without an
activation timestamp. Such a launch is governed by its launch timeout. After activation, the
ordinary idle and untouched rules use the new launch timestamp and retain their existing delays.
