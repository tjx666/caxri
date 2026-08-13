export function reportCliHelp(): string {
    return `Caxri Acceptance report scaffold

Commands:
  init --dir DIR --plan PLAN_JSON --title TEXT --entry TEXT --requirement TEXT
       [--branch NAME] [--commit SHA] [--pull-request N]
  rebind-head --dir DIR --from-commit SHA --commit SHA --entry TEXT --reason TEXT
       [--created-at ISO_TIMESTAMP]
  finalize --dir DIR --requirement TEXT [--conclusion TEXT]`;
}
