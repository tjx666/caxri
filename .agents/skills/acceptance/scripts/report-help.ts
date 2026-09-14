export function reportCliHelp(): string {
    return `Caxri Acceptance report scaffold

Commands:
  init --dir DIR --plan PLAN_JSON --title TEXT --entry TEXT --requirement TEXT
       [--branch NAME] [--commit SHA] [--pull-request N]
  rebind-head --dir DIR --from-commit SHA --commit SHA --entry TEXT --reason TEXT [--allow-finalized]
       [--created-at ISO_TIMESTAMP]
  repair-lifecycle --dir DIR --case-id ID --reason TEXT
       Completes a launch the launcher never finished; isolated profiles must already be gone
  finalize --dir DIR --requirement TEXT [--conclusion TEXT]`;
}
