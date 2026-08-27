# Visual Studio Code (microsoft/vscode)

_Researched 2026-08-22 at `17b6e73bd9cf53af7871ec4130872160d79a796d`._

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
