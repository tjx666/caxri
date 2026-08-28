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
