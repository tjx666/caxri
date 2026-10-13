---
kind: living
status: current
---

# Server footprint

What an SSH Host Server costs the machine it runs on: disk under `~/.caxri-server`, the upload a new
build needs, and the resident memory of its processes. `bun run benchmark:server-footprint` measures
all of it on a disposable SSH Host and compares the result with
`scripts/server-footprint-baseline.json`, so a change that makes the Server heavier fails there
instead of surfacing as a complaint from a small VM or a shared login node.

## Requirements

Measured on linux-arm64 with Node 24.20 (`linux-x64` differs by a few MiB, mostly in the Node
binary). Memory is PSS, which splits the shared Node binary pages between the processes, so the
totals are what the host actually spends.

| Resource                 | Need                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| Disk, first install      | 131 MiB: Node runtime 117 MiB, one build 13.4 MiB, profile 0.7 MiB         |
| Disk, long running       | Up to about 400 MiB with a previous build and every log at its cap (below) |
| Memory, attached         | 147 MiB PSS (190 MiB RSS): Server Core and the Extension Host              |
| Memory, Project open     | 179 MiB PSS (267 MiB RSS): adds the Terminal Host and a Project's state    |
| Memory, heavy Git/search | Server Core alone: about 203 MiB RSS after the load, 236 MiB at its peak   |
| Upload per new build     | 4.6 MiB, the compressed application layer                                  |
| Runtime download, once   | 55 MiB Node tarball fetched by the host, or 117 MiB streamed over SSH      |

Plan for about 256 MiB of free memory for the Server, 384 MiB for heavy Git and search on large
Projects. Agent CLIs, shells, and whatever a Terminal runs come on top.

On disk, an upgrade keeps the previous build (another 13.4 MiB) so a Desktop on the previous version
still attaches. When the upgrade also moves to a new Node version, the previous runtime (117 MiB)
stays until no kept build references it. The
profile grows with the database and logs: each process log (`server-core`, `terminal-host`,
`extension-host`) keeps a 20 MiB live file and three rotated generations, 80 MiB at most. An SSH
Host logs at `info` by default, so those caps fill slowly.

## Baseline

Median of five samples on linux-arm64, recorded by the benchmark below.

| Measure                           | Value     |
| --------------------------------- | --------- |
| Attached, total PSS               | 146.8 MiB |
| Project open, total PSS           | 179.3 MiB |
| Project open, total RSS           | 266.6 MiB |
| Project open, Server Core PSS     | 101.2 MiB |
| Project open, Terminal Host PSS   | 42.6 MiB  |
| Project open, Extension Host PSS  | 35.5 MiB  |
| Load, Server Core RSS after it    | 202.9 MiB |
| Load, Server Core peak RSS        | 236.0 MiB |
| Disk after the first install      | 131.1 MiB |
| Upload per build                  | 4.6 MiB   |
| Terminal Host startup JavaScript  | 516 KiB   |
| Extension Host startup JavaScript | 270 KiB   |

The startup JavaScript sizes come from the Server build, which enforces their budgets. The rest
round `scripts/server-footprint-baseline.json`, which holds the exact numbers per target.

## Measuring

```bash
bun run benchmark:server-footprint              # build, measure, compare with the baseline
bun run benchmark:server-footprint --update     # same, then record the result as the baseline
bun run benchmark:server-footprint --compare-only   # compare the last receipt again
```

It needs Docker and takes about two minutes. `scripts/server-footprint.ts` builds the workspaces and
the remote layer for Docker's own architecture, starts a disposable SSH Host with
`scripts/ssh-lab.ts`, and runs
`apps/desktop/src/main/ssh/__tests__/remote-footprint.integration.test.ts` against it through the
real install and launch path. That test writes a receipt to
`test-results/receipts/server-footprint.json`, which the script compares with the baseline. Pass
`--skip-build` to reuse `apps/server/dist/remote`, or `--keep-lab` to leave the container running.

The test measures three stages, each the median of five samples taken after a 10 s settle:

- `attached`: a Desktop is connected and nothing is open, so Server Core and the Extension Host run.
- `working`: a Git Project of 2,000 tracked files with a gitignored `node_modules` is open in a
  selected Session, with a shell Terminal, a file listing, and a Git summary, so the Terminal Host
  runs too.
- `load`: a second Project of 15,000 tracked files (1,500 modified, 300 untracked) takes ten rounds
  of concurrent Git summaries, content and name searches, and 30 listings each followed by a read.
  Only Server Core is recorded: its settled RSS and PSS, which is what a burst leaves resident, and
  its peak RSS (`VmHWM`).

Disk is one `du` over `~/.caxri-server` after a cold install, so the runtime hard-linked into each
build counts once. Transfer is the app layer's compressed size and the bytes actually written to the
SSH connection during the install; the Node runtime is downloaded by the host itself from nodejs.org.

Each metric group has a tolerance in the baseline file (`memory`, `load`, `disk`, `transfer`: a
relative share plus an absolute floor in KiB). `load` gets a wider share than `memory` because
memory after a burst varies more between runs. A value above the baseline plus its tolerance fails. A value
below it by more than the tolerance passes and asks for `--update`, so an improvement is locked in
instead of becoming headroom for the next regression. Run the benchmark when a change touches Server
startup, what the Server or its hosts import, the artifact's contents, or the processes' V8 flags,
and commit an intended change to the baseline file in the same pull request.

## What keeps it small

- **Hosts load only what they serve.** The Terminal Host and Extension Host import from
  `@caxri/protocol` like everything else; the package is side-effect free, so the barrel shakes down
  to the symbols a host uses. What a host loads is decided by the modules that define those symbols:
  Rolldown keeps every top-level schema call of a module it includes, so a symbol defined in a
  schema-heavy module (`domain.ts`, `local-transport.ts`, `business-contract.ts`) brings that whole
  module along. Definitions the hosts need therefore live in leaf modules (`identifiers.ts`,
  `terminal-record.ts`, `log-level.ts`, `transport/identity.ts`), and protocol modules import them
  from there, not through `domain.ts`. A host must never import a Server Core module. The Server
  build fails when a host's startup JavaScript exceeds its budget in
  `apps/server/scripts/host-startup-budget.ts`, and the error lists the chunks it loads.
- **Hosts start lazily.** The Terminal Host starts with the first Terminal and the Extension Host
  with the first attached Desktop; neither runs for a Server nobody uses.
- **Server Core caps its young generation.** By default V8 sizes each semi-space from the heap limit,
  up to 64 MiB on a 4 GiB heap, and a busy Server Core keeps that space resident after the burst.
  Both launch paths pass `SERVER_CORE_EXEC_ARGV` (`--max-semi-space-size=8`), and the Extension Host
  and search Workers inherit it. Under a heavy Git status and search load (concurrent Git summaries,
  content and name searches, listings, and reads over 15,000 files) it cut Server Core from about
  290 MiB to about 200 MiB resident with the same latency and the same number of full collections;
  scavenges ran half again as often for about 1% more GC time. 16 MiB measured about 210 MiB. It is
  not a heap ceiling. The Terminal Host already passes the same flag. The benchmark's `load` stage
  replays that load: a build without the flag measured 298 MiB after it and 326 MiB at its peak,
  and failed every `load` metric.
- **Reads size their buffer from the file.** Bounded file reads, including the project search
  Worker, allocate from the file's size instead of the read cap (`files.maxFileBytes`, 2 MiB). A
  cap-sized Buffer per file counts as external memory and forced a full collection every few files
  in each search Worker: under the same heavy load, full collections fell from about 730 to 4 and
  the load finished about a fifth sooner. Both share one loop,
  `apps/server/src/domains/read-file-handle-up-to.ts`, which imports Node builtins only so the
  Worker can load it.
- **Bundles stay one-byte.** Server bundles are ASCII-only, so V8 stores their source as one-byte
  strings; see the memory footprint section of [server-architecture.md](server-architecture.md).
- **The artifact ships runtime inputs only.** Database migrations are compiled into the Server Core
  bundle, native packages ship without documentation, type declarations, source maps, or tests, and
  the SSH layer omits source maps. The SSH Host downloads its Node runtime from nodejs.org and keeps
  it in `runtimes/`, so a new build uploads only the application layer and hard-links the runtime.

## Not done

- **Stripping the Node binary.** The official Linux binary keeps about 19 MiB of symbol and debug
  sections. Stripping needs `strip` on the SSH Host or a repackaged runtime whose checksum no longer
  matches nodejs.org's, and loses native symbols in crash reports.
- **Keeping one build.** The previous build costs about 14 MiB. Keeping it lets a Desktop on the
  previous version attach without uploading again, and lets an upgrade proceed while an older Server
  still runs.
- **Using the host's own Node.** It would save the 117 MiB runtime but couple the Server to whatever
  Node version and native-module ABI the host happens to have.
