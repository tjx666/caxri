import type {
    AgentLaunchSettings,
    AgentOutputRecoverySettings,
    AgentProvider,
    ProcessState,
    TerminalKind,
    TerminalRecord,
} from '@caxri/protocol';

import type { TerminalExecutionPort } from './execution-port';

export type TerminalLifecycleCause =
    | 'hostRestart'
    | 'terminalRestart'
    | 'surfaceSwitched'
    | 'idleSuspended'
    | 'untouchedSuspended'
    | 'sessionArchived'
    | 'terminalClosed'
    | 'serverShutdown';

export interface TerminalManagerOptions {
    execution: TerminalExecutionPort;
    resolveExecutable?: (
        kind: TerminalKind,
        launchSettings?: AgentLaunchSettings,
    ) => Promise<string>;
    /**
     * Server-owned arguments for one Terminal's managed Agent, added after the provider's own on every launch, restore,
     * and restart. They sit outside the user's launch settings, so a delegation's frozen settings never drop them.
     */
    agentLaunchArguments?: (record: TerminalRecord) => readonly string[];
    agentLaunchSettings?: (provider: AgentProvider) => AgentLaunchSettings;
    agentOutputRecoverySettings?: (provider: AgentProvider) => AgentOutputRecoverySettings;
    agentEnvironment?: () => Promise<NodeJS.ProcessEnv>;
    /**
     * Supplies observation-only hook context for the Shell PTY, never managed Agent Endpoint credentials.
     */
    shellEnvironment?: (record: TerminalRecord) => NodeJS.ProcessEnv;
    /**
     * Revokes Shell observation before the PTY is retired or replaced.
     */
    onShellRetired?: (terminalId: string) => void;
    /**
     * Adds generation-scoped, non-secret integration variables immediately before PTY spawn.
     */
    lifecycleEnvironment?: (
        record: TerminalRecord,
        launch?: AgentLaunchSettings,
        launchId?: string,
        delegationId?: string,
    ) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
    /**
     * Runs once a PTY launch is recorded `running`, before the launch resolves to its caller. Archive and Project
     * hiding park only Terminals that already have a process, so a Host start still in flight when they ran relies on
     * this to park it rather than leave it running unseen.
     */
    onLaunched?: (record: TerminalRecord) => void | Promise<void>;
    /**
     * Publishes a prepared generation only after its PTY is registered as live.
     */
    onLifecycleStarted?: (record: TerminalRecord, launchId: string) => void | Promise<void>;
    /**
     * Revokes lifecycle integration for a PTY generation before its durable record can be reused.
     */
    onLifecycleRetired?: (terminalId: string, launchId?: string) => void | Promise<void>;
    /**
     * Dispatch receipts follow the managed Agent child rather than the long-lived Shell state.
     */
    onAgentStateChanged?: (
        terminalId: string,
        state: ProcessState,
        cause?: TerminalLifecycleCause,
    ) => void;
    /**
     * Dispatch receipts observe durable process state without reading Terminal output.
     */
    onStateChanged?: (terminalId: string, state: ProcessState) => void;
    /**
     * Signals raw PTY activity even while no Renderer view is attached; consumers receive no content.
     */
    onOutputActivity?: (terminalId: string, processId: number) => void;
    /**
     * Signals that Core delivered input to a Terminal; consumers receive no content.
     */
    onInput?: (terminalId: string, data: string) => void;
    shellIntegration?: (
        executable: string,
        environment: NodeJS.ProcessEnv,
    ) => { args: string[]; environment: NodeJS.ProcessEnv } | undefined;
    /**
     * Current theme terminal colors used to answer OSC 10/11 default-color queries at the PTY boundary. Without this,
     * an Agent CLI's short startup color probe (Codex allows ~100ms) always expires before the Renderer's xterm.js
     * attaches and can reply, so TUIs silently drop their themed backgrounds. The Terminal Host owns the responder.
     */
    terminalColors?: () => { background: string; foreground: string };
}

export interface TerminalWorkingDirectoryIdentity {
    device: string;
    inode: string;
    path: string;
}

export interface TerminalStartOptions {
    /**
     * Server-owned task identity; never accepted from a public Terminal launch request.
     */
    delegationId?: string;
    /**
     * Preallocated Server-owned identity; never accepted from a public launch request.
     */
    assignedAgentSessionId?: string;
    /**
     * Frozen Server-owned launch configuration for one admitted delegation.
     */
    launchSettings?: AgentLaunchSettings;
    /**
     * Relaunches the Agent on the approval mode (YOLO or not) of this Terminal's previous Agent launch rather than the
     * current Settings switch; see `AgentRunAutonomy`.
     */
    shouldKeepAgentAutonomy?: boolean;
    /**
     * Server-generated private-file pointer, appended after provider-native resume arguments.
     */
    initialPrompt?: string;
    expectedWorkingDirectory?: TerminalWorkingDirectoryIdentity;
    resumeAgentSessionId?: string;
    /**
     * Explicitly starts the bound Agent runtime. By default a stopped Agent restores only its Shell.
     */
    launchAgent?: boolean;
    /**
     * Restore generations use this to abandon stale discovery before it spawns a process.
     */
    shouldStart?: () => boolean;
    /**
     * Cancels a visible restore's grid wait when its restore generation becomes stale.
     */
    abortSignal?: AbortSignal;
    /**
     * Gives a visible restored Terminal time to publish its receiving Renderer grid.
     */
    waitForAttachedSizeMs?: number;
}
