import { Buffer } from 'node:buffer';

import * as pty from 'node-pty';

import { agentProviderCatalog } from '../../shared/agents';
import { CaxriError, errorMessage, toWireError } from '../../shared/ipc/errors';
import type { RuntimeEvent } from '../../shared/ipc/events';
import {
    assertE2EAgentInput,
    assertE2EAgentLaunch,
    assertE2EShellLaunch,
    readE2EAgentPolicy,
} from '../../shared/node/e2e-agent-policy';
import type { StructuredLogger } from '../../shared/node/logger';
import type {
    TerminalFailureReason,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
} from '../../shared/types';
import type { CaxriDatabase } from '../db';
import { runtimeProcessEnvironment } from '../executables';
import type { ShutdownReason } from '../session-policy';
import { shutdownOutcome } from '../session-policy';
import { SingleFlight } from '../single-flight';
import { attachLogFields } from './attach-log';
import { TerminalOutputQueue } from './buffer';
import { oscColorReply, TerminalColorQueryResponder } from './color-query';
import { TerminalImageOutputFilter, TerminalImageRecoveryFilter } from './image-recovery';
import { assertTerminalWorkingDirectory, resolveTerminalExecutable } from './launch';
import type {
    AttachedSizeWaiter,
    LiveTerminal,
    TerminalGridSize,
    TerminalManagerOptions,
    TerminalStartOptions,
} from './manager-types';
import type { AgentOutputRecovery } from './output-recovery';
import { ensureLiveOutputRecovery, hasConfiguredOutputRecovery } from './output-recovery-manager';
import { sampleTerminalResources } from './resources';
import { TerminalScreenState } from './screen';
import {
    CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION,
    TerminalSnapshotPersistence,
} from './snapshot-persistence';
import { terminalEnvironment } from './terminal-environment';
import { createTerminalTitleListener } from './terminal-title';

const MAX_OUTPUT_BATCH_BYTES = 256 * 1024;

/**
 * Clears a possibly-unset timer and returns the `undefined` it should be replaced with.
 */
function clearScheduledTimer(timer: NodeJS.Timeout | undefined): undefined {
    if (timer) clearTimeout(timer);
    return;
}

export class TerminalManager {
    private readonly terminals = new Map<string, LiveTerminal>();
    private readonly attached = new Set<string>();
    private readonly attachedSizes = new Map<string, TerminalGridSize>();
    private readonly attachedSizeWaiters = new Map<string, Set<AttachedSizeWaiter>>();
    private readonly snapshots: TerminalSnapshotPersistence;
    private readonly starts = new SingleFlight<string, TerminalRecord>();
    private readonly resolveExecutableOverride?: TerminalManagerOptions['resolveExecutable'];
    private readonly agentLaunchSettings?: TerminalManagerOptions['agentLaunchSettings'];
    private readonly agentOutputRecoverySettings?: TerminalManagerOptions['agentOutputRecoverySettings'];
    private hasConfiguredOutputRecovery = false;
    private readonly agentEnvironment: () => Promise<NodeJS.ProcessEnv>;
    private readonly lifecycleEnvironment?: TerminalManagerOptions['lifecycleEnvironment'];
    private readonly onLifecycleStarted?: TerminalManagerOptions['onLifecycleStarted'];
    private readonly onLifecycleRetired?: TerminalManagerOptions['onLifecycleRetired'];
    private readonly onOutputActivity?: TerminalManagerOptions['onOutputActivity'];
    private readonly onStateChanged?: TerminalManagerOptions['onStateChanged'];
    private readonly spawnProcess: typeof pty.spawn;
    private readonly sampleResources: (pid: number) => Promise<TerminalResourceUsage | null>;
    private readonly shellIntegration?: TerminalManagerOptions['shellIntegration'];
    private readonly terminalColors?: TerminalManagerOptions['terminalColors'];

    constructor(
        private readonly database: CaxriDatabase,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger: StructuredLogger,
        options: TerminalManagerOptions = {},
    ) {
        this.resolveExecutableOverride = options.resolveExecutable;
        this.agentLaunchSettings = options.agentLaunchSettings;
        this.agentOutputRecoverySettings = options.agentOutputRecoverySettings;
        this.refreshOutputRecoveryAvailability();
        this.agentEnvironment = options.agentEnvironment ?? runtimeProcessEnvironment;
        this.lifecycleEnvironment = options.lifecycleEnvironment;
        this.onLifecycleStarted = options.onLifecycleStarted;
        this.onLifecycleRetired = options.onLifecycleRetired;
        this.onOutputActivity = options.onOutputActivity;
        this.onStateChanged = options.onStateChanged;
        this.snapshots = new TerminalSnapshotPersistence(database, logger);
        this.spawnProcess = options.spawn ?? pty.spawn;
        this.sampleResources = options.sampleResources ?? sampleTerminalResources;
        this.shellIntegration = options.shellIntegration;
        this.terminalColors = options.terminalColors;
    }

    private async spawn(
        record: TerminalRecord,
        options?: TerminalStartOptions,
    ): Promise<TerminalRecord> {
        const startedAt = performance.now();
        /**
         * Tracks which spawn stage is in flight so the `catch` below can attach a precise `TerminalFailureReason`
         * instead of pattern-matching the thrown error's message. Defaults to the last stage (`spawn_failed`) since a
         * `pty.spawn` failure has no distinct guard.
         */
        let failureReason: TerminalFailureReason = 'spawn_failed';
        let spawned: pty.IPty | undefined;
        let live: LiveTerminal | undefined;
        try {
            const pendingSnapshot = this.snapshots.pending(record.id);
            if (pendingSnapshot) await pendingSnapshot;
            if (!this.database.getTerminal(record.id))
                throw new CaxriError('CONFLICT', 'Terminal was closed before launch completed');
            const e2eAgentPolicy = readE2EAgentPolicy();
            const launch =
                record.kind === 'shell'
                    ? undefined
                    : (this.agentLaunchSettings?.(record.kind) ?? {
                          executable: agentProviderCatalog[record.kind].executableName,
                          args: [],
                      });
            if (record.kind === 'shell') assertE2EShellLaunch(e2eAgentPolicy);
            else
                assertE2EAgentLaunch(
                    e2eAgentPolicy,
                    record.kind,
                    launch!,
                    options?.resumeAgentSessionId,
                );
            failureReason = 'executable_not_found';
            const executable = await resolveTerminalExecutable(
                record.kind,
                launch,
                this.resolveExecutableOverride,
            );
            let arguments_ = record.kind === 'shell' ? ['-l'] : [...launch!.args];
            if (record.kind !== 'shell' && options?.resumeAgentSessionId) {
                arguments_.push(
                    ...agentProviderCatalog[record.kind].resumeArguments(
                        options.resumeAgentSessionId,
                    ),
                );
            }
            if (options?.waitForAttachedSizeMs)
                await this.waitForAttachedSize(
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
            failureReason = 'working_directory_unavailable';
            await assertTerminalWorkingDirectory(record.cwd, options?.expectedWorkingDirectory);
            failureReason = 'spawn_failed';
            let environment = {
                ...(record.kind === 'shell'
                    ? terminalEnvironment()
                    : {
                          ...(await this.agentEnvironment()),
                          TERM: 'xterm-256color',
                          COLORTERM: 'truecolor',
                      }),
                ...(await this.lifecycleEnvironment?.(record, launch)),
            };
            if (record.kind === 'shell') {
                try {
                    const integrated = this.shellIntegration?.(executable, environment);
                    if (integrated) {
                        arguments_ = integrated.args;
                        environment = integrated.environment;
                    }
                } catch (error) {
                    /**
                     * Shell integration is optional decoration metadata; startup must retain the ordinary login-shell
                     * path if its resolver becomes unavailable.
                     */
                    this.logger.write('warn', 'pty.shell_integration_unavailable', {
                        fields: {
                            terminalId: record.id,
                            error: errorMessage(error, 'unknown'),
                        },
                    });
                }
            }
            const initialSnapshot = this.snapshots.read(record.id)?.payload ?? '';
            const initialSize = this.attachedSizes.get(record.id) ?? { cols: 100, rows: 30 };
            const child = this.spawnProcess(executable, arguments_, {
                name: 'xterm-256color',
                cols: initialSize.cols,
                rows: initialSize.rows,
                cwd: record.cwd,
                env: environment,
            });
            spawned = child;
            /**
             * A close or Session deletion can complete while Agent CLI discovery is awaiting the login shell.
             */
            if (!this.database.getTerminal(record.id)) {
                throw new CaxriError('CONFLICT', 'Terminal was closed before launch completed');
            }
            const colorQuery = this.terminalColors
                ? new TerminalColorQueryResponder((slot, terminator) => {
                      const colors = this.terminalColors?.();
                      if (!colors) return;
                      const reply = oscColorReply(
                          slot,
                          slot === 10 ? colors.foreground : colors.background,
                          terminator,
                      );
                      /**
                       * Protocol replies are Runtime-internal, so they bypass `write()`'s E2E agent-input policy; the
                       * liveness check drops a reply that raced retire.
                       */
                      if (!reply || this.terminals.get(record.id)?.process !== child) return;
                      child.write(reply);
                  })
                : undefined;
            const startedLive: LiveTerminal = {
                colorQuery,
                imageRecovery: new TerminalImageRecoveryFilter(),
                imageOutput: new TerminalImageOutputFilter(),
                process: child,
                record,
                screen: new TerminalScreenState(
                    initialSnapshot,
                    initialSize.cols,
                    initialSize.rows,
                    {
                        onOverflow: (droppedBytes) =>
                            this.logger.write('warn', 'pty.screen_backpressure', {
                                fields: { terminalId: record.id, droppedBytes },
                            }),
                        onTitleChange: createTerminalTitleListener(
                            record.id,
                            this.database,
                            this.emit,
                        ),
                    },
                ),
                outputQueue: new TerminalOutputQueue(MAX_OUTPUT_BATCH_BYTES),
                droppedBytes: 0,
                metricOutputBytes: 0,
                metricInputBytes: 0,
                metricDroppedBytes: 0,
            };
            live = startedLive;
            this.terminals.set(record.id, startedLive);
            this.database.updateTerminalState(record.id, 'running');
            child.onData((data) => this.onData(startedLive, data));
            child.onExit(async ({ exitCode, signal }) => {
                await this.onExit(startedLive, exitCode, signal);
            });
            await this.onLifecycleStarted?.(record);
            this.logger.write('info', 'pty.spawned', {
                durationMs: performance.now() - startedAt,
                fields: { terminalId: record.id, kind: record.kind },
            });
            return this.database.getTerminal(record.id)!;
        } catch (error) {
            const wire = toWireError(error);
            if (live && this.terminals.get(record.id) === live) {
                this.terminals.delete(record.id);
                this.attached.delete(record.id);
                this.attachedSizes.delete(record.id);
                live.outputRecovery?.dispose();
                live.screen.dispose();
            }
            if (spawned) spawned.kill();
            try {
                await this.retireLifecycle(record.id);
            } catch (retirementError) {
                this.logger.write('warn', 'pty.lifecycle_retire_failed', {
                    fields: {
                        terminalId: record.id,
                        error: errorMessage(retirementError, 'unknown'),
                    },
                });
            }
            if (this.database.getTerminal(record.id))
                this.database.updateTerminalState(record.id, 'failed', failureReason);
            this.logger.write('error', 'pty.spawn_failed', {
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

    private onData(live: LiveTerminal, data: string): void {
        if (this.terminals.get(live.record.id) !== live) return;
        live.activityTimer ??= setTimeout(() => {
            live.activityTimer = undefined;
            if (this.terminals.get(live.record.id) === live)
                this.onOutputActivity?.(live.record.id, live.process.pid);
        }, 16);
        const dataBytes = Buffer.byteLength(data, 'utf8');
        live.metricOutputBytes += dataBytes;
        /**
         * Color queries are answered here and never reach the screen, snapshot, or Renderer — a replayed query would
         * otherwise make xterm.js send a duplicate, late reply.
         */
        const filtered = live.colorQuery ? live.colorQuery.push(data) : data;
        const recoveryData = live.imageRecovery.push(filtered);
        live.screen.write(recoveryData);
        if (this.hasConfiguredOutputRecovery) this.ensureOutputRecovery(live)?.observeOutput();
        if (this.attached.has(live.record.id)) {
            const droppedBytes = live.imageOutput.push(filtered, live.outputQueue);
            live.droppedBytes += droppedBytes;
            live.metricDroppedBytes += droppedBytes;
            live.outputTimer ??= setTimeout(() => this.flushOutput(live), 16);
        }
        live.metricTimer ??= setTimeout(() => this.flushMetrics(live), 1_000);
    }

    private ensureOutputRecovery(live: LiveTerminal): AgentOutputRecovery | undefined {
        return ensureLiveOutputRecovery(live, {
            emit: this.emit,
            getSettings: this.agentOutputRecoverySettings,
            isCurrent: () => this.terminals.get(live.record.id) === live,
            logger: this.logger,
            provider: this.database.getTerminal(live.record.id)?.provider,
            write: (data) => this.writeLive(live, live.outputRecoveryProvider, data),
        });
    }

    private refreshOutputRecoveryAvailability(): void {
        this.hasConfiguredOutputRecovery = hasConfiguredOutputRecovery(
            this.agentOutputRecoverySettings,
        );
    }

    private flushOutput(live: LiveTerminal): void {
        live.outputTimer = undefined;
        if (live.outputQueue.byteCount === 0 && live.droppedBytes === 0) return;
        this.emit({
            event: 'terminal.output',
            payload: {
                terminalId: live.record.id,
                data: live.outputQueue.drain(),
                droppedBytes: live.droppedBytes || undefined,
            },
        });
        live.droppedBytes = 0;
    }

    private flushMetrics(live: LiveTerminal): void {
        live.metricTimer = undefined;
        if (
            live.metricInputBytes === 0 &&
            live.metricOutputBytes === 0 &&
            live.metricDroppedBytes === 0
        )
            return;
        this.logger.write(live.metricDroppedBytes > 0 ? 'warn' : 'info', 'pty.throughput', {
            fields: {
                terminalId: live.record.id,
                inputBytes: live.metricInputBytes,
                outputBytes: live.metricOutputBytes,
                droppedBytes: live.metricDroppedBytes,
            },
        });
        live.metricInputBytes = 0;
        live.metricOutputBytes = 0;
        live.metricDroppedBytes = 0;
    }

    private async onExit(live: LiveTerminal, exitCode: number, signal?: number): Promise<void> {
        try {
            /**
             * Report the stopped state only after the parsed screen has become durable. An attach triggered by that
             * report can therefore never observe the older raw encoding or race the final parser barrier.
             */
            const finalization = this.retireLiveTerminal(live, { shouldPersist: true });
            if (!finalization) return;
            await finalization;
            if (!this.database.getTerminal(live.record.id)) return;
            /**
             * Node-pty can report exit code zero alongside a terminating signal; the signal still means an unexpected
             * death.
             */
            const isExitedNormally = exitCode === 0 && !signal;
            this.database.updateTerminalState(
                live.record.id,
                isExitedNormally ? 'stopped' : 'dead',
            );
            this.onStateChanged?.(live.record.id, isExitedNormally ? 'stopped' : 'dead');
            this.emit({
                event: 'terminal.exit',
                payload: { terminalId: live.record.id, exitCode, signal },
            });
            this.emit({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: [live.record.id] },
            });
            this.logger.write('info', 'pty.exited', {
                fields: { terminalId: live.record.id, exitCode, signal: signal ?? null },
            });
        } catch (error) {
            this.logger.write('warn', 'pty.exit_finalize_failed', {
                fields: { terminalId: live.record.id, error: errorMessage(error, 'unknown') },
            });
        }
    }

    private waitForAttachedSize(
        terminalId: string,
        timeoutMs: number,
        abortSignal?: AbortSignal,
    ): Promise<void> {
        if (this.attachedSizes.has(terminalId) || timeoutMs <= 0 || abortSignal?.aborted)
            return Promise.resolve();
        return new Promise((resolve) => {
            let isCompleted = false;
            /**
             * `setTimeout`'s callback must clear its own timer handle, and `clearTimeout` needs that handle before
             * `setTimeout` returns it. A boxed reference (rather than a forward-declared `let`) resolves the mutual
             * dependency without a reassigned binding.
             */
            const timerBox: { current?: NodeJS.Timeout } = {};
            const complete = (): void => {
                if (isCompleted) return;
                isCompleted = true;
                clearTimeout(timerBox.current);
                abortSignal?.removeEventListener('abort', complete);
                const waiters = this.attachedSizeWaiters.get(terminalId);
                waiters?.delete(complete);
                if (waiters?.size === 0) this.attachedSizeWaiters.delete(terminalId);
                resolve();
            };
            const waiters = this.attachedSizeWaiters.get(terminalId) ?? new Set();
            waiters.add(complete);
            this.attachedSizeWaiters.set(terminalId, waiters);
            timerBox.current = setTimeout(complete, timeoutMs);
            abortSignal?.addEventListener('abort', complete, { once: true });
        });
    }

    private resolveAttachedSizeWaiters(terminalId: string): void {
        const waiters = this.attachedSizeWaiters.get(terminalId);
        if (!waiters) return;
        for (const complete of waiters) complete();
    }

    /**
     * Stops tracking a live PTY: clears its timers, flushes queued output and metrics, and optionally persists a final
     * parsed screen snapshot. Exit, restart, and Runtime shutdown preserve it; close and Session deletion discard it.
     * Returns no finalization when the Terminal was already retired or history is deliberately discarded.
     */
    private retireLiveTerminal(live: LiveTerminal, options: { shouldPersist: false }): undefined;
    private retireLiveTerminal(
        live: LiveTerminal,
        options: { shouldPersist: true },
    ): Promise<void> | undefined;
    private retireLiveTerminal(
        live: LiveTerminal,
        options: { shouldPersist: boolean },
    ): Promise<void> | undefined {
        if (this.terminals.get(live.record.id) !== live) return;
        this.clearTerminalTimers(live);
        live.outputRecovery?.dispose();
        /**
         * A view may still be attached at close/exit/restart, so pass the queue: an image still mid-capture becomes one
         * honest placeholder instead of a silent gap in the final output.
         */
        live.droppedBytes += live.imageOutput.finish(live.outputQueue);
        this.flushOutput(live);
        this.flushMetrics(live);
        if (options.shouldPersist) {
            const colorTail = live.colorQuery?.finish() ?? '';
            const recoveryTail = `${
                colorTail ? live.imageRecovery.push(colorTail) : ''
            }${live.imageRecovery.finish()}`;
            live.screen.write(recoveryTail);
        }
        this.terminals.delete(live.record.id);
        this.attached.delete(live.record.id);
        this.attachedSizes.delete(live.record.id);
        this.retireLifecycleSoon(live.record.id);
        if (!options.shouldPersist) {
            live.screen.dispose();
            return;
        }
        return this.snapshots.finalize(live);
    }

    private clearTerminalTimers(live: LiveTerminal): void {
        live.activityTimer = clearScheduledTimer(live.activityTimer);
        live.outputTimer = clearScheduledTimer(live.outputTimer);
        live.metricTimer = clearScheduledTimer(live.metricTimer);
    }

    /**
     * Ownership removal is also shared by synchronous close and Session-deletion paths, so lifecycle revocation stays
     * fire-and-forget and handles its own rejection instead of delaying screen finalization.
     */
    private retireLifecycleSoon(terminalId: string): void {
        // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget from a synchronous caller, see comment above
        this.retireLifecycle(terminalId).catch((error: unknown) =>
            this.logger.write('warn', 'pty.lifecycle_retire_failed', {
                fields: { terminalId, error: errorMessage(error, 'unknown') },
            }),
        );
    }

    /**
     * A pre-spawn failure awaits retirement so its prepared credential never outlives the failure.
     */
    private async retireLifecycle(terminalId: string): Promise<void> {
        await this.onLifecycleRetired?.(terminalId);
    }

    private writeLive(
        live: LiveTerminal,
        provider: TerminalRecord['provider'],
        data: string,
    ): boolean {
        if (this.terminals.get(live.record.id) !== live) return false;
        if (provider) assertE2EAgentInput(readE2EAgentPolicy(), provider);
        live.metricInputBytes += Buffer.byteLength(data, 'utf8');
        live.metricTimer ??= setTimeout(() => this.flushMetrics(live), 1_000);
        live.process.write(data);
        return true;
    }

    start(record: TerminalRecord, options?: TerminalStartOptions): Promise<TerminalRecord> {
        if (this.terminals.has(record.id))
            return Promise.resolve(this.database.getTerminal(record.id)!);
        return this.starts.run(record.id, () => this.spawn(record, options));
    }

    write(terminalId: string, data: string): boolean {
        const live = this.terminals.get(terminalId);
        /**
         * Input can already be queued across IPC when a PTY exits; dropping that stale input is an expected lifecycle
         * race.
         */
        if (!live) return false;
        live.outputRecovery?.observeUserInput();
        return this.writeLive(live, live.record.provider, data);
    }

    reconcileOutputRecoverySettings(): void {
        this.refreshOutputRecoveryAvailability();
        if (!this.hasConfiguredOutputRecovery) {
            for (const live of this.terminals.values()) {
                live.outputRecovery?.dispose();
                live.outputRecovery = undefined;
                live.outputRecoveryProvider = undefined;
            }
            return;
        }
        for (const live of this.terminals.values())
            this.ensureOutputRecovery(live)?.settingsChanged();
    }

    /**
     * Signals only the currently-owned PTY identity captured by the caller.
     */
    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean {
        const live = this.terminals.get(terminalId);
        if (!live || live.process.pid !== expectedProcessId) return false;
        live.process.kill(signal);
        return true;
    }

    resize(terminalId: string, cols: number, rows: number): boolean {
        const live = this.terminals.get(terminalId);
        /**
         * ResizeObserver callbacks may likewise arrive after the PTY has exited or its pane has detached.
         */
        if (!live) return false;
        /**
         * A remounted Renderer forgets its last grid; avoid turning that first measurement into a redundant SIGWINCH.
         */
        if (live.process.cols === cols && live.process.rows === rows) return true;
        live.screen.resize(cols, rows);
        live.process.resize(cols, rows);
        return true;
    }

    async attach(
        terminalId: string,
        size?: { cols: number; rows: number },
    ): Promise<TerminalSnapshot | null> {
        let live = this.terminals.get(terminalId);
        if (!live) {
            const pendingSnapshot = this.snapshots.pending(terminalId);
            if (pendingSnapshot) await pendingSnapshot;
            live = this.terminals.get(terminalId);
        }
        if (!live && !this.database.getTerminal(terminalId)) return null;
        /**
         * An interrupted Terminal may attach before its restore spawn. Retain the measured grid so the resumed TUI
         * starts at the visible geometry instead of the fallback 100x30 grid.
         */
        if (size) {
            this.attachedSizes.set(terminalId, size);
            this.resolveAttachedSizeWaiters(terminalId);
        }
        /**
         * Serialize at the receiving xterm's grid. Restoring addon-serialize output into another size can irreversibly
         * wrap cursor-addressed alternate-screen content.
         */
        if (live && size) this.resize(terminalId, size.cols, size.rows);
        const wasAttached = this.attached.has(terminalId);
        this.attached.add(terminalId);
        const logAttach = (source: 'live' | 'persisted', payloadBytes: number): void =>
            this.logger.write('info', 'pty.attach', {
                fields: attachLogFields({ payloadBytes, size, source, terminalId, wasAttached }),
            });
        if (!live) {
            const persisted = this.snapshots.read(terminalId);
            logAttach('persisted', persisted?.payload.length ?? 0);
            return persisted;
        }
        if (wasAttached) {
            /**
             * A repeated attach replays the parsed screen, so pending live bytes already included in that screen must
             * not also be delivered after the attachment response.
             */
            live.outputTimer = clearScheduledTimer(live.outputTimer);
            live.outputQueue.clear();
            live.droppedBytes = 0;
        }
        const snapshot = {
            terminalId,
            encodingVersion: CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION,
            ...(await live.screen.snapshot()),
            updatedAt: Date.now(),
        };
        logAttach('live', snapshot.payload.length);
        return snapshot;
    }

    async snapshot(terminalId: string): Promise<TerminalSnapshot | null> {
        let live = this.terminals.get(terminalId);
        if (!live) {
            const pendingSnapshot = this.snapshots.pending(terminalId);
            if (pendingSnapshot) await pendingSnapshot;
            live = this.terminals.get(terminalId);
        }
        if (live)
            return {
                terminalId,
                encodingVersion: CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION,
                ...(await live.screen.snapshot()),
                updatedAt: Date.now(),
            };
        if (!this.database.getTerminal(terminalId)) return null;
        return this.snapshots.read(terminalId);
    }

    detachView(terminalId: string): void {
        this.attached.delete(terminalId);
        this.attachedSizes.delete(terminalId);
        const live = this.terminals.get(terminalId);
        if (!live) return;
        live.outputTimer = clearScheduledTimer(live.outputTimer);
        live.outputQueue.clear();
        /**
         * No destination: no Renderer view remains attached to read a placeholder here.
         */
        live.imageOutput.finish();
        live.droppedBytes = 0;
    }

    detachAllViews(): void {
        for (const terminalId of this.attached) this.detachView(terminalId);
    }

    async restart(terminalId: string, options?: TerminalStartOptions): Promise<TerminalRecord> {
        const record = this.database.getTerminal(terminalId);
        if (!record) throw new CaxriError('NOT_FOUND', 'Terminal not found');
        const live = this.terminals.get(terminalId);
        const isPreserveAttachment = this.attached.has(terminalId);
        const preservedSize = this.attachedSizes.get(terminalId);
        if (live) {
            /**
             * Detach first so the old PTY's asynchronous exit cannot remove the replacement with the same durable ID.
             */
            const retiring = this.retireLiveTerminal(live, { shouldPersist: true });
            live.process.kill();
            await retiring;
        }
        if (isPreserveAttachment) this.attached.add(terminalId);
        if (preservedSize) this.attachedSizes.set(terminalId, preservedSize);
        this.database.updateTerminalState(terminalId, 'starting');
        this.onStateChanged?.(terminalId, 'starting');
        const restarting = this.database.getTerminal(terminalId);
        if (!restarting) throw new CaxriError('CONFLICT', 'Terminal was closed while restarting');
        return this.start(restarting, options);
    }

    close(terminalId: string): void {
        const live = this.terminals.get(terminalId);
        if (live) {
            /**
             * Remove ownership before metadata so late node-pty exit events cannot write through deleted foreign keys.
             */
            this.retireLiveTerminal(live, { shouldPersist: false });
            live.process.kill();
        }
        this.attached.delete(terminalId);
        this.attachedSizes.delete(terminalId);
        this.resolveAttachedSizeWaiters(terminalId);
        this.onStateChanged?.(terminalId, 'stopped');
        this.database.closeTerminal(terminalId);
    }

    /**
     * Updates the cached `LiveTerminal.record.sessionId` after `CaxriDatabase.moveTerminalToNewSession` moves the
     * durable row. Without this, `terminateSession`/`runningCount` (which filter this in-memory cache by
     * `record.sessionId`, not by re-reading the DB) would keep attributing the moved PTY to its old Session — closing
     * the old Session would then kill the still-live, already-moved Terminal's process. No-op when the Terminal has no
     * live PTY (e.g. was interrupted/stopped): the DB is already the source of truth in that case.
     */
    reassignSession(terminalId: string, sessionId: string): void {
        const live = this.terminals.get(terminalId);
        if (!live) return;
        live.record = { ...live.record, sessionId };
    }

    terminateSession(sessionId: string): void {
        for (const terminal of this.database.listTerminals(sessionId)) {
            this.attached.delete(terminal.id);
            this.attachedSizes.delete(terminal.id);
            this.resolveAttachedSizeWaiters(terminal.id);
            this.onStateChanged?.(terminal.id, 'stopped');
        }
        for (const live of this.terminals.values()) {
            if (live.record.sessionId !== sessionId) continue;
            this.retireLiveTerminal(live, { shouldPersist: false });
            live.process.kill();
        }
    }

    runningCount(sessionId?: string): number {
        if (!sessionId) return this.terminals.size;
        return this.terminals
            .values()
            .filter((terminal) => terminal.record.sessionId === sessionId)
            .toArray().length;
    }

    processId(terminalId: string): number | undefined {
        return this.terminals.get(terminalId)?.process.pid;
    }

    resources(terminalId: string): Promise<TerminalResourceUsage | null> {
        const pid = this.processId(terminalId);
        return pid === undefined ? Promise.resolve(null) : this.sampleResources(pid);
    }

    /**
     * Kills every live PTY (final snapshot persisted) and bulk-marks Terminals per `reason`. `unclean` is excluded:
     * that recovery path only ever runs from `openDatabase` on the next Runtime start, never from a live Runtime
     * shutting itself down.
     */
    async shutdown(reason: Exclude<ShutdownReason, 'unclean'>): Promise<void> {
        /**
         * Wake restore starts before their generation guard turns false so shutdown does not leave the Runtime alive
         * solely for the visible-Terminal grid grace period.
         */
        for (const terminalId of this.attachedSizeWaiters.keys())
            this.resolveAttachedSizeWaiters(terminalId);
        const terminalProcessState = shutdownOutcome(reason).terminalProcessState;
        const finalizations: Array<Promise<void>> = [];
        const terminalIds: string[] = [];
        for (const live of this.terminals.values()) {
            const finalization = this.retireLiveTerminal(live, { shouldPersist: true });
            if (finalization) finalizations.push(finalization);
            terminalIds.push(live.record.id);
            live.process.kill();
        }
        await Promise.all(finalizations);
        this.database.markShutdown(reason);
        for (const terminalId of terminalIds)
            this.onStateChanged?.(terminalId, terminalProcessState);
    }
}
