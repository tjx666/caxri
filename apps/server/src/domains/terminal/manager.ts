import type {
    ProcessState,
    ServerEvent,
    TerminalFailureReason,
    TerminalPreview,
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
import { isTerminalProtocolResponse } from './input-origin';
import { TerminalLaunchPlanner } from './launch-plan';
import type {
    TerminalLifecycleCause,
    TerminalManagerOptions,
    TerminalStartOptions,
} from './manager-types';
import { terminalPreview } from './preview';
import { TerminalSnapshotPersistence } from './snapshot-persistence';
import type { TerminalStateStore } from './state-store';
import { createTerminalTitleListener } from './terminal-title';

const ptyLogEvents = logEventCatalog.pty;
type TerminalTitleListener = ReturnType<typeof createTerminalTitleListener>;
interface AgentStartWaiter {
    launchId: string;
    promise: Promise<boolean>;
    resolve(isStarted: boolean): void;
}

/**
 * Core-owned Terminal coordinator. It authorizes launch plans, persists durable state and projects execution events;
 * volatile PTY, screen, buffer and attachment ownership stays behind {@link TerminalExecutionPort}.
 */
export class TerminalManager {
    private readonly agentLaunches = new Map<string, string>();
    private readonly agentStartWaiters = new Map<string, AgentStartWaiter>();
    private readonly agentOutputRecoverySettings?: TerminalManagerOptions['agentOutputRecoverySettings'];
    private readonly execution: TerminalExecutionPort;
    private readonly executionListeners: Array<() => void>;
    private readonly launchPlanner: TerminalLaunchPlanner;
    private readonly snapshots: TerminalSnapshotPersistence;
    private readonly starts = new SingleFlight<string, TerminalRecord>();
    private readonly titleListeners = new Map<string, TerminalTitleListener>();
    private readonly viewSizes = new Map<string, { cols: number; rows: number }>();
    private readonly onLifecycleStarted?: TerminalManagerOptions['onLifecycleStarted'];
    private readonly onLifecycleRetired?: TerminalManagerOptions['onLifecycleRetired'];
    private readonly onShellRetired?: TerminalManagerOptions['onShellRetired'];
    private readonly onAgentStateChanged?: TerminalManagerOptions['onAgentStateChanged'];
    private readonly onOutputActivity?: TerminalManagerOptions['onOutputActivity'];
    private readonly onStateChanged?: TerminalManagerOptions['onStateChanged'];
    private readonly onInput?: TerminalManagerOptions['onInput'];
    private readonly inputEpochs = new Map<string, number>();
    private readonly terminalColors?: TerminalManagerOptions['terminalColors'];

    constructor(
        private readonly database: TerminalStateStore,
        private readonly emit: (event: ServerEvent) => void,
        private readonly logger: StructuredLogger,
        options: TerminalManagerOptions,
    ) {
        this.launchPlanner = new TerminalLaunchPlanner({
            agentEnvironment: options.agentEnvironment,
            agentLaunchArguments: options.agentLaunchArguments,
            agentLaunchSettings: options.agentLaunchSettings,
            lifecycleEnvironment: options.lifecycleEnvironment,
            shellEnvironment: options.shellEnvironment,
            logger,
            resolveExecutable: options.resolveExecutable,
            shellIntegration: options.shellIntegration,
        });
        this.onLifecycleStarted = options.onLifecycleStarted;
        this.onLifecycleRetired = options.onLifecycleRetired;
        this.onShellRetired = options.onShellRetired;
        this.onAgentStateChanged = options.onAgentStateChanged;
        this.onOutputActivity = options.onOutputActivity;
        this.onStateChanged = options.onStateChanged;
        this.onInput = options.onInput;
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
            this.retireAgentLifecycleSoon(terminalId, 'interrupted', 'hostRestart');
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
            case 'sizeOwnership': {
                this.emit({
                    event: 'terminal.sizeOwnership',
                    payload: {
                        terminalId: event.terminalId,
                        owner: event.owner,
                        cols: event.cols,
                        rows: event.rows,
                    },
                });
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
                return;
            }
            case 'agentStarted': {
                // eslint-disable-next-line no-void -- Agent activation is fenced by launch ID and reports failures itself.
                void this.onAgentStarted(event.terminalId, event.launchId);
                return;
            }
            case 'agentExit': {
                // eslint-disable-next-line no-void -- Agent retirement must not block Host event projection.
                void this.onAgentExit(event);
                return;
            }
        }
    }

    private emitAgentState(
        terminalId: string,
        state: ProcessState,
        cause?: TerminalLifecycleCause,
    ): void {
        if (!this.database.getTerminal(terminalId)) return;
        this.database.updateAgentProcessState(terminalId, state);
        this.onAgentStateChanged?.(terminalId, state, cause);
        this.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: [terminalId] },
        });
    }

    private emitAgentExitState(terminalId: string, state: 'dead' | 'stopped'): void {
        if (!this.database.getTerminal(terminalId)) return;
        const changedSessionId = this.database.updateAgentProcessExitState(terminalId, state);
        this.onAgentStateChanged?.(terminalId, state);
        this.emit({
            event: 'state.changed',
            payload: {
                kind: 'records',
                sessionIds: changedSessionId ? [changedSessionId] : [],
                terminalIds: [terminalId],
            },
        });
    }

    private prepareAgentStartWaiter(terminalId: string, launchId: string): void {
        this.agentStartWaiters.get(terminalId)?.resolve(false);
        const { promise, resolve } = Promise.withResolvers<boolean>();
        this.agentStartWaiters.set(terminalId, { launchId, promise, resolve });
    }

    private settleAgentStart(terminalId: string, launchId: string, isStarted: boolean): void {
        const waiter = this.agentStartWaiters.get(terminalId);
        if (!waiter || waiter.launchId !== launchId) return;
        this.agentStartWaiters.delete(terminalId);
        waiter.resolve(isStarted);
    }

    private async onAgentStarted(terminalId: string, launchId: string): Promise<void> {
        if (this.agentLaunches.get(terminalId) !== launchId) return;
        try {
            const terminal = this.database.getTerminal(terminalId);
            if (!terminal) return;
            await this.onLifecycleStarted?.(terminal, launchId);
            if (this.agentLaunches.get(terminalId) !== launchId) return;
            this.execution.configureOutputRecovery(
                terminalId,
                terminal.provider,
                terminal.provider
                    ? this.agentOutputRecoverySettings?.(terminal.provider)
                    : undefined,
            );
            this.emitAgentState(terminalId, 'running');
            this.settleAgentStart(terminalId, launchId, true);
        } catch (error) {
            this.execution.signalAgentExact(terminalId, launchId, 'SIGHUP');
            if (this.agentLaunches.get(terminalId) === launchId) {
                this.agentLaunches.delete(terminalId);
                this.emitAgentState(terminalId, 'failed');
            }
            this.settleAgentStart(terminalId, launchId, false);
            await this.retireCoreLifecycle(terminalId, launchId);
            this.logger.write('warn', ptyLogEvents.lifecycleRetireFailed, {
                fields: { terminalId, error: errorMessage(error, 'unknown') },
            });
        }
    }

    private async onAgentExit(
        event: Extract<TerminalExecutionEvent, { type: 'agentExit' }>,
    ): Promise<void> {
        if (this.agentLaunches.get(event.terminalId) !== event.launchId) return;
        this.agentLaunches.delete(event.terminalId);
        this.settleAgentStart(event.terminalId, event.launchId, false);
        this.execution.configureOutputRecovery(event.terminalId, undefined);
        const state = event.exitCode === 0 && !event.signal ? 'stopped' : 'dead';
        this.emitAgentExitState(event.terminalId, state);
        await this.retireCoreLifecycle(event.terminalId, event.launchId);
    }

    private async onExecutionExit(event: TerminalExecutionExit): Promise<void> {
        try {
            const agentState = event.exitCode === 0 && !event.signal ? 'stopped' : 'dead';
            this.retireAgentLifecycleSoon(event.record.id, agentState);
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

    private retireTerminalViewState(terminalId: string): void {
        this.viewSizes.delete(terminalId);
        this.inputEpochs.delete(terminalId);
    }

    private retireAgentLifecycleSoon(
        terminalId: string,
        state?: ProcessState,
        cause?: TerminalLifecycleCause,
    ): void {
        this.onShellRetired?.(terminalId);
        this.cancelTitleListener(terminalId);
        const launchId = this.agentLaunches.get(terminalId);
        if (launchId) {
            this.agentLaunches.delete(terminalId);
            this.settleAgentStart(terminalId, launchId, false);
            this.execution.configureOutputRecovery(terminalId, undefined);
        }
        /**
         * Closure is authoritative even before launch preparation registers a generation. Restart and natural exit
         * require an old generation, so they cannot settle the new dispatch created before resume.
         */
        const isClosesPendingLaunch = cause === 'terminalClosed' || cause === 'serverShutdown';
        if (
            state &&
            (launchId || (isClosesPendingLaunch && this.database.getTerminal(terminalId)?.provider))
        )
            this.emitAgentState(terminalId, state, cause);
        // eslint-disable-next-line unicorn/prefer-await -- synchronous execution retirement cannot await Core cleanup
        this.retireCoreLifecycle(terminalId, launchId).catch((error: unknown) =>
            this.logger.write('warn', ptyLogEvents.lifecycleRetireFailed, {
                fields: { terminalId, error: errorMessage(error, 'unknown') },
            }),
        );
    }

    private async retireCoreLifecycle(terminalId: string, launchId?: string): Promise<void> {
        await this.onLifecycleRetired?.(terminalId, launchId);
    }

    private async spawn(
        record: TerminalRecord,
        options?: TerminalStartOptions,
    ): Promise<TerminalRecord> {
        const startedAt = performance.now();
        let failureReason: TerminalFailureReason = 'spawn_failed';
        let failureDetail: string | undefined;
        try {
            const pendingSnapshot = this.snapshots.pending(record.id);
            if (pendingSnapshot) await pendingSnapshot;
            if (!this.database.getTerminal(record.id))
                throw new CaxriError('CONFLICT', 'Terminal was closed before launch completed');
            const resolved = await this.launchPlanner.resolve(record, options);
            if (!resolved.ok) {
                failureReason = resolved.failureReason;
                failureDetail = resolved.failureDetail;
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
                options?.delegationId,
            );
            if (!prepared.ok) {
                failureReason = prepared.failureReason;
                failureDetail = prepared.failureDetail;
                throw prepared.error;
            }
            if (options?.shouldStart && !options.shouldStart())
                throw new CaxriError(
                    'CANCELLED',
                    'Terminal launch was cancelled during preparation',
                );
            // Preparation crosses async environment and endpoint boundaries; closure must fence the actual spawn.
            if (!this.database.getTerminal(record.id))
                throw new CaxriError('CONFLICT', 'Terminal was closed before launch completed');
            if (prepared.value.agent)
                this.agentLaunches.set(record.id, prepared.value.agent.launchId);
            if (prepared.value.agent)
                this.prepareAgentStartWaiter(record.id, prepared.value.agent.launchId);
            await this.execution.start({
                args: prepared.value.args,
                ...(prepared.value.agent && { agent: prepared.value.agent }),
                colors: this.terminalColors?.(),
                environment: prepared.value.environment,
                executable: prepared.value.executable,
                initialSnapshot: this.snapshots.read(record.id),
                record,
            });
            if (!this.database.getTerminal(record.id))
                throw new CaxriError('CONFLICT', 'Terminal was closed before launch completed');
            this.database.updateTerminalState(record.id, 'running');
            this.logger.write('info', ptyLogEvents.spawned, {
                durationMs: performance.now() - startedAt,
                fields: { terminalId: record.id, kind: record.kind },
            });
            return this.database.getTerminal(record.id)!;
        } catch (error) {
            this.cancelTitleListener(record.id);
            this.onShellRetired?.(record.id);
            this.execution.discard(record.id);
            try {
                const launchId = this.agentLaunches.get(record.id);
                this.agentLaunches.delete(record.id);
                if (launchId) this.settleAgentStart(record.id, launchId, false);
                await this.retireCoreLifecycle(record.id, launchId);
            } catch (retirementError) {
                this.logger.write('warn', ptyLogEvents.lifecycleRetireFailed, {
                    fields: {
                        terminalId: record.id,
                        error: errorMessage(retirementError, 'unknown'),
                    },
                });
            }
            if (this.database.getTerminal(record.id))
                this.database.updateTerminalState(
                    record.id,
                    'failed',
                    failureReason,
                    failureDetail,
                );
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

    private observeUserInput(terminalId: string, data: string): void {
        if (isTerminalProtocolResponse(data)) return;
        this.inputEpochs.set(terminalId, this.inputEpoch(terminalId) + 1);
        this.onInput?.(terminalId, data);
    }

    start(record: TerminalRecord, options?: TerminalStartOptions): Promise<TerminalRecord> {
        if (this.execution.processId(record.id) !== undefined)
            return Promise.resolve(this.database.getTerminal(record.id)!);
        return this.starts.run(record.id, () => this.spawn(record, options));
    }

    inputEpoch(terminalId: string): number {
        return this.inputEpochs.get(terminalId) ?? 0;
    }

    write(terminalId: string, data: string): boolean {
        this.observeUserInput(terminalId, data);
        return this.execution.write(terminalId, data);
    }

    writeAcknowledged(
        terminalId: string,
        data: string,
        abortSignal?: AbortSignal,
        encoding?: 'binary',
    ): Promise<boolean> {
        if (!encoding) this.observeUserInput(terminalId, data);
        return this.execution.writeAcknowledged(terminalId, data, abortSignal, encoding);
    }

    /**
     * Checks and accepts a generated Agent input in one synchronous Server Core turn. `onDelivered` reports the
     * Terminal Host's real answer for a Terminal with no Renderer attachment, whose write cannot be resolved inside
     * that turn. See `TerminalExecutionPort.writeAgentExact`.
     */
    writeAgentExact(
        terminalId: string,
        data: string,
        expectedAgentLaunchId: string,
        origin: 'human' | 'delegation' = 'human',
        onDelivered?: (wasAccepted: boolean) => void,
        encoding?: 'binary',
    ): boolean {
        if (origin === 'human' && !encoding) this.observeUserInput(terminalId, data);
        return this.execution.writeAgentExact(
            terminalId,
            data,
            expectedAgentLaunchId,
            onDelivered,
            encoding,
        );
    }

    /**
     * Delivers Core-authorized input to the current managed Agent even when its Terminal has no visible Renderer view.
     * Mobile attention replies can target a waiting background Session, while ordinary desktop input remains bound to
     * the current attachment.
     */
    writeAgent(terminalId: string, data: string, signal?: AbortSignal): Promise<boolean> {
        this.observeUserInput(terminalId, data);
        return this.execution.writeAgent(terminalId, data, signal);
    }

    submitAgentExact(
        terminalId: string,
        expectedSessionId: string,
        expectedAgentLaunchId: string,
        text: string,
        signal?: AbortSignal,
    ): Promise<'accepted' | 'rejected' | 'unknown'> {
        this.observeUserInput(terminalId, text);
        return this.execution.submitAgentExact(
            terminalId,
            expectedSessionId,
            expectedAgentLaunchId,
            text,
            signal,
        );
    }

    reconcileOutputRecoverySettings(): void {
        for (const terminal of this.database.listTerminals())
            this.execution.configureOutputRecovery(
                terminal.id,
                terminal.lastAgentProcessState === 'running' ? terminal.provider : undefined,
                terminal.lastAgentProcessState === 'running' && terminal.provider
                    ? this.agentOutputRecoverySettings?.(terminal.provider)
                    : undefined,
            );
    }

    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean {
        return this.execution.signalExact(terminalId, expectedProcessId, signal);
    }

    signalAgentExact(terminalId: string, expectedLaunchId: string, signal: string): boolean {
        return this.execution.signalAgentExact(terminalId, expectedLaunchId, signal);
    }

    resize(terminalId: string, cols: number, rows: number): boolean {
        const accepted = this.execution.resize(terminalId, cols, rows);
        if (accepted) this.viewSizes.set(terminalId, { cols, rows });
        return accepted;
    }

    dimensions(terminalId: string): { cols: number; rows: number } | undefined {
        return this.viewSizes.get(terminalId);
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
        /**
         * The execution boundary is asynchronous; retirement may remove the Terminal while attach is pending.
         */
        if (size && this.database.getTerminal(terminalId)) this.viewSizes.set(terminalId, size);
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

    async preview(terminalId: string): Promise<TerminalPreview> {
        return terminalPreview(this.execution, terminalId, !!this.database.getTerminal(terminalId));
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
        /**
         * Fence the managed Agent generation before Host cancellation can report its intentional SIGHUP as an
         * unexpected process failure. The late exit event is then ignored by its retired launch ID.
         */
        this.retireAgentLifecycleSoon(terminalId, 'interrupted', 'terminalRestart');
        const capture = await this.execution.restartBarrier(terminalId);
        if (capture) await this.snapshots.finalize(terminalId, Promise.resolve(capture));
        const launchAgent =
            options?.launchAgent ??
            (options?.resumeAgentSessionId !== undefined ||
                record.lastAgentProcessState !== 'stopped');
        this.database.updateTerminalState(terminalId, 'starting');
        if (launchAgent && record.kind !== 'shell')
            this.database.updateAgentProcessState(terminalId, 'starting');
        this.onStateChanged?.(terminalId, 'starting');
        const restarting = this.database.getTerminal(terminalId);
        if (!restarting) throw new CaxriError('CONFLICT', 'Terminal was closed while restarting');
        return this.start(restarting, { ...options, launchAgent });
    }

    /**
     * Parks a live Terminal without losing it: the PTY is killed behind the same barrier a restart uses, the final
     * screen is captured for the tab, and the durable record moves to `suspended` so selecting its Session restores the
     * process (resuming the bound Agent session) exactly like an app-shutdown interruption would. `detached` is the
     * user-driven variant: it survives Session selection and only an explicit `session.resume` relaunches it.
     */
    async suspend(
        terminalId: string,
        state: 'suspended' | 'detached' = 'suspended',
        cause?: TerminalLifecycleCause,
    ): Promise<TerminalRecord | undefined> {
        const record = this.database.getTerminal(terminalId);
        if (!record || this.execution.processId(terminalId) === undefined) return undefined;
        const resumesAgent = this.agentLaunches.has(terminalId);
        this.retireAgentLifecycleSoon(terminalId, state, cause);
        const capture = await this.execution.restartBarrier(terminalId);
        if (capture) await this.snapshots.finalize(terminalId, Promise.resolve(capture));
        this.database.updateTerminalState(terminalId, state);
        if (resumesAgent) this.database.updateAgentProcessState(terminalId, state);
        this.onStateChanged?.(terminalId, state);
        return this.database.getTerminal(terminalId);
    }

    close(terminalId: string): void {
        this.retireTerminalViewState(terminalId);
        /**
         * Retire unconditionally: closure is authoritative even before a process exists, and `retireAgentLifecycleSoon`
         * itself decides whether a pending launch still owes a receipt.
         */
        this.retireAgentLifecycleSoon(terminalId, 'stopped', 'terminalClosed');
        this.execution.close(terminalId);
        this.onStateChanged?.(terminalId, 'stopped');
        this.database.closeTerminal(terminalId);
    }

    reassignSession(terminalId: string, sessionId: string): void {
        this.execution.reassignSession(terminalId, sessionId);
    }

    terminateSession(sessionId: string): void {
        const terminalIds = this.database.listTerminals(sessionId).map(({ id }) => id);
        // Retire metadata-owned launches too: executable discovery may not have reserved a Host slot yet.
        for (const terminalId of terminalIds) {
            this.retireTerminalViewState(terminalId);
            this.retireAgentLifecycleSoon(terminalId, 'stopped', 'terminalClosed');
            this.onStateChanged?.(terminalId, 'stopped');
        }
        this.execution.terminateSession(sessionId, terminalIds);
    }

    runningCount(sessionId?: string): number {
        return this.execution.runningCount(sessionId);
    }

    processId(terminalId: string): number | undefined {
        return this.execution.processId(terminalId);
    }

    agentProcessId(terminalId: string): number | undefined {
        return this.execution.agentProcessId(terminalId);
    }

    agentLaunchId(terminalId: string): string | undefined {
        return this.execution.agentLaunchId(terminalId);
    }

    async waitForAgentRunning(terminalId: string, timeoutMs = 15_000): Promise<void> {
        const current = this.database.getTerminal(terminalId);
        if (
            current?.lastAgentProcessState === 'running' &&
            this.execution.agentProcessId(terminalId) !== undefined
        )
            return;
        const waiter = this.agentStartWaiters.get(terminalId);
        if (!waiter) throw new CaxriError('UNAVAILABLE', 'Managed Agent did not start');
        let timeout: NodeJS.Timeout | undefined;
        const didStart = await Promise.race([
            waiter.promise,
            new Promise<false>((resolve) => {
                timeout = setTimeout(resolve, timeoutMs, false);
                timeout.unref();
            }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (!didStart) throw new CaxriError('UNAVAILABLE', 'Managed Agent did not start');
    }

    resources(terminalId: string): Promise<TerminalResourceUsage | null> {
        return this.execution.resources(terminalId);
    }

    async shutdown(reason: Exclude<ShutdownReason, 'unclean'>): Promise<void> {
        const terminalProcessState = shutdownOutcome(reason).terminalProcessState;
        const finalizations = await this.execution.shutdown();
        for (const { terminalId } of finalizations)
            this.retireAgentLifecycleSoon(terminalId, terminalProcessState, 'serverShutdown');
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
