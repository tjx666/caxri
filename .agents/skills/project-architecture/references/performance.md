# Performance budgets and measurements

Desktop Main, Server Core, Terminal Host, and Extension Host record boundary timings for app readiness,
Desktop attachment, first window visibility, Server Core boot, PTY spawn, file listing, Git commands,
Agent probes, and watcher readiness. Concurrent identical file, Git, Agent, and Terminal-start requests
share one in-flight operation so development StrictMode and repeated UI requests do not duplicate
native work. Agent Terminal output schedules a trailing metadata refresh with at most one timer per
Terminal, allowing a CLI-generated title to reach the Primary Sidebar without opening the Info view.
One Agent coordinator owns that scheduling and reads Agent Terminal membership from the durable Terminal
record instead of a cached set, so no lifecycle path can leave the two disagreeing. Ordinary Shell and
dev-server output never enters this probe path; only a bounded simple-command candidate may request
coalesced foreground-process confirmation, after which normal Agent metadata refreshes take over.
A confirmed manually started Agent keeps a one-second exit watch for as long as it runs. Every watch and
confirmation probe reads one shared machine-wide process table (`SharedProcessList`): concurrent probes
join the read in flight and a read under 400 ms old answers without spawning, so any number of watched
Terminals cost at most about one `/bin/ps` a second (about 35 ms on a machine with a thousand processes).
Each watch writes one `agent.process_watch_ended` record when it ends, with its probe count, failures,
lifetime, probe p95 and maximum, and a closed reason.

Terminal input, resize, and output are high-frequency paths. Successful input and resize requests do not write individual records, repeated ResizeObserver grid sizes do not cross IPC, and Server Core ignores a resize that matches the live PTY grid so a remounted view cannot generate a redundant SIGWINCH. Renderer xterm fits and successful Terminal Host PTY resizes instead emit bounded, content-free burst summaries after 250 milliseconds of quiet or five seconds of continuous activity. Each side records only counts, start/minimum/maximum/final grids, duration, and flush reason, keyed by opaque Terminal identity; summaries never include pixels, output, prompts, commands, source, paths, or environment data. Each side also remembers the last grid it sampled across bursts (per Renderer pane instance, per Terminal Host Terminal id) and seeds the next burst's `start` from it without counting that seed toward `sampleCount`, so a settled one-step resize is reported as an actual before-to-after change instead of reading as unchanged; the remembered grid is cleared when its owning pane or Terminal is retired. PTY throughput is aggregated per one-second window into the bounded `pty.throughput` metric; no per-window log record is written unless bytes were dropped, and repeated drops fold into at most one `warn` per minute. Each PTY lifetime writes at most two `info` records: `pty.first_input` once the first window carrying input closes (with the delay from spawn to the first input write, stamped when the bytes were written rather than at the window boundary), and `pty.throughput_summary` at retirement with lifetime totals, the peak window, the active-window count, duration, and the retire reason. The PTY data callback updates only the in-memory parsed screen and live delivery queue; normal lifecycle finalization crosses the parser barrier and writes one bounded screen BLOB instead of persisting raw output periodically. Bootstrap loads all Session state rows in one query and reuses its already-loaded Terminal records to validate every state's Terminal ownership without per-Session reads. A direct aggregate state read batches ownership into one query, while a targeted state read keeps the same read-time repair with one Session-scoped ownership query. Terminal exit, restart/restore, and Agent metadata events refresh only their identified records through one coalesced small read; application attach, Server Core recovery, and structural mutations retain full bootstrap as the convergence path. Monaco stays out of the terminal-first Renderer bundle; after Server Core attachment, a single shared idle preload primes editor-core plus JavaScript, TypeScript/TSX, JSON, HTML, CSS, Markdown, and dotenv tokenization before the first real file selection. Language workers remain demand-loaded.

Within a mounted surface, view containers stay mounted after their first show so Files, Git, and Status keep scroll, focus, and expansion across tab switches. Closing the entire Secondary Sidebar unmounts its surface. Hidden keep-alive tabs pause snapshot, treeChildren, and `files.list` / search reads; tab badges keep their own `badge.snapshot` queries. Showing a tab again paints cached content first; provider trees revalidate, while Files listings and search follow normal cache staleness and file-change invalidation. Git decorations keep the last `git.summary` while the next Session snapshot is in flight, and Source Control snapshot cache identity excludes the refresh nonce so a remount does not flash the loading empty state.

`benchmark:startup` exercises a representative large repository and requires Server Core, Terminal, Files, and Git to become usable within three seconds. It also validates timed log coverage, zero request/watcher failures, aggregated terminal metrics, and fewer than 256 Server Core file descriptors. `benchmark:editor` separately launches isolated cold and idle-preloaded renderers. The common-language idle preload must complete within three seconds; the first JavaScript or TypeScript document, editor mount, and visible syntax highlight must complete within 250 ms of selection in both paths, and a repeated open must visibly highlight within the same bound.

`benchmark:renderer` uses React's profiling build to switch once between two of eight seeded Sessions
over a populated, expanded file tree. Its strict receipt retains per-surface render counts and bounded
duration summaries for the Primary Sidebar, Workbench, and Secondary Sidebar, plus fixed
`session.select` and `app.bootstrap` request summaries. CI hard-gates one request of each kind,
per-surface render counts and total React duration, focus/visibility integrity, and truncation;
any frame interval at or above 100 ms also fails as a visible freeze, while refresh-rate-sensitive
percentiles, missed-frame estimates, Long Animation Frame, and Event Timing values remain diagnostic.
Component-level fiber trees stay outside the build and durable receipt because subtree-inclusive timings
cannot supply an additive component budget.

The Workbench keeps the five most recently selected Sessions (the visible one included) mounted in a
stable id order and hides the off-screen ones with `content-visibility: hidden` (no `inert`, which would restyle the subtree on every switch), never `display: none`, so a Chat or
Terminal returns at its own scroll offset without a programmatic scroll. A hidden Chat stays subscribed to its
cached conversation but is not notified of its stream, and cached Chat conversations are retained by
count rather than time. `benchmark:chat-switch`
guards that path and the cold Chat load; its scenarios and gates are documented in
[Agent Chat Session switch](../../../../docs/renderer-performance.md#agent-chat-session-switch).
