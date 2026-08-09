/**
 * Single source of truth for the Agent provider family Caxri hosts (Claude Code, Codex). Both the
 * IPC domain schema and the Runtime Agent adapters derive from this catalog instead of hand-syncing
 * provider identifiers across the codebase.
 */
export const agentProviderIds = ['claude', 'codex'] as const;

export type AgentProvider = (typeof agentProviderIds)[number];

export interface AgentLaunchSettings {
    /** Executable name or absolute path resolved by the Runtime without invoking a shell command. */
    executable: string;
    /** Structured arguments prepended to provider-owned resume arguments. */
    args: string[];
}

export interface AgentProviderSettings {
    launch: AgentLaunchSettings;
}

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

/** Provider-scoped defaults keep future CLI-specific settings under the provider they configure. */
export const defaultAgentProviderSettings = Object.fromEntries(
    agentProviderIds.map((provider) => [
        provider,
        {
            launch: {
                executable: agentProviderCatalog[provider].executableName,
                args: [],
            },
        },
    ]),
) as unknown as Record<AgentProvider, AgentProviderSettings>;
