---
kind: adr
status: accepted
---

# Editable external documents through a Main-issued registry

- Date: 2026-10-10
- Refs: [#1555](https://github.com/tjx666/caxri/issues/1555), [#1565](https://github.com/tjx666/caxri/pull/1565)
- Amends: [ADR 0007](0007-remote-access-and-project-authorization.md)

ADR 0007 made a file opened outside every Project (the `Cmd+P` free path or a Terminal link) a
read-only snapshot with no save, Terminal cwd, or other authority, so no external path could become
durable. In practice users open such a file to change it, and a read-only tab that refuses Save,
Reveal in Finder, Open with Default App, and Open in Terminal sent them to another editor. We now let
that one opened file act like a document without making its folder a Project.

Desktop Main keeps a process-lifetime registry from the opaque `documentId` in the tab path to the
path the user opened. The Renderer only ever names that ID, so the registry, not a Renderer-supplied
path, is the whole authority of `externalDocument.write`, reveal, open with the default app, and
`terminal.createInExternalDirectory`. Every save reauthorizes the path (same parent, regular file, no
symbolic link, one hard link) and checks the opened descriptor's inode, then overwrites in place to
keep the inode, mode, and extended attributes of a file Caxri does not own; a crash mid-save can
truncate it. Open in Terminal admits only that Main-vouched folder as a cwd, and the new Terminal's
record persists it like any other cwd. The document itself still never enters SQLite, grants no
Files, Search, Git, or Project authority, and is not watched for outside changes. Remote Clients
receive none of this capability.

Considered: registering the file's folder as a hidden Project would reuse every Project save path,
but it creates durable root authority the user never asked for and would surface the folder in
Project-scoped features. A path-carrying `externalDocument.write` request would be simpler, but it
would let any Renderer bug write anywhere the user can.
