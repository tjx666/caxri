import { Buffer } from 'node:buffer';

import type {
    AgentOutputRecoverySettings,
    AgentProvider,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import {
    assertE2EAgentInput,
    clearScheduledTimer,
    logEventCatalog,
    readE2EAgentPolicy,
} from '@caxri/system';
import * as pty from 'node-pty';

import { attachLogFields } from './attach-log';
import { TerminalAttachments } from './attachments';
import { TerminalOutputQueue } from './buffer';
import { oscColorReply, TerminalColorQueryResponder } from './color-query';
import { TerminalImageOutputFilter, TerminalImageRecoveryFilter } from './image-recovery';
import type { AgentOutputRecovery } from './output-recovery';
import { ensureLiveOutputRecovery, hasConfiguredOutputRecovery } from './output-recovery-manager';
import { sampleTerminalResources } from './resources';
import { TerminalScreenState } from './screen';
import { captureTerminalSnapshot, CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION } from './snapshot';
import type { LiveTerminal } from './types';

const MAX_OUTPUT_BATCH_BYTES = 256 * 1024;
const ptyLogEvents = logEventCatalog.pty;

export type TerminalExecutionEvent =
    | {
          type: 'output';
          terminalId: string;
          data: string;
          droppedBytes?: number;
      }
    | {
          type: 'outputRecovery';
          terminalId: string;
          provider: AgentProvider;
          status: 'recovered' | 'rate-limited';
      }
    | { type: 'activity'; terminalId: string; processId: number }
    | { type: 'title'; terminalId: string; title: string };

export interface TerminalExecutionStart {
    args: string[];
    environment: NodeJS.ProcessEnv;
    executable: string;
    initialSnapshot: string;
    record: TerminalRecord;
}

export interface TerminalExecutionExit {
    capture: Promise<TerminalSnapshot>;
    exitCode: number;
    record: TerminalRecord;
    signal?: number;
}

export interface TerminalExecutionEngineOptions {
    agentOutputRecoverySettings?: (provider: AgentProvider) => AgentOutputRecoverySettings;
    currentProvider?: (terminalId: string) => AgentProvider | undefined;
    emit: (event: TerminalExecutionEvent) => void;
    logger: StructuredLogger;
    onExit: (event: TerminalExecutionExit) => void | Promise<void>;
    outputFlushMs?: number;
    sampleResources?: (pid: number) => Promise<TerminalResourceUsage | null>;
    spawn?: typeof pty.spawn;
    terminalColors?: () => { background: string; foreground: string };
}

/**
 * Owns volatile Terminal execution: PTY masters, screen/parser state, output buffers, attachments and resource probes.
 * Durable records, snapshots, Agent lifecycle and public event projection stay behind callbacks owned by Server Core.
 */
export class TerminalExecutionEngine {
    private readonly terminals = new Map<string, LiveTerminal>();
    private readonly attachments = new TerminalAttachments();
    private readonly outputFlushMs: number;
    private readonly sampleResources: (pid: number) => Promise<TerminalResourceUsage | null>;
    private readonly spawnProcess: typeof pty.spawn;
    private hasConfiguredOutputRecovery: boolean;

    constructor(private readonly options: TerminalExecutionEngineOptions) {
        this.outputFlushMs = options.outputFlushMs ?? 16;
        if (!Number.isSafeInteger(this.outputFlushMs) || this.outputFlushMs < 1)
            throw new RangeError('Terminal output flush delay must be a positive integer');
        this.spawnProcess = options.spawn ?? pty.spawn;
        this.sampleResources = options.sampleResources ?? sampleTerminalResources;
        this.hasConfiguredOutputRecovery = hasConfiguredOutputRecovery(
            options.agentOutputRecoverySettings,
        );
    }

    private onData(live: LiveTerminal, data: string): void {
        if (this.terminals.get(live.record.id) !== live) return;
        live.activityTimer ??= setTimeout(() => {
            live.activityTimer = undefined;
            if (this.terminals.get(live.record.id) === live)
                this.options.emit({
                    type: 'activity',
                    terminalId: live.record.id,
                    processId: live.process.pid,
                });
        }, 16);
        const dataBytes = Buffer.byteLength(data, 'utf8');
        live.metricOutputBytes += dataBytes;
        const filtered = live.colorQuery ? live.colorQuery.push(data) : data;
        const recoveryData = live.imageRecovery.push(filtered);
        live.screen.write(recoveryData);
        if (this.hasConfiguredOutputRecovery) this.ensureOutputRecovery(live)?.observeOutput();
        if (this.attachments.has(live.record.id)) {
            const droppedBytes = live.imageOutput.push(filtered, live.outputQueue);
            live.droppedBytes += droppedBytes;
            live.metricDroppedBytes += droppedBytes;
            live.outputTimer ??= setTimeout(() => this.flushOutput(live), this.outputFlushMs);
        }
        live.metricTimer ??= setTimeout(() => this.flushMetrics(live), 1_000);
    }

    private ensureOutputRecovery(live: LiveTerminal): AgentOutputRecovery | undefined {
        return ensureLiveOutputRecovery(live, {
            emit: (event) => {
                if (event.event !== 'terminal.outputRecovery') return;
                this.options.emit({ type: 'outputRecovery', ...event.payload });
            },
            getSettings: this.options.agentOutputRecoverySettings,
            isCurrent: () => this.terminals.get(live.record.id) === live,
            logger: this.options.logger,
            provider: this.options.currentProvider?.(live.record.id),
            write: (data) => this.writeLive(live, live.outputRecoveryProvider, data),
        });
    }

    private flushOutput(live: LiveTerminal): void {
        live.outputTimer = undefined;
        if (live.outputQueue.byteCount === 0 && live.droppedBytes === 0) return;
        this.options.emit({
            type: 'output',
            terminalId: live.record.id,
            data: live.outputQueue.drain(),
            ...(live.droppedBytes > 0 && { droppedBytes: live.droppedBytes }),
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
        this.options.logger.write(
            live.metricDroppedBytes > 0 ? 'warn' : 'info',
            ptyLogEvents.throughput,
            {
                fields: {
                    terminalId: live.record.id,
                    inputBytes: live.metricInputBytes,
                    outputBytes: live.metricOutputBytes,
                    droppedBytes: live.metricDroppedBytes,
                },
            },
        );
        live.metricInputBytes = 0;
        live.metricOutputBytes = 0;
        live.metricDroppedBytes = 0;
    }

    private async onExit(live: LiveTerminal, exitCode: number, signal?: number): Promise<void> {
        const capture = this.retire(live, true);
        if (!capture) return;
        await this.options.onExit({ capture, exitCode, record: live.record, signal });
    }

    private clearTimers(live: LiveTerminal): void {
        live.activityTimer = clearScheduledTimer(live.activityTimer);
        live.outputTimer = clearScheduledTimer(live.outputTimer);
        live.metricTimer = clearScheduledTimer(live.metricTimer);
    }

    private retire(live: LiveTerminal, shouldCapture: false): undefined;
    private retire(live: LiveTerminal, shouldCapture: true): Promise<TerminalSnapshot> | undefined;
    private retire(
        live: LiveTerminal,
        shouldCapture: boolean,
    ): Promise<TerminalSnapshot> | undefined {
        if (this.terminals.get(live.record.id) !== live) return;
        this.clearTimers(live);
        live.outputRecovery?.dispose();
        live.droppedBytes += live.imageOutput.finish(live.outputQueue);
        this.flushOutput(live);
        this.flushMetrics(live);
        if (shouldCapture) {
            const colorTail = live.colorQuery?.finish() ?? '';
            const recoveryTail = `${
                colorTail ? live.imageRecovery.push(colorTail) : ''
            }${live.imageRecovery.finish()}`;
            live.screen.write(recoveryTail);
        }
        this.terminals.delete(live.record.id);
        this.attachments.detach(live.record.id);
        if (!shouldCapture) {
            live.screen.dispose();
            return;
        }
        return captureTerminalSnapshot(live);
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

    waitForAttachedSize(
        terminalId: string,
        timeoutMs: number,
        abortSignal?: AbortSignal,
    ): Promise<void> {
        return this.attachments.waitForSize(terminalId, timeoutMs, abortSignal);
    }

    start(input: TerminalExecutionStart): number {
        const existing = this.terminals.get(input.record.id);
        if (existing) return existing.process.pid;
        const initialSize = this.attachments.size(input.record.id) ?? { cols: 100, rows: 30 };
        const child = this.spawnProcess(input.executable, input.args, {
            name: 'xterm-256color',
            cols: initialSize.cols,
            rows: initialSize.rows,
            cwd: input.record.cwd,
            env: input.environment,
        });
        const colorQuery = this.options.terminalColors
            ? new TerminalColorQueryResponder((slot, terminator) => {
                  const colors = this.options.terminalColors?.();
                  if (!colors) return;
                  const reply = oscColorReply(
                      slot,
                      slot === 10 ? colors.foreground : colors.background,
                      terminator,
                  );
                  if (!reply || this.terminals.get(input.record.id)?.process !== child) return;
                  child.write(reply);
              })
            : undefined;
        const live: LiveTerminal = {
            colorQuery,
            imageRecovery: new TerminalImageRecoveryFilter(),
            imageOutput: new TerminalImageOutputFilter(),
            process: child,
            record: input.record,
            screen: new TerminalScreenState(
                input.initialSnapshot,
                initialSize.cols,
                initialSize.rows,
                {
                    onOverflow: (droppedBytes) =>
                        this.options.logger.write('warn', ptyLogEvents.screenBackpressure, {
                            fields: { terminalId: input.record.id, droppedBytes },
                        }),
                    onTitleChange: Object.assign(
                        (title: string) =>
                            this.options.emit({
                                type: 'title',
                                terminalId: input.record.id,
                                title,
                            }),
                        { cancel: () => {} },
                    ),
                },
            ),
            outputQueue: new TerminalOutputQueue(MAX_OUTPUT_BATCH_BYTES),
            droppedBytes: 0,
            metricOutputBytes: 0,
            metricInputBytes: 0,
            metricDroppedBytes: 0,
        };
        this.terminals.set(input.record.id, live);
        child.onData((data) => this.onData(live, data));
        child.onExit(async ({ exitCode, signal }) => {
            try {
                await this.onExit(live, exitCode, signal);
            } catch (error) {
                this.options.logger.write('warn', ptyLogEvents.exitFinalizeFailed, {
                    fields: {
                        terminalId: live.record.id,
                        error: error instanceof Error ? error.message : String(error),
                    },
                });
            }
        });
        return child.pid;
    }

    discard(terminalId: string): void {
        const live = this.terminals.get(terminalId);
        if (!live) return;
        this.retire(live, false);
        live.process.kill();
    }

    write(terminalId: string, data: string): boolean {
        const live = this.terminals.get(terminalId);
        if (!live) return false;
        live.outputRecovery?.observeUserInput();
        return this.writeLive(live, live.record.provider, data);
    }

    reconcileOutputRecoverySettings(): void {
        this.hasConfiguredOutputRecovery = hasConfiguredOutputRecovery(
            this.options.agentOutputRecoverySettings,
        );
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

    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean {
        const live = this.terminals.get(terminalId);
        if (!live || live.process.pid !== expectedProcessId) return false;
        live.process.kill(signal);
        return true;
    }

    resize(terminalId: string, cols: number, rows: number): boolean {
        const live = this.terminals.get(terminalId);
        if (!live) return false;
        if (live.process.cols === cols && live.process.rows === rows) return true;
        live.screen.resize(cols, rows);
        live.process.resize(cols, rows);
        return true;
    }

    async attach(
        terminalId: string,
        size?: { cols: number; rows: number },
    ): Promise<{ snapshot: TerminalSnapshot | null; wasAttached: boolean }> {
        const live = this.terminals.get(terminalId);
        const { wasAttached } = this.attachments.attach(terminalId, size);
        if (live && size) this.resize(terminalId, size.cols, size.rows);
        if (!live) return { snapshot: null, wasAttached };
        if (wasAttached) {
            live.outputTimer = clearScheduledTimer(live.outputTimer);
            live.outputQueue.clear();
            live.droppedBytes = 0;
        }
        return {
            snapshot: {
                terminalId,
                encodingVersion: CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION,
                ...(await live.screen.snapshot()),
                updatedAt: Date.now(),
            },
            wasAttached,
        };
    }

    async snapshot(terminalId: string): Promise<TerminalSnapshot | null> {
        const live = this.terminals.get(terminalId);
        if (!live) return null;
        return {
            terminalId,
            encodingVersion: CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION,
            ...(await live.screen.snapshot()),
            updatedAt: Date.now(),
        };
    }

    detachView(terminalId: string): void {
        this.attachments.detach(terminalId);
        const live = this.terminals.get(terminalId);
        if (!live) return;
        live.outputTimer = clearScheduledTimer(live.outputTimer);
        live.outputQueue.clear();
        live.imageOutput.finish();
        live.droppedBytes = 0;
    }

    detachAllViews(): void {
        for (const terminalId of this.attachments.ids()) this.detachView(terminalId);
    }

    restartBarrier(terminalId: string): Promise<TerminalSnapshot> | undefined {
        const live = this.terminals.get(terminalId);
        const isPreserveAttachment = this.attachments.has(terminalId);
        const preservedSize = this.attachments.size(terminalId);
        if (live) {
            const capture = this.retire(live, true);
            live.process.kill();
            if (isPreserveAttachment) this.attachments.attach(terminalId, preservedSize);
            return capture;
        }
        if (isPreserveAttachment) this.attachments.attach(terminalId, preservedSize);
        return;
    }

    close(terminalId: string): void {
        this.discard(terminalId);
        this.attachments.remove(terminalId);
    }

    reassignSession(terminalId: string, sessionId: string): void {
        const live = this.terminals.get(terminalId);
        if (live) live.record = { ...live.record, sessionId };
    }

    terminateSession(sessionId: string, terminalIds: readonly string[]): string[] {
        for (const terminalId of terminalIds) this.attachments.remove(terminalId);
        const retired: string[] = [];
        for (const live of this.terminals.values()) {
            if (live.record.sessionId !== sessionId) continue;
            retired.push(live.record.id);
            this.discard(live.record.id);
        }
        return retired;
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

    shutdown(): Array<{ terminalId: string; capture: Promise<TerminalSnapshot> }> {
        this.attachments.wakeAll();
        const finalizations: Array<{ terminalId: string; capture: Promise<TerminalSnapshot> }> = [];
        for (const live of this.terminals.values()) {
            const capture = this.retire(live, true);
            if (capture) finalizations.push({ terminalId: live.record.id, capture });
            live.process.kill();
        }
        return finalizations;
    }

    logAttach(
        terminalId: string,
        size: { cols: number; rows: number } | undefined,
        wasAttached: boolean,
        source: 'live' | 'persisted',
        payloadBytes: number,
    ): void {
        this.options.logger.write('info', ptyLogEvents.attach, {
            fields: attachLogFields({ payloadBytes, size, source, terminalId, wasAttached }),
        });
    }
}
