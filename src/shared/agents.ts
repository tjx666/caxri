/**
 * Single source of truth for the Agent provider family Caxri hosts (Claude Code, Codex). Both the
 * IPC domain schema and the Runtime Agent adapters derive from this catalog instead of hand-syncing
 * provider identifiers across the codebase.
 */
export const agentProviderIds = ['claude', 'codex'] as const;

export type AgentProvider = (typeof agentProviderIds)[number];

/** Display and executable metadata for one Agent provider. */
export interface AgentProviderCatalogEntry {
    /** Human-readable name shown in the Renderer (e.g. Settings, Create Session dialog). */
    displayName: string;
    /** Name of the CLI executable resolved from `PATH` or the user's login shell. */
    executableName: string;
    /**
     * Structured argv for resuming a previous provider conversation identified by
     * `agentSessionId`. Used to auto-restore an Agent Terminal interrupted by an app shutdown
     * (see GitHub issue #18) without losing its conversation history.
     */
    resumeArguments(agentSessionId: string): string[];
}

export const agentProviderCatalog = {
    claude: {
        displayName: 'Claude Code',
        executableName: 'claude',
        resumeArguments: (agentSessionId) => ['--resume', agentSessionId],
    },
    codex: {
        displayName: 'Codex',
        executableName: 'codex',
        resumeArguments: (agentSessionId) => ['resume', agentSessionId],
    },
} satisfies Record<AgentProvider, AgentProviderCatalogEntry>;
