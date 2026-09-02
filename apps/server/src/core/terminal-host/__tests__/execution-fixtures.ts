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
    icon: 'terminal',
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
    private readonly resizeResolvers: Array<() => void> = [];
    declineNextInput = false;
    failNextInput?: Error;
    readonly requests: Array<{ request: TerminalHostRequest; scope: TerminalHostScope }> = [];
    holdInputRequests = false;
    holdAgentInputRequests = false;
    holdResizeRequests = false;

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
            case 'terminal.attach':
                return Promise.resolve({ snapshot: null, wasAttached: false });
            case 'terminal.start':
                return Promise.resolve({ processId: 4243 });
            case 'terminal.stop':
                return Promise.resolve({ snapshot, stopped: true });
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
} {
    const directory = mkdtempSync(join(tmpdir(), 'caxri-remote-terminal-execution-'));
    temporaryDirectories.push(directory);
    const control = new FakeTerminalHostControl();
    const logger = new StructuredLogger(join(directory, 'logs'), 'server-core');
    temporaryLoggers.push(logger);
    return {
        control,
        execution: new RemoteTerminalExecution(control, logger),
    };
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
