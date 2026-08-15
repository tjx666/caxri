import { Buffer } from 'node:buffer';
import { lstat, realpath } from 'node:fs/promises';
import process from 'node:process';

import * as pty from 'node-pty';

import type { AgentLaunchSettings } from '../../shared/agents';
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
import { safeProcessEnvironment } from '../../shared/node/process-environment';
import type {
    TerminalFailureReason,
    TerminalKind,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
} from '../../shared/types';
import { discoverExecutable } from '../agents';
import type { CaxriDatabase } from '../db';
import { runtimeProcessEnvironment } from '../executables';
import type { ShutdownReason } from '../session-policy';
import { shutdownOutcome } from '../session-policy';
import { SingleFlight } from '../single-flight';
import { TerminalOutputQueue, TerminalSnapshotBuffer } from './buffer';
import { oscColorReply, TerminalColorQueryResponder } from './color-query';
import { TerminalImageOutputFilter, TerminalImageRecoveryFilter } from './image-recovery';
import type {
    AttachedSizeWaiter,
    LiveTerminal,
    TerminalGridSize,
    TerminalManagerOptions,
    TerminalStartOptions,
    TerminalWorkingDirectoryIdentity,
} from './manager-types';
import { sampleTerminalResources } from './resources';
import { TerminalScreenState } from './screen';

export type {
    TerminalManagerOptions,
    TerminalStartOptions,
    TerminalWorkingDirectoryIdentity,
} from './manager-types';
export { TerminalRestoreSupervisor } from './restore-supervisor';
export { ShellIntegrationService } from './shell-integration';

const MAX_OUTPUT_BATCH_BYTES = 256 * 1024;
const SNAPSHOT_PERSIST_INTERVAL_MS = 5_000;

/**
Clears a possibly-unset timer and returns the `undefined` it should be replaced with.
 */
function clearScheduledTimer(timer: NodeJS.Timeout | undefined): undefined {
    if (timer) clearTimeout(timer);
    return;
}

export function terminalEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        ...safeProcessEnvironment(source),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
    };
    return environment;
}

export class TerminalManager {
    private readonly terminals = new Map<string, LiveTerminal>();
    private readonly attached = new Set<string>();
    private readonly attachedSizes = new Map<string, TerminalGridSize>();
    private readonly attachedSizeWaiters = new Map<string, Set<AttachedSizeWaiter>>();
    private readonly starts = new SingleFlight<string, TerminalRecord>();
    private readonly resolveExecutableOverride?: TerminalManagerOptions['resolveExecutable'];
    private readonly agentLaunchSettings?: TerminalManagerOptions['agentLaunchSettings'];
    private readonly agentEnvironment: () => Promise<NodeJS.ProcessEnv>;
    private readonly lifecycleEnvironment?: TerminalManagerOptions['lifecycleEnvironment'];
    private readonly onLifecycleStarted?: TerminalManagerOptions['onLifecycleStarted'];
    private readonly onLifecycleRetired?: TerminalManagerOptions['onLifecycleRetired'];
    private readonly onOutputActivity?: TerminalManagerOptions['onOutputActivity'];
    private readonly onStateChanged?: TerminalManagerOptions['onStateChanged'];
    private readonly snapshotMaximumBytes?: number;
    private readonly snapshotIntervalMs: number;
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
        this.agentEnvironment = options.agentEnvironment ?? runtimeProcessEnvironment;
        this.lifecycleEnvironment = options.lifecycleEnvironment;
        this.onLifecycleStarted = options.onLifecycleStarted;
        this.onLifecycleRetired = options.onLifecycleRetired;
        this.onOutputActivity = options.onOutputActivity;
        this.onStateChanged = options.onStateChanged;
        this.snapshotMaximumBytes = options.snapshotMaximumBytes;
        this.snapshotIntervalMs = options.snapshotIntervalMs ?? SNAPSHOT_PERSIST_INTERVAL_MS;
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
         * Tracks which spawn stage is in flight so the `catch` below can attach a precise
         * `TerminalFailureReason` instead of pattern-matching the thrown error's message. Defaults
         * to the last stage (`spawn_failed`) since a `pty.spawn` failure has no distinct guard.
         */
        let failureReason: TerminalFailureReason = 'spawn_failed';
        let spawned: pty.IPty | undefined;
        let live: LiveTerminal | undefined;
        try {
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
            const executable = await this.resolveExecutable(record.kind, launch);
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
            await this.assertWorkingDirectory(record.cwd, options?.expectedWorkingDirectory);
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
                     * Shell integration is optional decoration metadata; startup must retain the
                     *  ordinary login-shell path if its resolver becomes unavailable.
                     */
                    this.logger.write('warn', 'pty.shell_integration_unavailable', {
                        fields: {
                            terminalId: record.id,
                            error: errorMessage(error, 'unknown'),
                        },
                    });
                }
            }
            const storedSnapshot = this.database.getSnapshot(record.id);
            /**
             * A persisted snapshot can still hold color-query bytes captured by an older build;
             *  replaying them would make the Renderer's xterm.js emit a stale, unsolicited reply
             *  into the new process, so they are stripped without answering.
             */
            const initialColorQuery = new TerminalColorQueryResponder(() => {});
            const strippedSnapshot = `${initialColorQuery.push(
                storedSnapshot?.payload ?? '',
            )}${initialColorQuery.finish()}`;
            const initialImageRecovery = new TerminalImageRecoveryFilter();
            const initialSnapshot = `${initialImageRecovery.push(
                strippedSnapshot,
            )}${initialImageRecovery.finish()}`;
            const snapshot = new TerminalSnapshotBuffer(initialSnapshot, this.snapshotMaximumBytes);
            if (storedSnapshot && initialSnapshot !== storedSnapshot.payload) {
                this.database.saveSnapshot({
                    terminalId: record.id,
                    encodingVersion: 1,
                    ...snapshot.read(),
                    updatedAt: Date.now(),
                });
            }
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
            A close or Session deletion can complete while Agent CLI discovery is awaiting the login shell.
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
                       * Protocol replies are Runtime-internal, so they bypass `write()`'s E2E
                       *  agent-input policy; the liveness check drops a reply that raced retire.
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
                    },
                ),
                snapshot,
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
            child.onExit(({ exitCode, signal }) => this.onExit(startedLive, exitCode, signal));
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

    private async resolveExecutable(
        kind: TerminalKind,
        launchSettings?: AgentLaunchSettings,
    ): Promise<string> {
        if (this.resolveExecutableOverride)
            return this.resolveExecutableOverride(kind, launchSettings);
        if (kind === 'shell') return process.env.SHELL || '/bin/zsh';
        const executable = await discoverExecutable(kind, launchSettings?.executable);
        if (!executable)
            throw new CaxriError(
                'UNAVAILABLE',
                `${agentProviderCatalog[kind].displayName} CLI was not found`,
            );
        return executable;
    }

    /**
    Revalidates the authorized cwd immediately before the path-based node-pty spawn.
     */
    private async assertWorkingDirectory(
        path: string,
        expected?: TerminalWorkingDirectoryIdentity,
    ): Promise<void> {
        const [canonical, stats] = await Promise.all([
            realpath(path),
            lstat(path, { bigint: true }),
        ]);
        if (
            stats.isSymbolicLink() ||
            !stats.isDirectory() ||
            (expected &&
                (canonical !== path ||
                    expected.path !== path ||
                    expected.device !== stats.dev.toString() ||
                    expected.inode !== stats.ino.toString()))
        )
            throw new CaxriError('CONFLICT', 'Terminal working directory changed before launch');
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
         * Color queries are answered here and never reach the screen, snapshot, or Renderer —
         *  a replayed query would otherwise make xterm.js send a duplicate, late reply.
         */
        const filtered = live.colorQuery ? live.colorQuery.push(data) : data;
        const recoveryData = live.imageRecovery.push(filtered);
        live.screen.write(recoveryData);
        live.snapshot.append(recoveryData);
        if (this.attached.has(live.record.id)) {
            const droppedBytes = live.imageOutput.push(filtered, live.outputQueue);
            live.droppedBytes += droppedBytes;
            live.metricDroppedBytes += droppedBytes;
            live.outputTimer ??= setTimeout(() => this.flushOutput(live), 16);
        }
        live.snapshotTimer ??= setTimeout(
            () => this.persistSnapshot(live),
            this.snapshotIntervalMs,
        );
        live.metricTimer ??= setTimeout(() => this.flushMetrics(live), 1_000);
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

    private persistSnapshot(live: LiveTerminal): void {
        live.snapshotTimer = undefined;
        if (!this.database.getTerminal(live.record.id)) return;
        if (!live.snapshot.hasUnpersistedChanges()) return;
        const bounded = live.snapshot.read();
        const snapshot: TerminalSnapshot = {
            terminalId: live.record.id,
            encodingVersion: 1,
            ...bounded,
            updatedAt: Date.now(),
        };
        try {
            this.database.saveSnapshot(snapshot);
            live.snapshot.markPersisted();
        } catch (error) {
            /**
            Snapshot persistence is recoverable and must never terminate the shared Runtime.
             */
            this.logger.write('warn', 'pty.snapshot_failed', {
                fields: {
                    terminalId: live.record.id,
                    error: errorMessage(error, 'unknown'),
                },
            });
        }
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

    private onExit(live: LiveTerminal, exitCode: number, signal?: number): void {
        /**
        onExit always persists the final snapshot; detach persists only when asked to preserve it.
         */
        if (!this.retireLiveTerminal(live, { shouldPersist: true })) return;
        /**
        node-pty can report exit code zero alongside a terminating signal; the signal still means an unexpected death.
         */
        const isExitedNormally = exitCode === 0 && !signal;
        this.database.updateTerminalState(live.record.id, isExitedNormally ? 'stopped' : 'dead');
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
             * `setTimeout`'s callback must clear its own timer handle, and `clearTimeout` needs
             *  that handle before `setTimeout` returns it. A boxed reference (rather than a
             *  forward-declared `let`) resolves the mutual dependency without a reassigned binding.
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

    private detach(live: LiveTerminal, shouldPersist: boolean): void {
        this.retireLiveTerminal(live, { shouldPersist });
    }

    /**
     * Stops tracking a live PTY: clears its timers, flushes queued output and metrics, and
     * optionally persists a final snapshot. Shared by `onExit` (always persists, then reports the
     * exit) and `detach` (persists only when the caller wants the snapshot preserved, e.g. restart).
     * Returns false when the terminal was already retired, which both callers treat as a no-op.
     */
    private retireLiveTerminal(live: LiveTerminal, options: { shouldPersist: boolean }): boolean {
        if (this.terminals.get(live.record.id) !== live) return false;
        this.clearTerminalTimers(live);
        /**
         * A view may still be attached at close/exit/restart, so pass the queue: an image still
         *  mid-capture becomes one honest placeholder instead of a silent gap in the final output.
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
            live.snapshot.append(recoveryTail);
            this.persistSnapshot(live);
        }
        this.terminals.delete(live.record.id);
        this.attached.delete(live.record.id);
        this.attachedSizes.delete(live.record.id);
        this.retireLifecycleSoon(live.record.id);
        live.screen.dispose();
        return true;
    }

    private clearTerminalTimers(live: LiveTerminal): void {
        live.activityTimer = clearScheduledTimer(live.activityTimer);
        live.outputTimer = clearScheduledTimer(live.outputTimer);
        live.snapshotTimer = clearScheduledTimer(live.snapshotTimer);
        live.metricTimer = clearScheduledTimer(live.metricTimer);
    }

    /**
     * Normal exit cannot await Host control; failures stay observable without retaining local
     * state. The caller (`retireLiveTerminal`, itself invoked from the synchronous node-pty
     * `onExit` handler and other sync methods) cannot become `async` without changing the PTY
     * event-listener contract, so the rejection is handled via `.catch()` instead of `await`.
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
    A pre-spawn failure awaits retirement so its prepared credential never outlives the failure.
     */
    private async retireLifecycle(terminalId: string): Promise<void> {
        await this.onLifecycleRetired?.(terminalId);
    }

    start(record: TerminalRecord, options?: TerminalStartOptions): Promise<TerminalRecord> {
        if (this.terminals.has(record.id))
            return Promise.resolve(this.database.getTerminal(record.id)!);
        return this.starts.run(record.id, () => this.spawn(record, options));
    }

    write(terminalId: string, data: string): boolean {
        const live = this.terminals.get(terminalId);
        /**
        Input can already be queued across IPC when a PTY exits; dropping that stale input is an expected lifecycle race.
         */
        if (!live) return false;
        if (live.record.kind !== 'shell')
            assertE2EAgentInput(readE2EAgentPolicy(), live.record.kind);
        live.metricInputBytes += Buffer.byteLength(data, 'utf8');
        live.metricTimer ??= setTimeout(() => this.flushMetrics(live), 1_000);
        live.process.write(data);
        return true;
    }

    /**
    Signals only the currently-owned PTY identity captured by the caller.
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
        ResizeObserver callbacks may likewise arrive after the PTY has exited or its pane has detached.
         */
        if (!live) return false;
        /**
        A remounted Renderer forgets its last grid; avoid turning that first measurement into a redundant SIGWINCH.
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
        const live = this.terminals.get(terminalId);
        if (!live && !this.database.getTerminal(terminalId)) return null;
        /**
         * An interrupted Terminal may attach before its restore spawn. Retain the measured grid so
         *  the resumed TUI starts at the visible geometry instead of the fallback 100x30 grid.
         */
        if (size) {
            this.attachedSizes.set(terminalId, size);
            this.resolveAttachedSizeWaiters(terminalId);
        }
        /**
         * Serialize at the receiving xterm's grid. Restoring addon-serialize output into another
         *  size can irreversibly wrap cursor-addressed alternate-screen content.
         */
        if (live && size) this.resize(terminalId, size.cols, size.rows);
        const wasAttached = this.attached.has(terminalId);
        this.attached.add(terminalId);
        if (!live) return this.database.getSnapshot(terminalId) ?? null;
        if (wasAttached) {
            /**
             * A repeated attach replays the parsed screen, so pending live bytes already included in
             *  that screen must not also be delivered after the attachment response.
             */
            live.outputTimer = clearScheduledTimer(live.outputTimer);
            live.outputQueue.clear();
            live.droppedBytes = 0;
        }
        return {
            terminalId,
            encodingVersion: 2,
            ...(await live.screen.snapshot()),
            updatedAt: Date.now(),
        };
    }

    detachView(terminalId: string): void {
        this.attached.delete(terminalId);
        this.attachedSizes.delete(terminalId);
        const live = this.terminals.get(terminalId);
        if (!live) return;
        live.outputTimer = clearScheduledTimer(live.outputTimer);
        live.outputQueue.clear();
        /**
        No destination: no Renderer view remains attached to read a placeholder here.
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
            Detach first so the old PTY's asynchronous exit cannot remove the replacement with the same durable ID.
             */
            this.detach(live, true);
            live.process.kill();
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
            Remove ownership before metadata so late node-pty exit events cannot write through deleted foreign keys.
             */
            this.detach(live, false);
            live.process.kill();
        }
        this.attached.delete(terminalId);
        this.attachedSizes.delete(terminalId);
        this.resolveAttachedSizeWaiters(terminalId);
        this.onStateChanged?.(terminalId, 'stopped');
        this.database.closeTerminal(terminalId);
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
            this.detach(live, false);
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
     * Kills every live PTY (final snapshot persisted) and bulk-marks Terminals per `reason`.
     * `unclean` is excluded: that recovery path only ever runs from `openDatabase` on the next
     * Runtime start, never from a live Runtime shutting itself down.
     */
    shutdown(reason: Exclude<ShutdownReason, 'unclean'>): void {
        /**
         * Wake restore starts before their generation guard turns false so shutdown does not leave
         *  the Runtime alive solely for the visible-Terminal grid grace period.
         */
        for (const terminalId of this.attachedSizeWaiters.keys())
            this.resolveAttachedSizeWaiters(terminalId);
        const terminalProcessState = shutdownOutcome(reason).terminalProcessState;
        for (const live of this.terminals.values()) {
            this.detach(live, true);
            live.process.kill();
            this.onStateChanged?.(live.record.id, terminalProcessState);
        }
        this.database.markShutdown(reason);
    }
}
