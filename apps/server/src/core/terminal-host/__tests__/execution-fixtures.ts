import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord, TerminalSnapshot } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';

import type {
    TerminalHostMessage,
    TerminalHostRequest,
    TerminalHostScope,
} from '../../../terminal-host/protocol';
import { RemoteTerminalExecution } from '../execution';
import type { TerminalHostControl } from '../execution-contract';

type HostEvent = Exclude<Extract<TerminalHostMessage, { type: 'event' }>, { event: 'host.ready' }>;

const temporaryDirectories: string[] = [];
const temporaryLoggers: StructuredLogger[] = [];

export const terminal: TerminalRecord = {
    id: 'terminal-1',
    sessionId: 'session-1',
    cwd: '/project',
    kind: 'shell',
    title: 'Shell',
    orderIndex: 0,
    lastProcessState: 'starting',
    createdAt: 1,
    updatedAt: 1,
};

export const snapshot: TerminalSnapshot = {
    terminalId: terminal.id,
    encodingVersion: 1,
    cols: 120,
    rows: 40,
    lineCount: 1,
    byteCount: 6,
    payload: 'screen',
    updatedAt: 2,
};

export class FakeTerminalHostControl implements TerminalHostControl {
    private readonly eventListeners = new Set<(event: HostEvent) => void>();
    private readonly exitListeners = new Set<
        (event: { code: number; signal: NodeJS.Signals | null }) => void
    >();
    private readonly inputResolvers: Array<{ resolve(): void }> = [];
    private readonly agentInputResolvers: Array<() => void> = [];
    private readonly attachResolvers: Array<{ resolve(): void; reject(error: Error): void }> = [];
    private readonly resizeResolvers: Array<() => void> = [];
    declineNextInput = false;
    declineNextAgentInput = false;
    failNextInput?: Error;
    failNextAgentInput?: Error;
    /**
     * Payload `terminal.attach` answers with. Terminal Host serializes the live screen, so bytes it has already flushed
     * as `terminal.output` are still part of the next snapshot; a test that needs both copies to exist sets this.
     */
    attachSnapshot?: TerminalSnapshot;
    /**
     * Rejects the next `terminal.attach` with this error, the shape of a Terminal Host timeout, capacity refusal, or an
     * identity the host no longer knows. The host keeps its previous attachment in that case, so it continues to emit
     * output under the old `attachmentId`.
     */
    failNextAttach?: Error;
    observeReturnsNull = false;
    readonly requests: Array<{ request: TerminalHostRequest; scope: TerminalHostScope }> = [];
    holdAttachRequests = false;
    holdInputRequests = false;
    holdAgentInputRequests = false;
    holdResizeRequests = false;
    /**
     * Whether a ready Host is attached; `close` only retires a Terminal without a live identity while this holds.
     */
    running = true;

    emit(event: HostEvent): void {
        for (const listener of this.eventListeners) listener(event);
    }

    exit(code = 9): void {
        for (const listener of this.exitListeners) listener({ code, signal: null });
    }

    onEvent(listener: (event: HostEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    isRunning(): boolean {
        return this.running;
    }

    onExit(listener: (event: { code: number; signal: NodeJS.Signals | null }) => void): () => void {
        this.exitListeners.add(listener);
        return () => this.exitListeners.delete(listener);
    }

    request(
        request: TerminalHostRequest,
        scope: TerminalHostScope,
        signal?: AbortSignal,
    ): Promise<unknown> {
        this.requests.push({ request, scope });
        switch (request.method) {
            case 'terminal.reserve':
                return Promise.resolve({ reserved: true });
            case 'terminal.attach': {
                if (this.failNextAttach) {
                    const error = this.failNextAttach;
                    this.failNextAttach = undefined;
                    return Promise.reject(error);
                }
                const answer = (): { snapshot: TerminalSnapshot | null; wasAttached: boolean } => ({
                    snapshot: this.attachSnapshot ?? null,
                    wasAttached: false,
                });
                if (!this.holdAttachRequests) return Promise.resolve(answer());
                return new Promise((resolve, reject) =>
                    this.attachResolvers.push({ resolve: () => resolve(answer()), reject }),
                );
            }
            case 'terminal.start':
                return Promise.resolve({ processId: 4243 });
            case 'terminal.observe':
                return Promise.resolve({
                    snapshot: this.observeReturnsNull ? null : snapshot,
                    nextSequence: 4,
                });
            case 'terminal.unobserve':
                return Promise.resolve({ detached: true });
            case 'terminal.takeOver':
            case 'terminal.renewTakeOver':
                return Promise.resolve({ expiresAt: Date.now() + request.params.timeoutMs });
            case 'terminal.releaseTakeOver':
                return Promise.resolve({ released: true });
            case 'terminal.observer.input':
                return Promise.resolve({ accepted: true });
            case 'terminal.stop':
                return Promise.resolve({ snapshot, stopped: true });
            case 'terminal.retire':
                return Promise.resolve({ retired: true });
            case 'terminal.input':
                if (this.declineNextInput) {
                    this.declineNextInput = false;
                    return Promise.resolve({ accepted: false });
                }
                if (this.failNextInput) {
                    const error = this.failNextInput;
                    this.failNextInput = undefined;
                    return Promise.reject(error);
                }
                if (!this.holdInputRequests) return Promise.resolve({ accepted: true });
                return new Promise((resolve, reject) => {
                    let isSettled = false;
                    const abort = (): void => {
                        if (isSettled) return;
                        isSettled = true;
                        signal?.removeEventListener('abort', abort);
                        reject(new Error('input aborted'));
                    };
                    signal?.addEventListener('abort', abort, { once: true });
                    this.inputResolvers.push({
                        resolve() {
                            if (isSettled) return;
                            isSettled = true;
                            signal?.removeEventListener('abort', abort);
                            resolve({ accepted: true });
                        },
                    });
                });
            case 'terminal.agent.input':
                if (this.declineNextAgentInput) {
                    this.declineNextAgentInput = false;
                    return Promise.resolve({ accepted: false });
                }
                if (this.failNextAgentInput) {
                    const error = this.failNextAgentInput;
                    this.failNextAgentInput = undefined;
                    return Promise.reject(error);
                }
                if (!this.holdAgentInputRequests) return Promise.resolve({ accepted: true });
                return new Promise((resolve) =>
                    this.agentInputResolvers.push(() => resolve({ accepted: true })),
                );
            case 'terminal.resize':
                if (!this.holdResizeRequests) return Promise.resolve({ accepted: true });
                return new Promise((resolve) =>
                    this.resizeResolvers.push(() => resolve({ accepted: true })),
                );
            default:
                return Promise.resolve({ accepted: true });
        }
    }

    releaseAttach(error?: Error): void {
        const pending = this.attachResolvers.shift();
        if (!pending) return;
        if (error) pending.reject(error);
        else pending.resolve();
    }

    releaseInput(): void {
        this.inputResolvers.shift()?.resolve();
    }

    releaseAgentInput(): void {
        this.agentInputResolvers.shift()?.();
    }

    releaseResize(): void {
        this.resizeResolvers.shift()?.();
    }

    requestCount(method: TerminalHostRequest['method']): number {
        return this.requests.filter(({ request }) => request.method === method).length;
    }

    shutdown(): Promise<{ failures: never[]; snapshots: TerminalSnapshot[] }> {
        return Promise.resolve({ failures: [], snapshots: [snapshot] });
    }
}

export function createExecution(): {
    control: FakeTerminalHostControl;
    execution: RemoteTerminalExecution;
    logger: StructuredLogger;
} {
    const directory = mkdtempSync(join(tmpdir(), 'caxri-remote-terminal-execution-'));
    temporaryDirectories.push(directory);
    const control = new FakeTerminalHostControl();
    const logger = new StructuredLogger(join(directory, 'logs'), 'server-core');
    temporaryLoggers.push(logger);
    return {
        control,
        execution: new RemoteTerminalExecution(control, logger),
        logger,
    };
}

/**
 * Brings up a Terminal running a managed Agent with no Renderer attachment: the shape a background delegation writes
 * to, and the only one whose Agent input is admitted before the Terminal Host has answered.
 */
export async function startBackgroundAgent(
    execution: RemoteTerminalExecution,
    control: FakeTerminalHostControl,
    launchId = 'launch-1',
): Promise<void> {
    await execution.reserve(terminal);
    await execution.start({
        args: ['-l'],
        environment: { TERM: 'xterm-256color' },
        executable: '/bin/zsh',
        initialSnapshot: null,
        record: terminal,
        agent: {
            launchId,
            provider: 'claude',
            executable: '/usr/local/bin/claude',
            args: ['--resume', 'session-1'],
            environment: {},
        },
    });
    control.emit({
        type: 'event',
        event: 'terminal.agent.started',
        identity: {
            scope: 'terminal',
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        },
        launchId,
        processId: 4244,
    });
}

/**
 * Flushes background failure observations before removing their temporary log directories.
 */
export async function cleanupExecutionFixtures(): Promise<void> {
    const pendingLoggers = [...temporaryLoggers];
    temporaryLoggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    const pendingDirectories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    for (const directory of pendingDirectories) rmSync(directory, { force: true, recursive: true });
}
