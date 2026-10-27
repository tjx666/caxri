# Publication recovery

Storage limits require a user-facing recovery handoff. For report ingest, evidence upload, or
result submission with a file, recognize `recovery.reason: "storage_quota"`,
`failedEvidence[].reason: "storage_quota"`, or a `storage_block:` error. Do not stop at "upload
failed" or "noted in the PR":

- In the final response, state that storage limits blocked publication, distinguish locally
  observed results from uploaded evidence, and report the actual coverage. Include the saved
  Acceptance link when one exists; do not invent one for an atomic submission that failed before
  saving anything.
- Give both recovery options in Simplified Chinese, using `recovery.cleanupUrl` and
  `recovery.upgradeUrl` verbatim and following `recovery.message`. Never delete user data
  automatically; deletion is permanent.
  - Personal scope: clean up unneeded acceptances, or upgrade the personal plan. Acceptance cleanup
    must select "permanently delete all rounds, reports, and evidence files"; deleting only a
    record or an evidence association frees no storage.
  - Workspace scope (`recovery.scope: "workspace"`): clean up that workspace's files, or upgrade
    that workspace's plan. Its cleanup link opens the resource library, not an acceptance list. Ask
    the workspace owner or admin for cleanup or billing access; personal cleanup or a personal
    upgrade does not resolve a workspace limit.
  - If the CLI reports an unresolved workspace scope and omits recovery URLs, report that
    limitation and its scope-check instructions. Do not guess links or substitute personal pages.
- For an older CLI without recovery metadata, resolve the server and scope with
  `lh doctor --offline --json` and `lh workspace current --json`. Personal scope uses
  `/acceptance` and `/settings/plans` on that server. Workspace scope resolves its slug with
  `lh workspace view --json` (verify the returned id matches the active workspace) and uses
  `/:workspaceSlug/resource` and `/:workspaceSlug/settings/plans`; there is no
  `/:workspaceSlug/acceptance` route. Strip any URL username or password from displayed links. If
  lookup fails, give scope-specific guidance without links.
- Preserve the local round, its assets, and the returned retry instructions. Stop retrying until
  the user has addressed storage. For a partially ingested round, retry only the failed artifacts
  with `failedEvidence[].retryArgs` or `retryCommand`, never the whole ingest. Supplementing evidence does not change recorded verdicts:
  read back coverage, and do not claim the delivery is complete while required evidence is missing.
