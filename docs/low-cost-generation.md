---
kind: living
status: current
---

# Low-cost generation sandbox

Automatic Session naming is a bounded text transformation. Its provider subprocess cannot read the
selected Project subtree or the provider's global instruction files. Authentication and network
access outside that boundary remain available.

Long Terminal pastes do not use this path. Caxri saves the original to a local file and hands the
Agent its path, because the Agent is better placed than Server Core to decide whether the text is
worth a summary, and a model call on the paste path holds Terminal input until it returns. See
[Terminal long paste](#terminal-long-paste).

Before launch, Server Core resolves the Project, executable, temporary working directory, and
provider configuration directory. A Project containing any required runtime location is rejected
with `sandboxBoundaryConflict`; Caxri does not add exceptions inside the denied subtree. Choose
a more specific Project folder instead of adding the home directory or a shared ancestor.

Both the instruction entry and its resolved target are denied. This covers `CLAUDE.md`,
`CLAUDE.local.md`, `AGENTS.md`, and `AGENTS.override.md`, including links into another directory.
Missing instruction files are allowed. Other resolution failures stop generation with
`sandboxPathUnavailable`; correct the paths or permissions and restart the Agent.

## Naming material

Automatic naming reads the Agent transcript for two separate sections. `opening_request` holds the
first user message and the first assistant reply that followed it; it establishes what the Session
is about. `recent_messages` holds the newest six messages and only sharpens that subject. A
transcript with no user message and no assistant message produces no title.

Both sections matter because a transcript's byte size is dominated by tool records, not by
conversation. Reading a window near the end of the file therefore reaches very few messages and
routinely misses the opening request entirely, which renames a Session after whatever the user
happened to say last. Transcripts are instead line-streamed end to end while retaining only the
bounded message set above. A transcript past the scan budget keeps its opening window and its
tail window, so both sections survive.

An opening request that is only an image, a link, or an issue identifier carries no subject on its
own. The assistant's first reply supplies it, which is why the naming subprocess needs no tools,
no network fetches, and no image access of its own.

Automatic naming shows one notice and suppresses further attempts for that managed launch.
A new Agent launch can try again. Naming never logs prompts, model output, instruction contents,
or provider configuration paths.

This is a same-user, stable-configuration boundary. Resolving a link and subsequently launching
the provider is not an atomic filesystem transaction: another same-user process can still replace
a link between those operations. The sandbox also cannot predict future provider runtime paths;
unexpected required reads inside the Project fail closed.

## Terminal long paste

Text pasted into a running managed Agent above `terminal.longPasteThreshold` (2048 characters by
default) is written to an owner-only file under the user data directory and replaced, in the same
input position, with a short reference naming the file, its size, and the option to delegate a
summary to a subagent on a small, fast model. The original never reaches the PTY, the logs, or
SQLite. Raising the threshold to its maximum keeps pastes up to 1,048,576 UTF-16 code units
native; larger pastes still use a saved file. Saved pastes accept up to 16 MiB of UTF-8 text,
with the same byte limit enforced before the request and at the Server. Oversized input stays in
the clipboard, is never forwarded to the PTY, and produces a message explaining how to save it
manually and share the file path.

Files are kept for 30 days, capped at 128 MiB in total, and pruned oldest first on every paste and
on an hourly timer. A reference is fenced to the Agent launch that was running when the paste
started: if that process is replaced while the file is being written, the paste is dropped rather
than handed to the new process.

A Shell that was promoted to an Agent by foreground detection keeps native paste, because Caxri has
no managed launch to fence the reference to. Its native paste remains limited to 1,048,576 UTF-16
code units; larger input is rejected with an explicit message instead of being sent to a
Terminal input method that would reject it.
