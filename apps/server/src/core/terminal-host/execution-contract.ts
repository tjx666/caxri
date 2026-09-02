import type { TerminalRecord, TerminalSnapshot } from '@caxri/protocol';

import type {
    TerminalHostMessage,
    TerminalHostRequest,
    TerminalHostScope,
    TerminalShutdownFailure,
} from '../../terminal-host/protocol';

export interface RemoteTerminalIdentity {
    agent?: {
        launchId: string;
        processId?: number;
    };
    attachmentId?: string;
    generation: number;
    processId?: number;
    ready: Promise<void>;
    record: TerminalRecord;
}

export interface RemoteView {
    attachmentId: string;
    size?: { cols: number; rows: number };
}

export interface RemoteResizeQueue {
    completion?: Promise<void>;
    identity: RemoteTerminalIdentity;
    latest?: { cols: number; rows: number };
    view: RemoteView;
}

export type TerminalHostEvent = Exclude<
    Extract<TerminalHostMessage, { type: 'event' }>,
    { event: 'host.ready' }
>;

export type TerminalHostCapability =
    | 'terminal.agent.input'
    | 'terminal.input'
    | 'terminal.inspect'
    | 'terminal.lifecycle'
    | 'terminal.view';

export interface TerminalHostControl {
    onEvent(listener: (event: TerminalHostEvent) => void): () => void;
    onExit(listener: (event: { code: number; signal: NodeJS.Signals | null }) => void): () => void;
    /**
     * Called before Server Core's own `stop()` sends the graceful `host.shutdown` request, so an OS signal that reaches
     * the Terminal Host child first is recognized as expected teardown rather than a crash. Optional so fakes and tests
     * that never exercise that log-severity distinction can omit it.
     */
    markCoreStopping?(): void;
    request(
        request: TerminalHostRequest,
        scope: TerminalHostScope,
        signal?: AbortSignal,
    ): Promise<unknown>;
    shutdown(liveTerminalCount?: number): Promise<{
        failures: TerminalShutdownFailure[];
        snapshots: TerminalSnapshot[];
    }>;
}
