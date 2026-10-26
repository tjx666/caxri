/**
 * The interactive login-shell probe that supplies the login PATH and the Agent environment.
 */
export const loginShellLogEvents = {
    /**
     * One probe with its duration and a closed `outcome`: `failed` with a closed `reason` (`timeout`, `exit`,
     * `output_limit`, `missing_markers`, `missing_path`, `spawn`), or `read` with the `environment` block status
     * (`parsed`, `missing`, `oversized`), the forwarded `variables` count, and one `dropped_<reason>` count per cause a
     * variable was left out (`entry_limit`, `name_too_long`, `value_too_long`, `invalid_name`, `session_key`,
     * `caxri_key`). Never carries a variable name or value.
     */
    probe: 'login_shell.probe',
} as const;
