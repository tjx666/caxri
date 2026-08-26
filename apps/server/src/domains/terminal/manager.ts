import type {
    ServerEvent,
    TerminalFailureReason,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
} from '@caxri/protocol';
import { CaxriError, errorMessage, toWireError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { TerminalExecutionEvent, TerminalExecutionExit } from '../../terminal-host/engine';
import { TerminalExecutionEngine } from '../../terminal-host/engine';
import type { ShutdownReason } from '../session-policy';
import { shutdownOutcome } from '../session-policy';
import { SingleFlight } from '../single-flight';
import { TerminalLaunchPlanner } from './launch-plan';
import type { TerminalManagerOptions, TerminalStartOptions } from './manager-types';
import { TerminalSnapshotPersistence } from './snapshot-persistence';
import type { TerminalStateStore } from './state-store';
import { createTerminalTitleListener } from './terminal-title';

const ptyLogEvents = logEventCatalog.pty;
type TerminalTitleListener = ReturnType<typeof createTerminalTitleListener>;

/**
 * Core-owned Terminal coordinator. It authorizes launch plans, persists durable state and projects execution events;
 * volatile PTY, screen, buffer and attachment ownership lives in {@link TerminalExecutionEngine}.
 */
export class TerminalManager {
    private readonly engine: TerminalExecutionEngine;
    private readonly launchPlanner: TerminalLaunchPlanner;
    private readonly snapshots: TerminalSnapshotPersistence;
    private readonly starts = new SingleFlight<string, TerminalRecord>();
    private readonly titleListeners = new Map<string, TerminalTitleListener>();
    private readonly onLifecycleStarted?: TerminalManagerOptions['onLifecycleStarted'];
    private readonly onLifecycleRetired?: TerminalManagerOptions['onLifecycleRetired'];
    private readonly onOutputActivity?: TerminalManagerOptions['onOutputActivity'];
    private readonly onStateChanged?: TerminalManagerOptions['onStateChanged'];

    constructor(
        private readonly database: TerminalStateStore,
        private readonly emit: (event: ServerEvent) => void,
        private readonly logger: StructuredLogger,
        options: TerminalManagerOptions = {},
    ) {
        this.launchPlanner = new TerminalLaunchPlanner({
            agentEnvironment: options.agentEnvironment,
            agentLaunchSettings: options.agentLaunchSettings,
            lifecycleEnvironment: options.lifecycleEnvironment,
            logger,
            resolveExecutable: options.resolveExecutable,
            shellIntegration: options.shellIntegration,
        });
        this.onLifecycleStarted = options.onLifecycleStarted;
        this.onLifecycleRetired = options.onLifecycleRetired;
        this.onOutputActivity = options.onOutputActivity;
        this.onStateChanged = options.onStateChanged;
        this.snapshots = new TerminalSnapshotPersistence(database, logger);
        this.engine = new TerminalExecutionEngine({
            agentOutputRecoverySettings: options.agentOutputRecoverySettings,
            currentProvider: (terminalId) => this.database.getTerminal(terminalId)?.provider,
            emit: (event) => this.projectExecutionEvent(event),
            logger,
            onExit: (event) => this.onExecutionExit(event),
            outputFlushMs: options.outputFlushMs,
            sampleResources: options.sampleResources,
            spawn: options.spawn,
            terminalColors: options.terminalColors,
        });
    }

    private projectExecutionEvent(event: TerminalExecutionEvent): void {
        switch (event.type) {
            case 'output': {
                this.emit({
                    event: 'terminal.output',
                    payload: {
                        terminalId: event.terminalId,
                        data: event.data,
                        ...(event.droppedBytes !== undefined && {
                            droppedBytes: event.droppedBytes,
                        }),
                    },
                });
                return;
            }
            case 'outputRecovery': {
                this.emit({
                    event: 'terminal.outputRecovery',
                    payload: {
                        terminalId: event.terminalId,
                        provider: event.provider,
                        status: event.status,
                    },
                });
                return;
            }
            case 'activity': {
                this.onOutputActivity?.(event.terminalId, event.processId);
                return;
            }
            case 'title': {
                let listener = this.titleListeners.get(event.terminalId);
                if (!listener) {
                    listener = createTerminalTitleListener(
                        event.terminalId,
                        this.database,
                        this.emit,
                    );
                    this.titleListeners.set(event.terminalId, listener);
                }
                listener(event.title);
            }
        }
    }

    private async onExecutionExit(event: TerminalExecutionExit): Promise<void> {
        try {
            this.retireCoreLifecycleSoon(event.record.id);
            await this.snapshots.finalize(event.record.id, event.capture);
            if (!this.database.getTerminal(event.record.id)) return;
            const isExitedNormally = event.exitCode === 0 && !event.signal;
            const state = isExitedNormally ? 'stopped' : 'dead';
            this.database.updateTerminalState(event.record.id, state);
            this.onStateChanged?.(event.record.id, state);
            this.emit({
                event: 'terminal.exit',
                payload: {
                    terminalId: event.record.id,
                    exitCode: event.exitCode,
                    signal: event.signal,
                },
            });
            this.emit({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: [event.record.id] },
            });
            this.logger.write('info', ptyLogEvents.exited, {
                fields: {
                    terminalId: event.record.id,
                    exitCode: event.exitCode,
                    signal: event.signal ?? null,
                },
            });
        } catch (error) {
            this.logger.write('warn', ptyLogEvents.exitFinalizeFailed, {
                fields: { terminalId: event.record.id, error: errorMessage(error, 'unknown') },
            });
        }
    }

    private cancelTitleListener(terminalId: string): void {
        this.titleListeners.get(terminalId)?.cancel();
        this.titleListeners.delete(terminalId);
    }

    private retireCoreLifecycleSoon(terminalId: string): void {
        this.cancelTitleListener(terminalId);
        // eslint-disable-next-line unicorn/prefer-await -- synchronous execution retirement cannot await Core cleanup
        this.retireCoreLifecycle(terminalId).catch((error: unknown) =>
            this.logger.write('warn', ptyLogEvents.lifecycleRetireFailed, {
                fields: { terminalId, error: errorMessage(error, 'unknown') },
            }),
        );
    }

    private async retireCoreLifecycle(terminalId: string): Promise<void> {
        await this.onLifecycleRetired?.(terminalId);
    }

    private async spawn(
        record: TerminalRecord,
        options?: TerminalStartOptions,
    ): Promise<TerminalRecord> {
        const startedAt = performance.now();
        let failureReason: TerminalFailureReason = 'spawn_failed';
        try {
            const pendingSnapshot = this.snapshots.pending(record.id);
            if (pendingSnapshot) await pendingSnapshot;
            if (!this.database.getTerminal(record.id))
                throw new CaxriError('CONFLICT', 'Terminal was closed before launch completed');
            const resolved = await this.launchPlanner.resolve(record, options);
            if (!resolved.ok) {
                failureReason = resolved.failureReason;
                throw resolved.error;
            }
            if (options?.waitForAttachedSizeMs)
                await this.engine.waitForAttachedSize(
                    record.id,
                    options.waitForAttachedSizeMs,
                    options.abortSignal,
                );
            if (options?.shouldStart && !options.shouldStart()) {
                if (!this.database.getTerminal(record.id))
                    throw new CaxriError('CONFLICT', 'Terminal was closed before launch completed');
                this.database.updateTerminalState(record.id, 'interrupted');
                return this.database.getTerminal(record.id)!;
            }
            const prepared = await this.launchPlanner.prepare(
                record,
                resolved.value,
                options?.expectedWorkingDirectory,
            );
            if (!prepared.ok) {
                failureReason = prepared.failureReason;
                throw prepared.error;
            }
            const initialSnapshot = this.snapshots.read(record.id)?.payload ?? '';
            this.engine.start({
                args: prepared.value.args,
                environment: prepared.value.environment,
                executable: prepared.value.executable,
                initialSnapshot,
                record,
            });
            if (!this.database.getTerminal(record.id))
                throw new CaxriError('CONFLICT', 'Terminal was closed before launch completed');
            this.database.updateTerminalState(record.id, 'running');
            await this.onLifecycleStarted?.(record);
            this.logger.write('info', ptyLogEvents.spawned, {
                durationMs: performance.now() - startedAt,
                fields: { terminalId: record.id, kind: record.kind },
            });
            return this.database.getTerminal(record.id)!;
        } catch (error) {
            this.cancelTitleListener(record.id);
            this.engine.discard(record.id);
            try {
                await this.retireCoreLifecycle(record.id);
            } catch (retirementError) {
                this.logger.write('warn', ptyLogEvents.lifecycleRetireFailed, {
                    fields: {
                        terminalId: record.id,
                        error: errorMessage(retirementError, 'unknown'),
                    },
                });
            }
            if (this.database.getTerminal(record.id))
                this.database.updateTerminalState(record.id, 'failed', failureReason);
            const wire = toWireError(error);
            this.logger.write('error', ptyLogEvents.spawnFailed, {
                durationMs: performance.now() - startedAt,
                fields: {
                    code: wire.code,
                    terminalId: record.id,
                    kind: record.kind,
                    error: errorMessage(error, 'unknown'),
                },
            });
            throw error;
        }
    }

    start(record: TerminalRecord, options?: TerminalStartOptions): Promise<TerminalRecord> {
        if (this.engine.processId(record.id) !== undefined)
            return Promise.resolve(this.database.getTerminal(record.id)!);
        return this.starts.run(record.id, () => this.spawn(record, options));
    }

    write(terminalId: string, data: string): boolean {
        return this.engine.write(terminalId, data);
    }

    reconcileOutputRecoverySettings(): void {
        this.engine.reconcileOutputRecoverySettings();
    }

    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean {
        return this.engine.signalExact(terminalId, expectedProcessId, signal);
    }

    resize(terminalId: string, cols: number, rows: number): boolean {
        return this.engine.resize(terminalId, cols, rows);
    }

    async attach(
        terminalId: string,
        size?: { cols: number; rows: number },
    ): Promise<TerminalSnapshot | null> {
        const pendingSnapshot = this.snapshots.pending(terminalId);
        if (pendingSnapshot) await pendingSnapshot;
        if (
            this.engine.processId(terminalId) === undefined &&
            !this.database.getTerminal(terminalId)
        )
            return null;
        const attached = await this.engine.attach(terminalId, size);
        const snapshot = attached.snapshot ?? this.snapshots.read(terminalId);
        this.engine.logAttach(
            terminalId,
            size,
            attached.wasAttached,
            attached.snapshot ? 'live' : 'persisted',
            snapshot?.payload.length ?? 0,
        );
        return snapshot;
    }

    async snapshot(terminalId: string): Promise<TerminalSnapshot | null> {
        const pendingSnapshot = this.snapshots.pending(terminalId);
        if (pendingSnapshot) await pendingSnapshot;
        const live = await this.engine.snapshot(terminalId);
        if (live) return live;
        if (!this.database.getTerminal(terminalId)) return null;
        return this.snapshots.read(terminalId);
    }

    detachView(terminalId: string): void {
        this.engine.detachView(terminalId);
    }

    detachAllViews(): void {
        this.engine.detachAllViews();
    }

    async restart(terminalId: string, options?: TerminalStartOptions): Promise<TerminalRecord> {
        const record = this.database.getTerminal(terminalId);
        if (!record) throw new CaxriError('NOT_FOUND', 'Terminal not found');
        const capture = this.engine.restartBarrier(terminalId);
        if (capture) {
            this.retireCoreLifecycleSoon(terminalId);
            await this.snapshots.finalize(terminalId, capture);
        }
        this.database.updateTerminalState(terminalId, 'starting');
        this.onStateChanged?.(terminalId, 'starting');
        const restarting = this.database.getTerminal(terminalId);
        if (!restarting) throw new CaxriError('CONFLICT', 'Terminal was closed while restarting');
        return this.start(restarting, options);
    }

    close(terminalId: string): void {
        if (this.engine.processId(terminalId) !== undefined)
            this.retireCoreLifecycleSoon(terminalId);
        this.engine.close(terminalId);
        this.onStateChanged?.(terminalId, 'stopped');
        this.database.closeTerminal(terminalId);
    }

    reassignSession(terminalId: string, sessionId: string): void {
        this.engine.reassignSession(terminalId, sessionId);
    }

    terminateSession(sessionId: string): void {
        const terminalIds = this.database.listTerminals(sessionId).map(({ id }) => id);
        for (const terminalId of terminalIds) this.onStateChanged?.(terminalId, 'stopped');
        const retired = this.engine.terminateSession(sessionId, terminalIds);
        for (const terminalId of retired) this.retireCoreLifecycleSoon(terminalId);
    }

    runningCount(sessionId?: string): number {
        return this.engine.runningCount(sessionId);
    }

    processId(terminalId: string): number | undefined {
        return this.engine.processId(terminalId);
    }

    resources(terminalId: string): Promise<TerminalResourceUsage | null> {
        return this.engine.resources(terminalId);
    }

    async shutdown(reason: Exclude<ShutdownReason, 'unclean'>): Promise<void> {
        const terminalProcessState = shutdownOutcome(reason).terminalProcessState;
        const finalizations = this.engine.shutdown();
        for (const { terminalId } of finalizations) this.retireCoreLifecycleSoon(terminalId);
        await Promise.all(
            finalizations.map(({ terminalId, capture }) =>
                this.snapshots.finalize(terminalId, capture),
            ),
        );
        this.database.markShutdown(reason);
        for (const { terminalId } of finalizations)
            this.onStateChanged?.(terminalId, terminalProcessState);
    }
}
