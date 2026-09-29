import { Buffer } from 'node:buffer';

import type {
    AgentOutputRecoverySettings,
    AgentProvider,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
    TerminalWheelInput,
} from '@caxri/protocol';
import { CaxriError, CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import {
    assertE2EAgentInput,
    clearScheduledTimer,
    logEventCatalog,
    readE2EAgentPolicy,
} from '@caxri/system';
import type * as pty from 'node-pty';

import {
    quiesceAgentInput,
    stopTerminalAfterInputQuiescence,
    writeAgentInputWithCompletion,
} from './agent-input';
import { attachLogFields } from './attach-log';
import { TerminalAttachments } from './attachments';
import { TerminalOutputQueue } from './buffer';
import { oscColorReply, TerminalColorQueryResponder } from './color-query';
import { TerminalImageOutputFilter, TerminalImageRecoveryFilter } from './image-recovery';
import type { PtyRetireReason } from './observability';
import {
    createPtyThroughputTally,
    PtyResizeBurstObserver,
    recordPtyDroppedBytes,
    recordPtyThroughputSummary,
    recordPtyThroughputWindow,
} from './observability';
import { flushObserverOutput } from './observer-output';
import { TerminalOutputFramer } from './output-framer';
import type { AgentOutputRecovery } from './output-recovery';
import { ensureLiveOutputRecovery, hasConfiguredOutputRecovery } from './output-recovery-manager';
import { sampleTerminalResources } from './resources';
import { TerminalScreenState } from './screen';
import { captureTerminalSnapshot } from './snapshot';
import type { LiveTerminal, TerminalExecutionEvent } from './types';

export type { TerminalExecutionEvent } from './types';

const MAX_OUTPUT_BATCH_BYTES = 256 * 1024;
const ptyLogEvents = logEventCatalog.pty;

export interface TerminalExecutionStart {
    args: string[];
    environment: NodeJS.ProcessEnv;
    executable: string;
    initialSize?: { cols: number; rows: number };
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
    observerOutputMaximumBytes?: number;
    sampleResources?: (pid: number) => Promise<TerminalResourceUsage | null>;
    screenMaximumQueuedBytes?: number;
    spawn: typeof pty.spawn;
    terminalColors?: (terminalId: string) => { background: string; foreground: string } | undefined;
}

/**
 * Owns volatile Terminal execution: PTY masters, screen/parser state, output buffers, attachments and resource probes.
 * Durable records, snapshots, Agent lifecycle and public event projection stay behind callbacks owned by Server Core.
 */
export class TerminalExecutionEngine {
    private readonly terminals = new Map<string, LiveTerminal>();
    private readonly quiescedInput = new Set<LiveTerminal>();
    private readonly attachments = new TerminalAttachments();
    private readonly sizeLeases = new Map<
        string,
        {
            holderId: string;
            live: LiveTerminal;
            previousSize: { cols: number; rows: number };
            expiresAt: number;
            timer?: ReturnType<typeof setTimeout>;
        }
    >();
    private readonly outputFlushMs: number;
    private readonly resizeObserver: PtyResizeBurstObserver;
    private readonly sampleResources: (pid: number) => Promise<TerminalResourceUsage | null>;
    private readonly spawnProcess: typeof pty.spawn;
    private hasConfiguredOutputRecovery: boolean;

    constructor(private readonly options: TerminalExecutionEngineOptions) {
        this.outputFlushMs = options.outputFlushMs ?? 16;
        if (!Number.isSafeInteger(this.outputFlushMs) || this.outputFlushMs < 1)
            throw new RangeError('Terminal output flush delay must be a positive integer');
        this.spawnProcess = options.spawn;
        this.sampleResources = options.sampleResources ?? sampleTerminalResources;
        this.resizeObserver = new PtyResizeBurstObserver(options.logger);
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
        const frames = live.outputFramer.push(filtered);
        live.screen.write(frames.map((frame) => live.imageRecovery.push(frame.data)).join(''));
        if (this.hasConfiguredOutputRecovery) this.ensureOutputRecovery(live)?.observeOutput();
        if (this.attachments.has(live.record.id) || live.observers.size > 0) {
            let droppedBytes = 0;
            for (const frame of frames) {
                if (this.attachments.has(live.record.id)) {
                    const destination = frame.isControl
                        ? {
                              appendAtomic: (data: string) => live.outputQueue.appendAtomic(data),
                              appendBounded: (data: string) => live.outputQueue.appendAtomic(data),
                          }
                        : live.outputQueue;
                    droppedBytes += live.imageOutput.push(frame.data, destination);
                }
                if (live.observers.size > 0 && !live.observerNeedsResync) {
                    const destination = frame.isControl
                        ? {
                              appendAtomic: (data: string) =>
                                  live.observerOutputQueue.appendAtomic(data),
                              appendBounded: (data: string) =>
                                  live.observerOutputQueue.appendAtomic(data),
                          }
                        : live.observerOutputQueue;
                    live.observerDroppedBytes += live.observerImageOutput.push(
                        frame.data,
                        destination,
                    );
                }
            }
            live.droppedBytes += droppedBytes;
            live.metricDroppedBytes += droppedBytes;
            if (live.observerDroppedBytes > 0) {
                live.observerOutputQueue.clear();
                live.observerNeedsResync = true;
                live.observerResyncReason = 'overflow';
            }
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
        this.flushObserverOutput(live);
        if (live.outputQueue.byteCount === 0 && live.droppedBytes === 0) return;
        this.options.emit({
            type: 'output',
            terminalId: live.record.id,
            data: live.outputQueue.drain(),
            ...(live.droppedBytes > 0 && { droppedBytes: live.droppedBytes }),
        });
        live.droppedBytes = 0;
    }

    private flushObserverOutput(live: LiveTerminal): void {
        flushObserverOutput(live, this.options.emit);
    }

    private flushMetrics(live: LiveTerminal): void {
        live.metricTimer = undefined;
        if (
            live.metricInputBytes === 0 &&
            live.metricOutputBytes === 0 &&
            live.metricDroppedBytes === 0
        )
            return;
        recordPtyThroughputWindow(this.options.logger, live.record.id, live.throughput, {
            inputBytes: live.metricInputBytes,
            outputBytes: live.metricOutputBytes,
            droppedBytes: live.metricDroppedBytes,
        });
        live.metricInputBytes = 0;
        live.metricOutputBytes = 0;
        live.metricDroppedBytes = 0;
    }

    private async onExit(live: LiveTerminal, exitCode: number, signal?: number): Promise<void> {
        const capture = this.retire(live, true, 'exited');
        if (!capture) return;
        await this.options.onExit({ capture, exitCode, record: live.record, signal });
    }

    private clearTimers(live: LiveTerminal): void {
        live.activityTimer = clearScheduledTimer(live.activityTimer);
        live.outputTimer = clearScheduledTimer(live.outputTimer);
        live.metricTimer = clearScheduledTimer(live.metricTimer);
    }

    private retire(live: LiveTerminal, shouldCapture: false, reason: PtyRetireReason): undefined;
    private retire(
        live: LiveTerminal,
        shouldCapture: true,
        reason: PtyRetireReason,
    ): Promise<TerminalSnapshot> | undefined;
    private retire(
        live: LiveTerminal,
        shouldCapture: boolean,
        reason: PtyRetireReason,
    ): Promise<TerminalSnapshot> | undefined {
        if (this.terminals.get(live.record.id) !== live) return;
        this.clearTimers(live);
        this.clearSizeLease(live.record.id);
        live.outputRecovery?.dispose();
        const tail = live.outputFramer.finish();
        if (this.attachments.has(live.record.id) || live.observers.size > 0) {
            /**
             * Let image teardown emit its bounded placeholder, but discard any raw unfinished control. Recovery below
             * still consumes the original tail, and an oversized control has already become a safe text notice.
             */
            if (this.attachments.has(live.record.id)) {
                live.droppedBytes += tail.isControl
                    ? live.imageOutput.push(tail.data, {
                          appendAtomic: (data) => live.outputQueue.appendAtomic(data),
                          appendBounded: () => 0,
                      })
                    : live.outputQueue.appendAtomic(tail.data);
                live.droppedBytes += live.imageOutput.finish(live.outputQueue);
            } else live.imageOutput.finish();
            if (live.observers.size > 0) {
                live.observerDroppedBytes += tail.isControl
                    ? live.observerImageOutput.push(tail.data, {
                          appendAtomic: (data) => live.observerOutputQueue.appendAtomic(data),
                          appendBounded: () => 0,
                      })
                    : live.observerOutputQueue.appendAtomic(tail.data);
                live.observerDroppedBytes += live.observerImageOutput.finish(
                    live.observerOutputQueue,
                );
                if (live.observerDroppedBytes > 0) {
                    live.observerNeedsResync = true;
                    live.observerResyncReason = 'overflow';
                }
            } else live.observerImageOutput.finish();
        } else {
            live.imageOutput.finish();
            live.observerImageOutput.finish();
        }
        this.flushOutput(live);
        if (live.observers.size > 0) {
            this.options.emit({
                type: 'observerGap',
                terminalId: live.record.id,
                sequence: live.observerSequence++,
                reason: 'overflow',
            });
            live.observers.clear();
        }
        this.flushMetrics(live);
        recordPtyThroughputSummary(this.options.logger, live.record.id, live.throughput, reason);
        this.resizeObserver.disposeTerminal(live.record.id);
        if (shouldCapture) {
            const colorTail = `${tail.data}${live.colorQuery?.finish() ?? ''}`;
            const recoveryTail = `${
                colorTail ? live.imageRecovery.push(colorTail) : ''
            }${live.imageRecovery.finish()}`;
            live.screen.write(recoveryTail);
        }
        this.terminals.delete(live.record.id);
        this.quiescedInput.delete(live);
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
        data: string | Buffer,
    ): boolean {
        if (this.terminals.get(live.record.id) !== live || this.quiescedInput.has(live))
            return false;
        if (provider) assertE2EAgentInput(readE2EAgentPolicy(), provider);
        live.metricInputBytes += Buffer.isBuffer(data)
            ? data.byteLength
            : Buffer.byteLength(data, 'utf8');
        live.throughput.firstInputAt ??= Date.now();
        live.metricTimer ??= setTimeout(() => this.flushMetrics(live), 1_000);
        live.process.write(data);
        return true;
    }

    /**
     * Mobile observers render their own grid, and the observer stream carries only output. A size change they did not
     * request (Desktop resize, lease release or expiry) therefore resyncs them so the next snapshot carries the new
     * grid. The lease holder sizes its own grid, so a take-over resize skips the resync.
     */
    private applySize(
        live: LiveTerminal,
        cols: number,
        rows: number,
        { resyncObservers = true }: { resyncObservers?: boolean } = {},
    ): boolean {
        if (live.process.cols === cols && live.process.rows === rows) return true;
        live.screen.resize(cols, rows);
        live.process.resize(cols, rows);
        this.resizeObserver.recordApplied(live.record.id, { cols, rows });
        if (resyncObservers && live.observers.size > 0) {
            live.observerNeedsResync = true;
            live.observerResyncReason ??= 'resize';
            live.outputTimer ??= setTimeout(() => this.flushOutput(live), this.outputFlushMs);
        }
        return true;
    }

    private emitSizeOwnership(live: LiveTerminal): void {
        this.options.emit({
            type: 'sizeOwnership',
            terminalId: live.record.id,
            owner: this.sizeLeases.has(live.record.id) ? 'mobile' : 'desktop',
            cols: live.process.cols,
            rows: live.process.rows,
        });
    }

    private clearSizeLease(terminalId: string): void {
        const lease = this.sizeLeases.get(terminalId);
        if (!lease) return;
        clearTimeout(lease.timer);
        this.sizeLeases.delete(terminalId);
    }

    private scheduleSizeLease(
        terminalId: string,
        holderId: string,
        timeoutMs: number,
    ): { expiresAt: number } {
        const lease = this.sizeLeases.get(terminalId)!;
        clearTimeout(lease.timer);
        lease.expiresAt = Date.now() + timeoutMs;
        lease.timer = setTimeout(() => this.releaseTakeOver(terminalId, holderId), timeoutMs);
        lease.timer.unref();
        return { expiresAt: lease.expiresAt };
    }

    waitForAttachedSize(
        terminalId: string,
        timeoutMs: number,
        abortSignal?: AbortSignal,
    ): Promise<void> {
        return this.attachments.waitForSize(terminalId, timeoutMs, abortSignal);
    }

    start(input: TerminalExecutionStart): number {
        if (this.terminals.has(input.record.id))
            throw new CaxriError('CONFLICT', 'Terminal already has a live PTY');
        const initialSize = this.attachments.size(input.record.id) ??
            input.initialSize ?? { cols: 100, rows: 30 };
        const child = this.spawnProcess(input.executable, input.args, {
            name: 'xterm-256color',
            cols: initialSize.cols,
            rows: initialSize.rows,
            cwd: input.record.cwd,
            env: input.environment,
        });
        const colorQuery = this.options.terminalColors
            ? new TerminalColorQueryResponder((slot, terminator) => {
                  const colors = this.options.terminalColors?.(input.record.id);
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
            outputFramer: new TerminalOutputFramer(),
            imageOutput: new TerminalImageOutputFilter(),
            observerImageOutput: new TerminalImageOutputFilter(),
            observerOutputQueue: new TerminalOutputQueue(
                this.options.observerOutputMaximumBytes ?? MAX_OUTPUT_BATCH_BYTES,
            ),
            observerDroppedBytes: 0,
            observerNeedsResync: false,
            observerResyncReason: null,
            observerSequence: 0,
            observers: new Set(),
            process: child,
            record: input.record,
            screen: new TerminalScreenState(
                input.initialSnapshot,
                initialSize.cols,
                initialSize.rows,
                {
                    ...(this.options.screenMaximumQueuedBytes && {
                        maximumQueuedBytes: this.options.screenMaximumQueuedBytes,
                    }),
                    onOverflow: (droppedBytes) => {
                        recordPtyDroppedBytes(this.options.logger, droppedBytes);
                        this.options.logger.write('warn', ptyLogEvents.screenBackpressure, {
                            fields: { terminalId: input.record.id, droppedBytes },
                        });
                        if (live.observers.size > 0) {
                            live.observerOutputQueue.clear();
                            live.observerNeedsResync = true;
                            live.observerResyncReason = 'overflow';
                            this.flushObserverOutput(live);
                        }
                    },
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
            throughput: createPtyThroughputTally(Date.now()),
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
        this.retire(live, false, 'discarded');
        stopTerminalAfterInputQuiescence(live, true);
    }

    write(terminalId: string, data: string | Buffer): boolean {
        const live = this.terminals.get(terminalId);
        if (!live) return false;
        if (typeof data === 'string') live.outputRecovery?.observeUserInput();
        return this.writeLive(live, live.record.provider, data);
    }

    /**
     * Encodes wheel input from the parsed screen's current modes, so an observer can scroll an application without
     * being able to send arbitrary bytes. Like a Desktop wheel report, it counts as user input for output recovery.
     */
    scroll(terminalId: string, wheel: TerminalWheelInput): boolean {
        const data = this.terminals.get(terminalId)?.screen.wheelInput(wheel);
        return data ? this.write(terminalId, data) : false;
    }

    async writeWithCompletion(terminalId: string, data: string | Buffer): Promise<boolean> {
        return writeAgentInputWithCompletion(
            this.terminals.get(terminalId),
            this.quiescedInput,
            data,
            (live) => {
                live.metricTimer ??= setTimeout(() => this.flushMetrics(live), 1_000);
            },
        );
    }

    quiesceInput(terminalId: string): ReturnType<typeof quiesceAgentInput> {
        return quiesceAgentInput(
            terminalId,
            (id) => this.terminals.get(id),
            this.quiescedInput,
            (id) => this.close(id),
        );
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
        /**
         * The attachment keeps the Desktop's latest grid; under a mobile lease it waits there until release.
         */
        this.attachments.resize(terminalId, { cols, rows });
        if (this.sizeLeases.has(terminalId)) return true;
        return this.applySize(live, cols, rows);
    }

    takeOver(
        terminalId: string,
        holderId: string,
        size: { cols: number; rows: number },
        timeoutMs: number,
    ): { expiresAt: number } {
        const live = this.terminals.get(terminalId);
        if (!live) throw new CaxriError('UNAVAILABLE', 'Terminal is not running');
        const current = this.sizeLeases.get(terminalId);
        if (current && current.holderId !== holderId)
            throw new CaxriError('CONFLICT', 'Terminal size is controlled by another observer');
        if (!current) {
            this.sizeLeases.set(terminalId, {
                holderId,
                live,
                previousSize: { cols: live.process.cols, rows: live.process.rows },
                expiresAt: 0,
            });
        }
        this.applySize(live, size.cols, size.rows, { resyncObservers: false });
        const lease = this.scheduleSizeLease(terminalId, holderId, timeoutMs);
        this.emitSizeOwnership(live);
        return lease;
    }

    renewTakeOver(
        terminalId: string,
        holderId: string,
        timeoutMs: number,
    ): {
        expiresAt: number;
    } {
        const lease = this.sizeLeases.get(terminalId);
        if (!lease || lease.holderId !== holderId)
            throw new CaxriError('CONFLICT', 'Terminal size lease is no longer held');
        return this.scheduleSizeLease(terminalId, holderId, timeoutMs);
    }

    releaseTakeOver(terminalId: string, holderId: string): void {
        const lease = this.sizeLeases.get(terminalId);
        if (!lease || lease.holderId !== holderId) return;
        this.clearSizeLease(terminalId);
        if (this.terminals.get(terminalId) !== lease.live) return;
        const size = this.attachments.has(terminalId)
            ? (this.attachments.size(terminalId) ?? lease.previousSize)
            : lease.previousSize;
        this.applySize(lease.live, size.cols, size.rows);
        this.emitSizeOwnership(lease.live);
    }

    async observe(
        terminalId: string,
        observerId: string,
    ): Promise<{ snapshot: TerminalSnapshot | null; nextSequence: number }> {
        const live = this.terminals.get(terminalId);
        if (!live) throw new CaxriError('UNAVAILABLE', 'Terminal is not running');
        if (live.observers.has(observerId))
            throw new CaxriError('CONFLICT', 'Terminal observer is already attached');
        this.flushObserverOutput(live);
        if (live.observers.size === 0) {
            live.observerImageOutput = new TerminalImageOutputFilter();
            live.observerOutputQueue.clear();
            live.observerNeedsResync = false;
            live.observerResyncReason = null;
        }
        live.observers.add(observerId);
        const nextSequence = live.observerSequence;
        try {
            return {
                snapshot: {
                    terminalId,
                    encodingVersion: CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION,
                    ...(await live.screen.snapshot()),
                    updatedAt: Date.now(),
                },
                nextSequence,
            };
        } catch (error) {
            this.unobserve(terminalId, observerId);
            throw error;
        }
    }

    unobserve(terminalId: string, observerId: string): void {
        const live = this.terminals.get(terminalId);
        if (!live?.observers.delete(observerId)) return;
        if (live.observers.size === 0) {
            live.observerOutputQueue.clear();
            live.observerImageOutput.finish();
            live.observerNeedsResync = false;
            live.observerResyncReason = null;
            live.observerDroppedBytes = 0;
        }
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
            this.flushObserverOutput(live);
            live.outputTimer = clearScheduledTimer(live.outputTimer);
            live.outputQueue.clear();
            live.droppedBytes = 0;
        }
        this.emitSizeOwnership(live);
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

    async textTail(terminalId: string, maximumCharacters: number): Promise<string | null> {
        const live = this.terminals.get(terminalId);
        if (!live) return null;
        return (await live.screen.textTail(maximumCharacters)).full;
    }

    detachView(terminalId: string): void {
        this.attachments.detach(terminalId);
        const live = this.terminals.get(terminalId);
        if (!live) return;
        this.flushObserverOutput(live);
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
            const capture = this.retire(live, true, 'restart');
            stopTerminalAfterInputQuiescence(live, false);
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
            const capture = this.retire(live, true, 'shutdown');
            if (capture) finalizations.push({ terminalId: live.record.id, capture });
            stopTerminalAfterInputQuiescence(live, false);
        }
        this.resizeObserver.dispose();
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
