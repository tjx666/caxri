import { lstat, realpath } from 'node:fs/promises';

import * as pty from 'node-pty';

import {
    agentProviderCatalog,
    type AgentLaunchSettings,
    type AgentProvider,
} from '../../shared/agents';
import { CaxriError, errorMessage } from '../../shared/ipc/errors';
import type { RuntimeEvent } from '../../shared/ipc/events';
import type { StructuredLogger } from '../../shared/node/logger';
import { safeProcessEnvironment } from '../../shared/node/process-environment';
import type {
    TerminalFailureReason,
    TerminalKind,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
} from '../../shared/types';
import { discoverExecutable } from '../agents/discovery';
import { runtimeProcessEnvironment } from '../executables';
import type { CaxriDatabase } from '../db/repository';
import type { ShutdownReason } from '../session-policy';
import { SingleFlight } from '../single-flight';
import { TerminalOutputQueue, TerminalSnapshotBuffer } from './buffer';
import { sampleTerminalResources } from './resources';
import { TerminalScreenState } from './screen';

export { TerminalRestoreSupervisor } from './restore-supervisor';

const MAX_OUTPUT_BATCH_BYTES = 256 * 1024;
const SNAPSHOT_PERSIST_INTERVAL_MS = 5_000;

/** Clears a possibly-unset timer and returns the `undefined` it should be replaced with. */
function clearScheduledTimer(timer: NodeJS.Timeout | undefined): undefined {
    if (timer) clearTimeout(timer);
    return undefined;
}

export function terminalEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        ...safeProcessEnvironment(source),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
    };
    return environment;
}

interface LiveTerminal {
    process: pty.IPty;
    record: TerminalRecord;
    screen: TerminalScreenState;
    snapshot: TerminalSnapshotBuffer;
    outputQueue: TerminalOutputQueue;
    droppedBytes: number;
    metricOutputBytes: number;
    metricInputBytes: number;
    metricDroppedBytes: number;
    activityTimer?: NodeJS.Timeout;
    outputTimer?: NodeJS.Timeout;
    snapshotTimer?: NodeJS.Timeout;
    metricTimer?: NodeJS.Timeout;
}

export interface TerminalManagerOptions {
    resolveExecutable?: (
        kind: TerminalKind,
        launchSettings?: AgentLaunchSettings,
    ) => Promise<string>;
    agentLaunchSettings?: (provider: AgentProvider) => AgentLaunchSettings;
    agentEnvironment?: () => Promise<NodeJS.ProcessEnv>;
    /** Signals raw PTY activity even while no Renderer view is attached; consumers receive no content. */
    onOutputActivity?: (terminalId: string, processId: number) => void;
    snapshotIntervalMs?: number;
    spawn?: typeof pty.spawn;
    sampleResources?: (pid: number) => Promise<TerminalResourceUsage | null>;
}

export interface TerminalWorkingDirectoryIdentity {
    device: string;
    inode: string;
    path: string;
}

export interface TerminalStartOptions {
    expectedWorkingDirectory?: TerminalWorkingDirectoryIdentity;
    resumeAgentSessionId?: string;
    /** Restore generations use this to abandon stale discovery before it spawns a process. */
    shouldStart?: () => boolean;
}

export class TerminalManager {
    private readonly terminals = new Map<string, LiveTerminal>();
    private readonly attached = new Set<string>();
    private readonly starts = new SingleFlight<string, TerminalRecord>();
    private readonly resolveExecutableOverride?: TerminalManagerOptions['resolveExecutable'];
    private readonly agentLaunchSettings?: TerminalManagerOptions['agentLaunchSettings'];
    private readonly agentEnvironment: () => Promise<NodeJS.ProcessEnv>;
    private readonly onOutputActivity?: TerminalManagerOptions['onOutputActivity'];
    private readonly snapshotIntervalMs: number;
    private readonly spawnProcess: typeof pty.spawn;
    private readonly sampleResources: (pid: number) => Promise<TerminalResourceUsage | null>;

    constructor(
        private readonly database: CaxriDatabase,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger: StructuredLogger,
        options: TerminalManagerOptions = {},
    ) {
        this.resolveExecutableOverride = options.resolveExecutable;
        this.agentLaunchSettings = options.agentLaunchSettings;
        this.agentEnvironment = options.agentEnvironment ?? runtimeProcessEnvironment;
        this.onOutputActivity = options.onOutputActivity;
        this.snapshotIntervalMs = options.snapshotIntervalMs ?? SNAPSHOT_PERSIST_INTERVAL_MS;
        this.spawnProcess = options.spawn ?? pty.spawn;
        this.sampleResources = options.sampleResources ?? sampleTerminalResources;
    }

    start(record: TerminalRecord, options?: TerminalStartOptions): Promise<TerminalRecord> {
        if (this.terminals.has(record.id))
            return Promise.resolve(this.database.getTerminal(record.id)!);
        return this.starts.run(record.id, () => this.spawn(record, options));
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
        try {
            const launch =
                record.kind === 'shell'
                    ? undefined
                    : (this.agentLaunchSettings?.(record.kind) ?? {
                          executable: agentProviderCatalog[record.kind].executableName,
                          args: [],
                      });
            failureReason = 'executable_not_found';
            const executable = await this.resolveExecutable(record.kind, launch);
            const args = record.kind === 'shell' ? ['-l'] : [...launch!.args];
            if (record.kind !== 'shell' && options?.resumeAgentSessionId) {
                args.push(
                    ...agentProviderCatalog[record.kind].resumeArguments(
                        options.resumeAgentSessionId,
                    ),
                );
            }
            const env =
                record.kind === 'shell'
                    ? terminalEnvironment()
                    : {
                          ...(await this.agentEnvironment()),
                          TERM: 'xterm-256color',
                          COLORTERM: 'truecolor',
                      };
            if (options?.shouldStart && !options.shouldStart()) {
                if (!this.database.getTerminal(record.id))
                    throw new CaxriError('CONFLICT', 'Terminal was closed before launch completed');
                this.database.updateTerminalState(record.id, 'interrupted');
                return this.database.getTerminal(record.id)!;
            }
            failureReason = 'working_directory_unavailable';
            await this.assertWorkingDirectory(record.cwd, options?.expectedWorkingDirectory);
            failureReason = 'spawn_failed';
            const initialSnapshot = this.database.getSnapshot(record.id)?.payload ?? '';
            const child = this.spawnProcess(executable, args, {
                name: 'xterm-256color',
                cols: 100,
                rows: 30,
                cwd: record.cwd,
                env,
            });
            /** A close or Session deletion can complete while Agent CLI discovery is awaiting the login shell. */
            if (!this.database.getTerminal(record.id)) {
                child.kill();
                throw new CaxriError('CONFLICT', 'Terminal was closed before launch completed');
            }
            const live: LiveTerminal = {
                process: child,
                record,
                screen: new TerminalScreenState(initialSnapshot, 100, 30, {
                    onOverflow: (droppedBytes) =>
                        this.logger.write('warn', 'pty.screen_backpressure', {
                            fields: { terminalId: record.id, droppedBytes },
                        }),
                }),
                snapshot: new TerminalSnapshotBuffer(initialSnapshot),
                outputQueue: new TerminalOutputQueue(MAX_OUTPUT_BATCH_BYTES),
                droppedBytes: 0,
                metricOutputBytes: 0,
                metricInputBytes: 0,
                metricDroppedBytes: 0,
            };
            this.terminals.set(record.id, live);
            this.database.updateTerminalState(record.id, 'running');
            child.onData((data) => this.onData(live, data));
            child.onExit(({ exitCode, signal }) => this.onExit(live, exitCode, signal));
            this.logger.write('info', 'pty.spawned', {
                durationMs: performance.now() - startedAt,
                fields: { terminalId: record.id, kind: record.kind },
            });
            return this.database.getTerminal(record.id)!;
        } catch (error) {
            if (this.database.getTerminal(record.id))
                this.database.updateTerminalState(record.id, 'failed', failureReason);
            this.logger.write('error', 'pty.spawn_failed', {
                durationMs: performance.now() - startedAt,
                fields: {
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

    /** Revalidates the authorized cwd immediately before the path-based node-pty spawn. */
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
        live.screen.write(data);
        live.snapshot.append(data);
        if (this.attached.has(live.record.id)) {
            const droppedBytes = live.outputQueue.appendBounded(data);
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
            /** Snapshot persistence is recoverable and must never terminate the shared Runtime. */
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
        /** onExit always persists the final snapshot; detach persists only when asked to preserve it. */
        if (!this.retireLiveTerminal(live, { persist: true })) return;
        /** node-pty can report exit code zero alongside a terminating signal; the signal still means an unexpected death. */
        const exitedNormally = exitCode === 0 && !signal;
        this.database.updateTerminalState(live.record.id, exitedNormally ? 'stopped' : 'dead');
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

    write(terminalId: string, data: string): boolean {
        const live = this.terminals.get(terminalId);
        /** Input can already be queued across IPC when a PTY exits; dropping that stale input is an expected lifecycle race. */
        if (!live) return false;
        live.metricInputBytes += Buffer.byteLength(data, 'utf8');
        live.metricTimer ??= setTimeout(() => this.flushMetrics(live), 1_000);
        live.process.write(data);
        return true;
    }

    resize(terminalId: string, cols: number, rows: number): boolean {
        const live = this.terminals.get(terminalId);
        /** ResizeObserver callbacks may likewise arrive after the PTY has exited or its pane has detached. */
        if (!live) return false;
        /** A remounted Renderer forgets its last grid; avoid turning that first measurement into a redundant SIGWINCH. */
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
        /** Serialize at the receiving xterm's grid. Restoring addon-serialize output into another
         *  size can irreversibly wrap cursor-addressed alternate-screen content. */
        if (live && size) this.resize(terminalId, size.cols, size.rows);
        const wasAttached = this.attached.has(terminalId);
        this.attached.add(terminalId);
        if (!live) return this.database.getSnapshot(terminalId) ?? null;
        if (wasAttached) {
            /** A repeated attach replays the parsed screen, so pending live bytes already included in
             *  that screen must not also be delivered after the attachment response. */
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
        const live = this.terminals.get(terminalId);
        if (!live) return;
        live.outputTimer = clearScheduledTimer(live.outputTimer);
        live.outputQueue.clear();
        live.droppedBytes = 0;
    }

    detachAllViews(): void {
        for (const terminalId of [...this.attached]) this.detachView(terminalId);
    }

    async restart(terminalId: string, options?: TerminalStartOptions): Promise<TerminalRecord> {
        const record = this.database.getTerminal(terminalId);
        if (!record) throw new CaxriError('NOT_FOUND', 'Terminal not found');
        const live = this.terminals.get(terminalId);
        const preserveAttachment = this.attached.has(terminalId);
        if (live) {
            /** Detach first so the old PTY's asynchronous exit cannot remove the replacement with the same durable ID. */
            this.detach(live, true);
            live.process.kill();
        }
        if (preserveAttachment) this.attached.add(terminalId);
        this.database.updateTerminalState(terminalId, 'starting');
        const restarting = this.database.getTerminal(terminalId);
        if (!restarting) throw new CaxriError('CONFLICT', 'Terminal was closed while restarting');
        return this.start(restarting, options);
    }

    private detach(live: LiveTerminal, persist: boolean): void {
        this.retireLiveTerminal(live, { persist });
    }

    /**
     * Stops tracking a live PTY: clears its timers, flushes queued output and metrics, and
     * optionally persists a final snapshot. Shared by `onExit` (always persists, then reports the
     * exit) and `detach` (persists only when the caller wants the snapshot preserved, e.g. restart).
     * Returns false when the terminal was already retired, which both callers treat as a no-op.
     */
    private retireLiveTerminal(live: LiveTerminal, options: { persist: boolean }): boolean {
        if (this.terminals.get(live.record.id) !== live) return false;
        this.clearTerminalTimers(live);
        this.flushOutput(live);
        this.flushMetrics(live);
        if (options.persist) this.persistSnapshot(live);
        this.terminals.delete(live.record.id);
        this.attached.delete(live.record.id);
        live.screen.dispose();
        return true;
    }

    private clearTerminalTimers(live: LiveTerminal): void {
        live.activityTimer = clearScheduledTimer(live.activityTimer);
        live.outputTimer = clearScheduledTimer(live.outputTimer);
        live.snapshotTimer = clearScheduledTimer(live.snapshotTimer);
        live.metricTimer = clearScheduledTimer(live.metricTimer);
    }

    close(terminalId: string): void {
        const live = this.terminals.get(terminalId);
        if (live) {
            /** Remove ownership before metadata so late node-pty exit events cannot write through deleted foreign keys. */
            this.detach(live, false);
            live.process.kill();
        }
        this.attached.delete(terminalId);
        this.database.closeTerminal(terminalId);
    }

    terminateSession(sessionId: string): void {
        for (const terminal of this.database.listTerminals(sessionId)) {
            this.attached.delete(terminal.id);
        }
        for (const live of [...this.terminals.values()]) {
            if (live.record.sessionId !== sessionId) continue;
            this.detach(live, false);
            live.process.kill();
        }
    }

    runningCount(sessionId?: string): number {
        if (!sessionId) return this.terminals.size;
        return [...this.terminals.values()].filter(
            (terminal) => terminal.record.sessionId === sessionId,
        ).length;
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
        for (const live of [...this.terminals.values()]) {
            this.detach(live, true);
            live.process.kill();
        }
        this.database.markShutdown(reason);
    }
}
