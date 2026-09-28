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
    /**
     * The attachment Terminal Host has already accepted, which lags the requested {@link RemoteView} for as long as a
     * re-attach is in flight — `attach()` records the new view synchronously but publishes it only once
     * `identity.ready` and any admitted hot paths have settled.
     *
     * Output is forwarded only while the two agree. A Renderer that re-attaches while already attached installs its
     * replacement replay buffer before the request leaves, so a frame Terminal Host's 16 ms timer ships during that gap
     * is replayed _after_ the snapshot the same re-attach fetches — and the snapshot already contains it, because the
     * host writes to the live screen before enqueueing. Dropping the forward is what keeps it rendering once (#740).
     *
     * The gap's bytes are therefore not delivered when the re-attach itself fails. Because `attachReserved` publishes
     * this field before the request, a `terminal.attach` the host provably never ran restores `heldAttachmentId` so
     * live output and input keep flowing under it (#910, #938); the frames muted during the gap stay on the host's live
     * screen and arrive with the next successful snapshot.
     */
    attachmentId?: string;
    /**
     * The attachment Terminal Host confirmed last. `attachmentId` is published before `terminal.attach` resolves, so it
     * can name an attachment the host never took; a rejected re-attach falls back to this one instead.
     */
    heldAttachmentId?: string;
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
    | 'terminal.lease'
    | 'terminal.mobile.input'
    | 'terminal.observe'
    | 'terminal.view';

export interface TerminalHostControl {
    /**
     * True only while a ready Terminal Host is attached. A Host that is idle, starting, failed, or stopped holds no
     * generation baseline for Terminals Server Core no longer tracks, so permanent closure need not start one.
     */
    isRunning(): boolean;
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
