import type * as pty from 'node-pty';

import type {
    AgentLaunchSettings,
    AgentOutputRecoverySettings,
    AgentProvider,
} from '../../shared/agents';
import type {
    ProcessState,
    TerminalKind,
    TerminalRecord,
    TerminalResourceUsage,
} from '../../shared/types';
import type { TerminalOutputQueue } from './buffer';
import type { TerminalColorQueryResponder } from './color-query';
import type { TerminalImageOutputFilter, TerminalImageRecoveryFilter } from './image-recovery';
import type { AgentOutputRecovery } from './output-recovery';
import type { TerminalScreenState } from './screen';

export interface LiveTerminal {
    colorQuery?: TerminalColorQueryResponder;
    imageRecovery: TerminalImageRecoveryFilter;
    imageOutput: TerminalImageOutputFilter;
    process: pty.IPty;
    record: TerminalRecord;
    screen: TerminalScreenState;
    outputRecovery?: AgentOutputRecovery;
    outputRecoveryProvider?: AgentProvider;
    outputQueue: TerminalOutputQueue;
    droppedBytes: number;
    metricOutputBytes: number;
    metricInputBytes: number;
    metricDroppedBytes: number;
    activityTimer?: NodeJS.Timeout;
    outputTimer?: NodeJS.Timeout;
    metricTimer?: NodeJS.Timeout;
}

export interface TerminalManagerOptions {
    /**
     * Test seam for deterministic output-queue backpressure. Production uses the fixed 16 ms coalescing window.
     */
    outputFlushMs?: number;
    resolveExecutable?: (
        kind: TerminalKind,
        launchSettings?: AgentLaunchSettings,
    ) => Promise<string>;
    agentLaunchSettings?: (provider: AgentProvider) => AgentLaunchSettings;
    agentOutputRecoverySettings?: (provider: AgentProvider) => AgentOutputRecoverySettings;
    agentEnvironment?: () => Promise<NodeJS.ProcessEnv>;
    /**
     * Adds generation-scoped, non-secret integration variables immediately before PTY spawn.
     */
    lifecycleEnvironment?: (
        record: TerminalRecord,
        launch?: AgentLaunchSettings,
    ) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
    /**
     * Publishes a prepared generation only after its PTY is registered as live.
     */
    onLifecycleStarted?: (record: TerminalRecord) => void | Promise<void>;
    /**
     * Revokes lifecycle integration for a PTY generation before its durable record can be reused.
     */
    onLifecycleRetired?: (terminalId: string) => void | Promise<void>;
    /**
     * Dispatch receipts observe durable process state without reading Terminal output.
     */
    onStateChanged?: (terminalId: string, state: ProcessState) => void;
    /**
     * Signals raw PTY activity even while no Renderer view is attached; consumers receive no content.
     */
    onOutputActivity?: (terminalId: string, processId: number) => void;
    spawn?: typeof pty.spawn;
    sampleResources?: (pid: number) => Promise<TerminalResourceUsage | null>;
    shellIntegration?: (
        executable: string,
        environment: NodeJS.ProcessEnv,
    ) => { args: string[]; environment: NodeJS.ProcessEnv } | undefined;
    /**
     * Current theme terminal colors used to answer OSC 10/11 default-color queries at the PTY boundary. Without this,
     * an Agent CLI's short startup color probe (Codex allows ~100ms) always expires before the Renderer's xterm.js
     * attaches and can reply, so TUIs silently drop their themed backgrounds. See {@link TerminalColorQueryResponder}.
     */
    terminalColors?: () => { background: string; foreground: string };
}

export interface TerminalWorkingDirectoryIdentity {
    device: string;
    inode: string;
    path: string;
}

export interface TerminalStartOptions {
    expectedWorkingDirectory?: TerminalWorkingDirectoryIdentity;
    resumeAgentSessionId?: string;
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

export interface TerminalGridSize {
    cols: number;
    rows: number;
}

export type AttachedSizeWaiter = () => void;
