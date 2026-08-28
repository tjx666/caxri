# GitLens (gitkraken/vscode-gitlens)

_Researched 2026-08-28 at `04b52619e053943937975bc70ae090869b0b94c7`._

- **License:** MIT outside directories named `plus`, which use the proprietary `LICENSE.plus`.
- `src/views/viewBase.ts` creates each VS Code `TreeView` once, listens for visibility separately
  from disposal, and tracks expanded node objects in a `WeakSet` through collapse/expand events.
- GitLens therefore inherits VS Code's retained view lifecycle across sidebar switches. Its own
  expanded-node cache is process-local, so VS Code's workspace-persisted SCM tree remains the
  stronger precedent when a Source Control view should also restore after a window reload.
