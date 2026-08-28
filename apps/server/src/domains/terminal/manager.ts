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

import type { ShutdownReason } from '../session-policy';
import { shutdownOutcome } from '../session-policy';
import { SingleFlight } from '../single-flight';
import type {
    TerminalExecutionEvent,
    TerminalExecutionExit,
    TerminalExecutionPort,
} from './execution-port';
import { TerminalLaunchPlanner } from './launch-plan';
import type { TerminalManagerOptions, TerminalStartOptions } from './manager-types';
import { TerminalSnapshotPersistence } from './snapshot-persistence';
import type { TerminalStateStore } from './state-store';
import { createTerminalTitleListener } from './terminal-title';

const ptyLogEvents = logEventCatalog.pty;
type TerminalTitleListener = ReturnType<typeof createTerminalTitleListener>;

/**
 * Core-owned Terminal coordinator. It authorizes launch plans, persists durable state and projects execution events;
 * volatile PTY, screen, buffer and attachment ownership stays behind {@link TerminalExecutionPort}.
 */
export class TerminalManager {
    private readonly agentOutputRecoverySettings?: TerminalManagerOptions['agentOutputRecoverySettings'];
    private readonly execution: TerminalExecutionPort;
    private readonly executionListeners: Array<() => void>;
    private readonly launchPlanner: TerminalLaunchPlanner;
    private readonly snapshots: TerminalSnapshotPersistence;
    private readonly starts = new SingleFlight<string, TerminalRecord>();
    private readonly titleListeners = new Map<string, TerminalTitleListener>();
    private readonly onLifecycleStarted?: TerminalManagerOptions['onLifecycleStarted'];
    private readonly onLifecycleRetired?: TerminalManagerOptions['onLifecycleRetired'];
    private readonly onOutputActivity?: TerminalManagerOptions['onOutputActivity'];
    private readonly onStateChanged?: TerminalManagerOptions['onStateChanged'];
    private readonly terminalColors?: TerminalManagerOptions['terminalColors'];

    constructor(
        private readonly database: TerminalStateStore,
        private readonly emit: (event: ServerEvent) => void,
        private readonly logger: StructuredLogger,
        options: TerminalManagerOptions,
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
        this.agentOutputRecoverySettings = options.agentOutputRecoverySettings;
        this.terminalColors = options.terminalColors;
        this.snapshots = new TerminalSnapshotPersistence(database, logger);
        this.execution = options.execution;
        this.executionListeners = [
            this.execution.onEvent((event) => this.projectExecutionEvent(event)),
            this.execution.onExit((event) => {
                // eslint-disable-next-line no-void -- Exit finalization owns and reports its asynchronous failures.
                void this.onExecutionExit(event);
            }),
            this.execution.onHostExit((terminalIds) => this.onExecutionHostExit(terminalIds)),
        ];
    }

    private onExecutionHostExit(terminalIds: readonly string[]): void {
        const interrupted: string[] = [];
        for (const terminalId of terminalIds) {
            this.retireCoreLifecycleSoon(terminalId);
            if (!this.database.getTerminal(terminalId)) continue;
            this.database.updateTerminalState(terminalId, 'interrupted');
            this.onStateChanged?.(terminalId, 'interrupted');
            interrupted.push(terminalId);
        }
        if (interrupted.length > 0)
            this.emit({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: interrupted },
            });
    }

    private logAttach(
        terminalId: string,
        size: { cols: number; rows: number } | undefined,
        wasAttached: boolean,
        source: 'live' | 'persisted',
        payloadBytes: number,
    ): void {
        /**
         * Content-free evidence localizes reconnect failures without recording Terminal output or snapshots.
         */
        this.logger.write('info', ptyLogEvents.attach, {
            fields: {
                terminalId,
                source,
                wasAttached,
                payloadBytes,
                ...(size !== undefined && { cols: size.cols, rows: size.rows }),
            },
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
            const activitySessionId = this.database.updateTerminalExitState(event.record.id, state);
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
                payload: {
                    kind: 'records',
                    sessionIds: activitySessionId ? [activitySessionId] : [],
                    terminalIds: [event.record.id],
                },
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
            await this.execution.reserve(record);
            if (options?.waitForAttachedSizeMs)
                await this.execution.waitForAttachedSize(
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
            await this.execution.start({
                args: prepared.value.args,
                colors: this.terminalColors?.(),
                environment: prepared.value.environment,
                executable: prepared.value.executable,
                initialSnapshot: this.snapshots.read(record.id),
                outputRecovery: record.provider
                    ? this.agentOutputRecoverySettings?.(record.provider)
                    : undefined,
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
            this.execution.discard(record.id);
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
        if (this.execution.processId(record.id) !== undefined)
            return Promise.resolve(this.database.getTerminal(record.id)!);
        return this.starts.run(record.id, () => this.spawn(record, options));
    }

    write(terminalId: string, data: string): boolean {
        return this.execution.write(terminalId, data);
    }

    reconcileOutputRecoverySettings(): void {
        for (const terminal of this.database.listTerminals())
            this.execution.configureOutputRecovery(
                terminal.id,
                terminal.provider,
                terminal.provider
                    ? this.agentOutputRecoverySettings?.(terminal.provider)
                    : undefined,
            );
    }

    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean {
        return this.execution.signalExact(terminalId, expectedProcessId, signal);
    }

    resize(terminalId: string, cols: number, rows: number): boolean {
        return this.execution.resize(terminalId, cols, rows);
    }

    async attach(
        terminalId: string,
        size?: { cols: number; rows: number },
    ): Promise<TerminalSnapshot | null> {
        const pendingSnapshot = this.snapshots.pending(terminalId);
        if (pendingSnapshot) await pendingSnapshot;
        if (
            this.execution.processId(terminalId) === undefined &&
            !this.database.getTerminal(terminalId)
        )
            return null;
        const attached = await this.execution.attach(terminalId, size);
        const snapshot = attached.snapshot ?? this.snapshots.read(terminalId);
        this.logAttach(
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
        const live = await this.execution.snapshot(terminalId);
        if (live) return live;
        if (!this.database.getTerminal(terminalId)) return null;
        return this.snapshots.read(terminalId);
    }

    detachView(terminalId: string): void {
        this.execution.detachView(terminalId);
    }

    detachAllViews(): void {
        this.execution.detachAllViews();
    }

    async restart(terminalId: string, options?: TerminalStartOptions): Promise<TerminalRecord> {
        const record = this.database.getTerminal(terminalId);
        if (!record) throw new CaxriError('NOT_FOUND', 'Terminal not found');
        const capture = await this.execution.restartBarrier(terminalId);
        if (capture) {
            this.retireCoreLifecycleSoon(terminalId);
            await this.snapshots.finalize(terminalId, Promise.resolve(capture));
        }
        this.database.updateTerminalState(terminalId, 'starting');
        this.onStateChanged?.(terminalId, 'starting');
        const restarting = this.database.getTerminal(terminalId);
        if (!restarting) throw new CaxriError('CONFLICT', 'Terminal was closed while restarting');
        return this.start(restarting, options);
    }

    close(terminalId: string): void {
        if (this.execution.processId(terminalId) !== undefined)
            this.retireCoreLifecycleSoon(terminalId);
        this.execution.close(terminalId);
        this.onStateChanged?.(terminalId, 'stopped');
        this.database.closeTerminal(terminalId);
    }

    reassignSession(terminalId: string, sessionId: string): void {
        this.execution.reassignSession(terminalId, sessionId);
    }

    terminateSession(sessionId: string): void {
        const terminalIds = this.database.listTerminals(sessionId).map(({ id }) => id);
        for (const terminalId of terminalIds) this.onStateChanged?.(terminalId, 'stopped');
        const retired = this.execution.terminateSession(sessionId, terminalIds);
        for (const terminalId of retired) this.retireCoreLifecycleSoon(terminalId);
    }

    runningCount(sessionId?: string): number {
        return this.execution.runningCount(sessionId);
    }

    processId(terminalId: string): number | undefined {
        return this.execution.processId(terminalId);
    }

    resources(terminalId: string): Promise<TerminalResourceUsage | null> {
        return this.execution.resources(terminalId);
    }

    async shutdown(reason: Exclude<ShutdownReason, 'unclean'>): Promise<void> {
        const terminalProcessState = shutdownOutcome(reason).terminalProcessState;
        const finalizations = await this.execution.shutdown();
        for (const { terminalId } of finalizations) this.retireCoreLifecycleSoon(terminalId);
        await Promise.all(
            finalizations.map(({ terminalId, capture }) =>
                this.snapshots.finalize(terminalId, capture),
            ),
        );
        this.database.markShutdown(reason);
        for (const { terminalId } of finalizations)
            this.onStateChanged?.(terminalId, terminalProcessState);
        for (const dispose of this.executionListeners) dispose();
    }
}
