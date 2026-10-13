import { z } from 'zod';

import type { AgentActionsSettings } from './agent-action-settings.js';
import { defaultAgentActionsSettings } from './agent-action-settings.js';

/**
 * Single source of truth for the Agent provider family Caxri hosts (Claude Code, Codex). Both the IPC domain schema and
 * the Runtime Agent adapters derive from this catalog instead of hand-syncing provider identifiers across the
 * codebase.
 */
export const agentProviderIds = ['claude', 'codex', 'grok'] as const;

export const agentProviderSchema = z.enum(agentProviderIds);

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
     * The exact argv tokens that let this provider act on the Project without asking for per-action approval, matched
     * and inserted as one contiguous run so a flag and its value are never separated. Settings derives its
     * plain-language autonomy switch from this list rather than persisting a second copy of the same choice, so it
     * names the approval bypass and nothing else: a confinement argument such as Grok Build's `--sandbox workspace`
     * decides where the Agent may work, not whether it asks first, and stays out of this list.
     */
    autonomyArgs: readonly [string, ...string[]];
    /**
     * Supported integrations; settings cannot manufacture a missing provider implementation.
     */
    capabilities: {
        actions: boolean;
        automaticSuspension: boolean;
        /**
         * Whether Caxri can run this provider as an Agent Chat through its structured protocol (ADR 0012).
         */
        chat: boolean;
        /**
         * Whether an Agent Chat with this provider accepts images with a message.
         */
        chatImages: boolean;
        /**
         * Whether "Edit from here" can also restore the files the rewound turns changed, through the provider's own
         * file checkpoints. Every Chat provider can rewind its conversation; one without native file checkpoints keeps
         * the files as they are, because Caxri does not snapshot the worktree itself.
         */
        chatRewindFiles: boolean;
        messaging: boolean;
        nativeRename: boolean;
    };
    /**
     * Human-readable name shown in the Renderer (e.g. Settings, Create Session dialog).
     */
    displayName: string;
    /**
     * Name of the CLI executable resolved from `PATH` or the user's login shell.
     */
    executableName: string;
    /**
     * Arguments that start a provider in its least-interactive, user-authorized mode.
     */
    defaultLaunchArgs: readonly string[];
    /**
     * Safe image input Caxri can drive after an explicit user action, when supported.
     */
    imageInput?: {
        kind: 'systemClipboardPaste';
        terminalInput: string;
    };
    /**
     * The argv tokens that, followed by the Agent Session id, resume one conversation in the provider's TUI. Server
     * Core launches a resumed PTY with them, and the Renderer shows the same tokens in a copyable resume command, so
     * the two cannot disagree.
     */
    resumeArgs: readonly [string, ...string[]];
}

export const agentProviderCatalog = {
    claude: {
        autonomyArgs: ['--dangerously-skip-permissions'],
        capabilities: {
            actions: true,
            automaticSuspension: true,
            chat: true,
            chatImages: true,
            /**
             * Claude Code's SDK file checkpointing (`rewindFiles`).
             */
            chatRewindFiles: true,
            messaging: true,
            nativeRename: true,
        },
        defaultLaunchArgs: ['--dangerously-skip-permissions'],
        displayName: 'Claude',
        executableName: 'claude',
        imageInput: undefined,
        resumeArgs: ['--resume'],
    },
    codex: {
        autonomyArgs: ['--dangerously-bypass-approvals-and-sandbox'],
        capabilities: {
            actions: true,
            automaticSuspension: true,
            chat: true,
            chatImages: true,
            /**
             * App-server's `thread/revert` changes only the conversation; Codex keeps no file checkpoints.
             */
            chatRewindFiles: false,
            messaging: true,
            nativeRename: true,
        },
        defaultLaunchArgs: ['--dangerously-bypass-approvals-and-sandbox'],
        displayName: 'Codex',
        executableName: 'codex',
        imageInput: { kind: 'systemClipboardPaste', terminalInput: '\u{16}' },
        resumeArgs: ['resume'],
    },
    grok: {
        /**
         * `--yolo` is Grok Build's documented alias for `--always-approve`. Settings still treats the longer flag as
         * the same bypass so a persisted `--always-approve` cannot survive turning the switch off.
         */
        autonomyArgs: ['--yolo'],
        capabilities: {
            actions: false,
            automaticSuspension: false,
            chat: true,
            /**
             * Grok Build's ACP agent advertises `promptCapabilities.image: false`.
             */
            chatImages: false,
            /**
             * Grok Build's `_x.ai/rewind/execute` restores its own per-prompt file snapshots.
             */
            chatRewindFiles: true,
            messaging: false,
            nativeRename: false,
        },
        defaultLaunchArgs: ['--yolo'],
        displayName: 'Grok Build',
        executableName: 'grok',
        imageInput: undefined,
        resumeArgs: ['--resume'],
    },
} satisfies Record<AgentProvider, AgentProviderCatalogEntry>;

/**
 * POSIX shell words that need no quoting; anything else is single-quoted.
 */
const SHELL_SAFE_WORD = /^[\w%+,./:=@-]+$/u;

function shellWord(value: string): string {
    return SHELL_SAFE_WORD.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * A command a person pastes into their own terminal to continue one Agent Session in the provider's TUI, outside Caxri.
 * It starts with `cd` into the Terminal's folder because Claude Code only finds a session under the folder it was
 * started in. It uses the bare executable name and none of the user's launch arguments: it is a hand-off, not a
 * reproduction of Caxri's launch.
 */
export function agentResumeCommandLine(
    provider: AgentProvider,
    agentSessionId: string,
    cwd: string,
): string {
    const { executableName, resumeArgs } = agentProviderCatalog[provider];
    return `cd ${shellWord(cwd)} && ${[executableName, ...resumeArgs, agentSessionId].map(shellWord).join(' ')}`;
}

/**
 * Provider-scoped defaults keep future CLI-specific settings under the provider they configure.
 */
export const defaultAgentProviderSettings = Object.fromEntries(
    agentProviderIds.map((provider) => [
        provider,
        {
            actions: structuredClone(defaultAgentActionsSettings),
            hooks: { enabled: true },
            messaging: { enabled: agentProviderCatalog[provider].capabilities.messaging },
            recovery: { ...defaultAgentOutputRecoverySettings, patterns: [] },
            launch: {
                executable: agentProviderCatalog[provider].executableName,
                args: [...agentProviderCatalog[provider].defaultLaunchArgs],
            },
        },
    ]),
) as unknown as Record<AgentProvider, AgentProviderSettings>;
