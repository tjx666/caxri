import type { AgentOutputRecoverySettings, AgentProvider, TerminalSnapshot } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type * as pty from 'node-pty';

import type {
    TerminalExecutionEvent as DomainExecutionEvent,
    TerminalExecutionExit as DomainExecutionExit,
    TerminalExecutionPort,
} from '../../domains/terminal';
import { TerminalExecutionEngine } from '../../terminal-host/engine';

const unavailableTestPtySpawn: typeof pty.spawn = () => {
    throw new Error('Terminal tests that launch a process must inject a PTY spawn implementation');
};

export interface LocalTerminalExecutionOptions {
    agentOutputRecoverySettings?: (provider: AgentProvider) => AgentOutputRecoverySettings;
    currentProvider?: (terminalId: string) => AgentProvider | undefined;
    logger: StructuredLogger;
    outputFlushMs?: number;
    sampleResources?: ConstructorParameters<typeof TerminalExecutionEngine>[0]['sampleResources'];
    spawn?: typeof pty.spawn;
    terminalColors?: () => { background: string; foreground: string };
}

/**
 * In-process adapter retained for focused engine tests. Production Server Core supplies the process-backed port.
 */
export class LocalTerminalExecution extends EventTarget implements TerminalExecutionPort {
    private readonly engine: TerminalExecutionEngine;

    constructor(options: LocalTerminalExecutionOptions) {
        super();
        this.engine = new TerminalExecutionEngine({
            agentOutputRecoverySettings: options.agentOutputRecoverySettings,
            currentProvider: options.currentProvider,
            emit: (event) =>
                this.dispatchEvent(
                    new CustomEvent<DomainExecutionEvent>('event', { detail: event }),
                ),
            logger: options.logger,
            onExit: (event) => {
                this.dispatchEvent(new CustomEvent<DomainExecutionExit>('exit', { detail: event }));
            },
            outputFlushMs: options.outputFlushMs,
            sampleResources: options.sampleResources,
            spawn: options.spawn ?? unavailableTestPtySpawn,
            terminalColors: options.terminalColors,
        });
    }

    reserve(): Promise<void> {
        return Promise.resolve();
    }

    start(input: Parameters<TerminalExecutionPort['start']>[0]): Promise<number> {
        return Promise.resolve(
            this.engine.start({
                args: input.args,
                environment: input.environment,
                executable: input.executable,
                initialSnapshot: input.initialSnapshot?.payload ?? '',
                record: input.record,
            }),
        );
    }

    waitForAttachedSize(
        terminalId: string,
        timeoutMs: number,
        abortSignal?: AbortSignal,
    ): Promise<void> {
        return this.engine.waitForAttachedSize(terminalId, timeoutMs, abortSignal);
    }

    write(terminalId: string, data: string): boolean {
        return this.engine.write(terminalId, data);
    }

    configureOutputRecovery(): void {
        this.engine.reconcileOutputRecoverySettings();
    }

    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean {
        return this.engine.signalExact(terminalId, expectedProcessId, signal);
    }

    resize(terminalId: string, cols: number, rows: number): boolean {
        return this.engine.resize(terminalId, cols, rows);
    }

    attach(
        terminalId: string,
        size?: { cols: number; rows: number },
    ): Promise<{ snapshot: TerminalSnapshot | null; wasAttached: boolean }> {
        return this.engine.attach(terminalId, size);
    }

    snapshot(terminalId: string): Promise<TerminalSnapshot | null> {
        return this.engine.snapshot(terminalId);
    }

    detachView(terminalId: string): void {
        this.engine.detachView(terminalId);
    }

    detachAllViews(): void {
        this.engine.detachAllViews();
    }

    restartBarrier(terminalId: string): Promise<TerminalSnapshot | null> {
        return this.engine.restartBarrier(terminalId) ?? Promise.resolve(null);
    }

    close(terminalId: string): void {
        this.engine.close(terminalId);
    }

    discard(terminalId: string): void {
        this.engine.discard(terminalId);
    }

    reassignSession(terminalId: string, sessionId: string): void {
        this.engine.reassignSession(terminalId, sessionId);
    }

    terminateSession(sessionId: string, terminalIds: readonly string[]): string[] {
        return this.engine.terminateSession(sessionId, terminalIds);
    }

    runningCount(sessionId?: string): number {
        return this.engine.runningCount(sessionId);
    }

    processId(terminalId: string): number | undefined {
        return this.engine.processId(terminalId);
    }

    resources(terminalId: string): ReturnType<TerminalExecutionPort['resources']> {
        return this.engine.resources(terminalId);
    }

    shutdown(): Promise<Array<{ terminalId: string; capture: Promise<TerminalSnapshot> }>> {
        return Promise.resolve(this.engine.shutdown());
    }

    onEvent(listener: (event: DomainExecutionEvent) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<DomainExecutionEvent>).detail);
        this.addEventListener('event', handler);
        return () => this.removeEventListener('event', handler);
    }

    onExit(listener: (event: DomainExecutionExit) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<DomainExecutionExit>).detail);
        this.addEventListener('exit', handler);
        return () => this.removeEventListener('exit', handler);
    }

    onHostExit(): () => void {
        return () => {};
    }
}
