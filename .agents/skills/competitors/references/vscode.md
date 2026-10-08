# Visual Studio Code (microsoft/vscode)

_Researched 2026-08-28 at `8512d16a6b20ff9197d24424918ff105703f91f4`._

- **License:** MIT.
- `src/vs/platform/environment/node/userDataPath.ts` resolves portable mode, environment, explicit
  `--user-data-dir`, and the product default before services consume user state.
- `src/vs/code/electron-main/main.ts` derives the Main IPC handle, lockfile, logs, and instance
  claim from that environment authority; a later invocation forwards to the existing instance
  instead of starting a competing application process.
- Caxri keeps its standalone Server Core, Terminal Host, and Extension Host model rather than copying
  VS Code's process graph, but uses
  the same startup invariant: canonical runtime-profile identity settles before Chromium, logging,
  CDP, instance arbitration, or Server attachment can capture it.
- `src/vs/workbench/contrib/scm/browser/scmViewPane.ts` creates the Source Control tree with stable
  identity, restores `scm.viewState2` from workspace storage, and writes `tree.getViewState()` when
  workbench state is saved. The snapshot includes expanded node IDs as well as focus, selection, and
  scroll position.
- View visibility does not destroy the Source Control pane or tree. Visibility changes attach and
  release expensive listeners while the tree instance remains available, so tab/view switching and
  window reload both preserve disclosure state without keeping hidden data work active.

## Terminal view placement

_Researched 2026-09-10 at `1dbbce1da524efa885a751381426f1591a9f41c1`._

- `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts:1061-1093` separates
  `detachFromElement` / `attachToElement` from instance disposal. A changed container receives the
  existing wrapper; the same container is a no-op. Caxri follows the ownership principle with stable
  pane portals: layout placement must not recreate a surviving visible Terminal's xterm instance.

## File watching

_Researched 2026-09-05 at `1dbbce1da524efa885a751381426f1591a9f41c1`._

- `src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts:596-598` treats the macOS FSEvents
  "File system must be re-scanned" advisory as a log line only. VS Code neither reconciles nor
  restarts the watcher for it, so it never needed to throttle the advisory. Caxri does reconcile:
  its Files and Git consumers would otherwise stay stale after a kernel overflow, which is why the
  coalescing window in `apps/server/src/domains/watch-hub.ts` has no VS Code counterpart to copy.
- The live restart path is `AbstractWatcherClient.restart()` in
  `src/vs/platform/files/common/watcher.ts:226-271`: it re-inits immediately with no delay, is capped
  by `MAX_RESTARTS`, and `canRestart` refuses both for a single failed request and for the
  handle-exhaustion errors (`EMFILE`, no space left on device), which are not recoverable
  in-process. The rescan advisory never reaches it, because its branch never fires `_onDidError`.
  (`restartWatching` in `parcelWatcher.ts:619` has no call site at this commit; do not cite it as
  the restart mechanism.)
- Event delivery out of the watcher is throttled rather than the advisory: a `ThrottledWorker` with
  `maxWorkChunkSize: 500`, `throttleDelay: 200`, and `maxBufferedWork: 30000`, plus a 75ms
  `FILE_CHANGES_HANDLER_DELAY` coalescing pass. The useful shape is that every window is a bound on
  work per unit time, not a bound on staleness, the same reason Caxri's window may exceed
  `@parcel/watcher`'s 500ms forced-flush ceiling.
