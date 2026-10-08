---
kind: living
status: current
---

# Grok Build

Caxri hosts the native Grok Build terminal through the existing managed Agent PTY.
It uses the installed CLI and its existing authentication; Caxri does not install
Grok, implement an xAI API client, or introduce another chat interface.

## Supported launch

The managed launcher requires Grok Build 1.0.24 or later within major version 1.
The verified baseline is `1.0.24 (68e414c661e3) [stable]` on macOS arm64.
Default arguments are `--yolo` (`--yolo` is Grok Build's alias for
`--always-approve`). Caxri does not inject `--sandbox`; Grok Build's own default
is `off` (unrestricted). A user who wants confinement can add `--sandbox workspace`
or another documented mode in Initial arguments (a flag and its value may share a
line) and `prepareLaunch` passes that value through unchanged. Automatic background suspension is disabled for this
provider. Do not substitute `--no-leader`: the verified binary rejects that newer
option.

Caxri owns the launch session arguments. A new Terminal receives a fresh UUID via
`--session-id`; restore uses `--resume` with the exact confirmed conversation UUID.
Conflicting session or leader arguments are rejected before spawning. Restore
checks that the exact session has a local `summary.json` under the selected Grok
home. It never searches for the newest conversation in a directory or silently
falls back to a new conversation. Missing identity requires an explicit fresh
start. Concurrent Terminals can therefore share a Project without sharing an ID.

## Identity and activity

Lifecycle hooks are required for managed launches. Caxri maintains only its own
entries in `$GROK_HOME/hooks/caxri.json` (default home: `~/.grok`). The hook command
uses the existing Caxri Node bridge. It forwards bounded identifiers and event
metadata, never prompts, responses, transcripts, or Terminal output.

`SessionStart` with source `new` or `load` confirms the conversation identity,
including an in-terminal `/new` or resume. `UserPromptSubmit.promptId` identifies
the running turn. `Stop` completes only a matching main turn with reason
`end_turn`; `StopFailure` marks that turn failed. Shutdown `Stop` events, child
events, pending background work, old conversations, and stale turns cannot mark
the current turn complete. Missing completion events leave conservative activity
state and never enable automatic suspension.

Grok also imports Claude hook configuration. The bridge ignores those inherited
Claude commands when Grok's session environment is present, before making a
cross-provider lifecycle request. A manual Shell launch still requires independent
foreground process confirmation before promotion to Grok.

Precise approval/question waiting is not advertised: a generic notification is
not sufficient evidence that the main turn is waiting for a human. Native rename,
Agent messaging and bundled skills/actions are unavailable in
this integration. Rename fails explicitly instead of saving a Caxri-only alias.

## Conversation title

The metadata probe reads `generated_title` from the bound conversation's
`summary.json` and publishes it as the Session and Terminal title. Grok owns that
value: it writes only its own generated title there (never a provisional copy of
the first prompt, as Codex does) and refreshes it after later turns, so Caxri
adopts each refresh on the next probe. The read requires the exact session
identity a hook already confirmed; an unbound Terminal reads no title, because
directory recency cannot separate simultaneous same-directory conversations. The
probe reports no identity or activity of its own, and a missing, empty, oversized,
multi-line, or unparseable value leaves the current title untouched. Caxri's own
automatic Session naming stays off for Grok, which has no native rename to
synchronize a generated name back into the provider.

## Verification boundaries

Automated Electron tests use a repository-owned fake CLI and isolated provider
homes. They do not discover or invoke the host Grok executable. The native CLI
contract was separately checked with an explicitly authorized diagnostic probe:
new UUID, exact resume, duplicate UUID rejection, native PTY `/new`, normal and
failed turn events, and shutdown events. Command-hook receipts from the native
PTY and headless comparison were emitted by the launched Grok process itself.
An additional native probe launched through `/tmp` and confirmed that Grok stores
the session beneath the canonical `/private/tmp` project key. Both the native
process and resumed comparison exited, with neither PID remaining alive.

The read-only sandbox failed on the diagnostic host while resolving a Docker
socket symlink. The probe used the workspace sandbox with all tools, web search,
and subagents disabled; it did not change host Docker, trust, or authentication
configuration. Help text and newer upstream source are supporting references,
not substitutes for runtime evidence.

References: [CLI](https://docs.x.ai/build/cli/reference),
[hooks](https://docs.x.ai/build/features/hooks),
[sandbox](https://docs.x.ai/build/features/sandbox),
[issue caxri#683](https://github.com/tjx666/caxri/issues/683). Upstream binary internals researched
while building this integration are recorded separately in the
[competitors skill's Grok Build note](../.agents/skills/competitors/references/grok-build.md).
