/**
 * Codex thread settings derived from the provider's launch settings. See `launchSettingsToCodexThread`.
 */
export interface CodexThreadSettings {
    approvalPolicy: 'never' | 'on-request' | 'untrusted';
    sandbox: 'danger-full-access' | 'read-only' | 'workspace-write';
    model?: string;
    /**
     * Root `-c key=value` overrides and `--profile`, passed before `app-server` exactly as the TUI would receive them.
     */
    rootArgs: string[];
}
