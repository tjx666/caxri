import * as pty from 'node-pty';

import type { RuntimeEvent } from '../shared/contracts';
import type { StructuredLogger } from '../shared/node/logger';
import { safeProcessEnvironment } from '../shared/node/process-environment';
import type { TerminalKind, TerminalRecord, TerminalSnapshot } from '../shared/types';
import { discoverExecutable } from './agent';
import type { CaxriDatabase } from './database';
import { SingleFlight } from './single-flight';
import { TerminalOutputQueue, TerminalSnapshotBuffer } from './terminal-buffer';

const MAX_OUTPUT_BATCH_BYTES = 256 * 1024;

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
    snapshot: TerminalSnapshotBuffer;
    outputQueue: TerminalOutputQueue;
    droppedBytes: number;
    metricOutputBytes: number;
    metricInputBytes: number;
    metricDroppedBytes: number;
    outputTimer?: NodeJS.Timeout;
    snapshotTimer?: NodeJS.Timeout;
    metricTimer?: NodeJS.Timeout;
}

interface TerminalManagerOptions {
    resolveExecutable?: (kind: TerminalKind) => Promise<string>;
    spawn?: typeof pty.spawn;
}

export class TerminalManager {
    private readonly terminals = new Map<string, LiveTerminal>();
    private readonly attached = new Set<string>();
    private readonly starts = new SingleFlight<string, TerminalRecord>();
    private readonly resolveExecutableOverride?: TerminalManagerOptions['resolveExecutable'];
    private readonly spawnProcess: typeof pty.spawn;

    constructor(
        private readonly database: CaxriDatabase,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger: StructuredLogger,
        options: TerminalManagerOptions = {},
    ) {
        this.resolveExecutableOverride = options.resolveExecutable;
        this.spawnProcess = options.spawn ?? pty.spawn;
    }

    start(record: TerminalRecord): Promise<TerminalRecord> {
        if (this.terminals.has(record.id))
            return Promise.resolve(this.database.getTerminal(record.id)!);
        return this.starts.run(record.id, () => this.spawn(record));
    }

    private async spawn(record: TerminalRecord): Promise<TerminalRecord> {
        const startedAt = performance.now();
        try {
            const executable = await this.resolveExecutable(record.kind);
            const args = record.kind === 'shell' ? ['-l'] : [];
            const initialSnapshot = this.database.getSnapshot(record.id)?.payload ?? '';
            const child = this.spawnProcess(executable, args, {
                name: 'xterm-256color',
                cols: 100,
                rows: 30,
                cwd: record.cwd,
                env: terminalEnvironment(),
            });
            /** A close or Session deletion can complete while Agent CLI discovery is awaiting the login shell. */
            if (!this.database.getTerminal(record.id)) {
                child.kill();
                throw new Error('Terminal was closed before launch completed');
            }
            const live: LiveTerminal = {
                process: child,
                record,
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
                this.database.updateTerminalState(record.id, 'failed');
            this.logger.write('error', 'pty.spawn_failed', {
                durationMs: performance.now() - startedAt,
                fields: {
                    terminalId: record.id,
                    kind: record.kind,
                    error: error instanceof Error ? error.message : 'unknown',
                },
            });
            throw error;
        }
    }

    private async resolveExecutable(kind: TerminalKind): Promise<string> {
        if (this.resolveExecutableOverride) return this.resolveExecutableOverride(kind);
        if (kind === 'shell') return process.env.SHELL || '/bin/zsh';
        const executable = await discoverExecutable(kind);
        if (!executable)
            throw new Error(`${kind === 'claude' ? 'Claude Code' : 'Codex'} CLI was not found`);
        return executable;
    }

    private onData(live: LiveTerminal, data: string): void {
        if (this.terminals.get(live.record.id) !== live) return;
        const dataBytes = Buffer.byteLength(data, 'utf8');
        live.metricOutputBytes += dataBytes;
        live.snapshot.append(data);
        if (this.attached.has(live.record.id)) {
            const droppedBytes = live.outputQueue.appendBounded(data);
            live.droppedBytes += droppedBytes;
            live.metricDroppedBytes += droppedBytes;
            live.outputTimer ??= setTimeout(() => this.flushOutput(live), 16);
        }
        live.snapshotTimer ??= setTimeout(() => this.persistSnapshot(live), 750);
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
        const bounded = live.snapshot.read();
        const snapshot: TerminalSnapshot = {
            terminalId: live.record.id,
            encodingVersion: 1,
            ...bounded,
            updatedAt: Date.now(),
        };
        try {
            this.database.saveSnapshot(snapshot);
        } catch (error) {
            /** Snapshot persistence is recoverable and must never terminate the shared Runtime. */
            this.logger.write('warn', 'pty.snapshot_failed', {
                fields: {
                    terminalId: live.record.id,
                    error: error instanceof Error ? error.message : 'unknown',
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
        if (this.terminals.get(live.record.id) !== live) return;
        if (live.outputTimer) clearTimeout(live.outputTimer);
        if (live.snapshotTimer) clearTimeout(live.snapshotTimer);
        if (live.metricTimer) clearTimeout(live.metricTimer);
        live.outputTimer = undefined;
        live.snapshotTimer = undefined;
        live.metricTimer = undefined;
        this.flushOutput(live);
        this.persistSnapshot(live);
        this.flushMetrics(live);
        this.terminals.delete(live.record.id);
        this.attached.delete(live.record.id);
        /** node-pty can report exit code zero alongside a terminating signal; the signal still means an unexpected death. */
        const exitedNormally = exitCode === 0 && !signal;
        this.database.updateTerminalState(live.record.id, exitedNormally ? 'stopped' : 'dead');
        this.emit({
            event: 'terminal.exit',
            payload: { terminalId: live.record.id, exitCode, signal },
        });
        this.emit({ event: 'state.changed', payload: { reason: 'terminal.exit' } });
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
        live.process.resize(cols, rows);
        return true;
    }

    attach(terminalId: string): TerminalSnapshot | null {
        const live = this.terminals.get(terminalId);
        if (!live && !this.database.getTerminal(terminalId)) return null;
        this.attached.add(terminalId);
        if (!live) return this.database.getSnapshot(terminalId) ?? null;
        /** The snapshot already contains queued bytes, so discard that live batch before replay. */
        if (live.outputTimer) clearTimeout(live.outputTimer);
        live.outputTimer = undefined;
        live.outputQueue.clear();
        live.droppedBytes = 0;
        return {
            terminalId,
            encodingVersion: 1,
            ...live.snapshot.read(),
            updatedAt: Date.now(),
        };
    }

    detachView(terminalId: string): void {
        this.attached.delete(terminalId);
        const live = this.terminals.get(terminalId);
        if (!live) return;
        if (live.outputTimer) clearTimeout(live.outputTimer);
        live.outputTimer = undefined;
        live.outputQueue.clear();
        live.droppedBytes = 0;
    }

    detachAllViews(): void {
        for (const terminalId of [...this.attached]) this.detachView(terminalId);
    }

    async restart(terminalId: string): Promise<TerminalRecord> {
        const record = this.database.getTerminal(terminalId);
        if (!record) throw new Error('Terminal not found');
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
        if (!restarting) throw new Error('Terminal was closed while restarting');
        return this.start(restarting);
    }

    private detach(live: LiveTerminal, persist: boolean): void {
        if (this.terminals.get(live.record.id) !== live) return;
        if (live.outputTimer) clearTimeout(live.outputTimer);
        if (live.snapshotTimer) clearTimeout(live.snapshotTimer);
        if (live.metricTimer) clearTimeout(live.metricTimer);
        live.outputTimer = undefined;
        live.snapshotTimer = undefined;
        live.metricTimer = undefined;
        this.flushOutput(live);
        this.flushMetrics(live);
        if (persist) this.persistSnapshot(live);
        this.terminals.delete(live.record.id);
        this.attached.delete(live.record.id);
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

    shutdown(): void {
        for (const live of [...this.terminals.values()]) {
            this.detach(live, true);
            live.process.kill();
        }
        this.database.markAllStopped();
    }
}
