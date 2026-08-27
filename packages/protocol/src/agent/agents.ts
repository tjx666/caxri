import type { AgentActionsSettings } from './agent-action-settings.js';
import { defaultAgentActionsSettings } from './agent-action-settings.js';

/**
 * Single source of truth for the Agent provider family Caxri hosts (Claude Code, Codex). Both the IPC domain schema and
 * the Runtime Agent adapters derive from this catalog instead of hand-syncing provider identifiers across the
 * codebase.
 */
export const agentProviderIds = ['claude', 'codex'] as const;

export type AgentProvider = (typeof agentProviderIds)[number];

export interface AgentLaunchSettings {
    /**
     * Executable name or absolute path resolved by the Runtime without invoking a shell command.
     */
    executable: string;
    /**
     * Structured arguments prepended to provider-owned resume arguments.
     */
    args: string[];
}

export const MAX_AGENT_OUTPUT_RECOVERY_PATTERNS = 20;
export const MAX_AGENT_OUTPUT_RECOVERY_PATTERN_LENGTH = 256;
export const MIN_AGENT_OUTPUT_RECOVERY_DELAY_MS = 250;
export const MAX_AGENT_OUTPUT_RECOVERY_DELAY_MS = 10_000;

export interface AgentOutputRecoverySettings {
    /**
     * Explicit opt-in: output-driven Terminal input is never enabled implicitly.
     */
    enabled: boolean;
    /**
     * Case-insensitive literal suffixes matched against the parsed Terminal screen tail.
     */
    patterns: string[];
    /**
     * Quiet period after the latest output before Caxri sends Escape.
     */
    settleDelayMs: number;
    /**
     * Delay between Escape and the follow-up `continue` submission.
     */
    continueDelayMs: number;
}

export const defaultAgentOutputRecoverySettings: AgentOutputRecoverySettings = {
    enabled: false,
    patterns: [],
    settleDelayMs: 1_000,
    continueDelayMs: 1_000,
};

interface AgentHookSettings {
    /**
     * Explicitly authorizes Caxri to install and maintain this provider's lifecycle hooks.
     */
    enabled: boolean;
}

interface AgentMessagingSettings {
    /**
     * Allows a managed Agent generation to exchange bounded peer text through the Host Inbox.
     */
    enabled: boolean;
}

export interface AgentProviderSettings {
    actions: AgentActionsSettings;
    hooks: AgentHookSettings;
    launch: AgentLaunchSettings;
    messaging: AgentMessagingSettings;
    recovery: AgentOutputRecoverySettings;
}

/**
 * Display and executable metadata for one Agent provider.
 */
export interface AgentProviderCatalogEntry {
    /**
     * Human-readable name shown in the Renderer (e.g. Settings, Create Session dialog).
     */
    displayName: string;
    /**
     * Name of the CLI executable resolved from `PATH` or the user's login shell.
     */
    executableName: string;
    /**
     * Safe image input Caxri can drive after an explicit user action, when supported.
     */
    imageInput?: {
        kind: 'systemClipboardPaste';
        terminalInput: string;
    };
}

export const agentProviderCatalog = {
    claude: {
        displayName: 'Claude Code',
        executableName: 'claude',
        imageInput: undefined,
    },
    codex: {
        displayName: 'Codex',
        executableName: 'codex',
        imageInput: { kind: 'systemClipboardPaste', terminalInput: '\u{16}' },
    },
} satisfies Record<AgentProvider, AgentProviderCatalogEntry>;

/**
 * Provider-scoped defaults keep future CLI-specific settings under the provider they configure.
 */
export const defaultAgentProviderSettings = Object.fromEntries(
    agentProviderIds.map((provider) => [
        provider,
        {
            actions: structuredClone(defaultAgentActionsSettings),
            hooks: { enabled: false },
            messaging: { enabled: true },
            recovery: { ...defaultAgentOutputRecoverySettings, patterns: [] },
            launch: {
                executable: agentProviderCatalog[provider].executableName,
                args: [],
            },
        },
    ]),
) as unknown as Record<AgentProvider, AgentProviderSettings>;
