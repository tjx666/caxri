import { randomUUID } from 'node:crypto';

import type {
    AgentOutputRecoverySettings,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
} from '@caxri/protocol';
import {
    CaxriError,
    MAX_TERMINAL_INPUT_LENGTH,
    MAX_TERMINAL_INPUT_PAYLOAD_LENGTH,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type {
    TerminalExecutionEvent,
    TerminalExecutionExit,
    TerminalExecutionLaunch,
    TerminalExecutionPort,
} from '../../domains/terminal';
import type {
    TerminalHostMessage,
    TerminalHostRequest,
    TerminalHostScope,
} from '../../terminal-host/protocol';
import type { TerminalInputReceipt } from './input-queue';
import { TerminalInputQueue } from './input-queue';

interface RemoteTerminalIdentity {
    agent?: { launchId: string; processId?: number };
    attachmentId?: string;
    generation: number;
    processId?: number;
    ready: Promise<void>;
    record: TerminalRecord;
}

interface RemoteView {
    attachmentId: string;
    size?: { cols: number; rows: number };
}
interface RemoteResizeQueue {
    completion?: Promise<void>;
    identity: RemoteTerminalIdentity;
    latest?: { cols: number; rows: number };
    view: RemoteView;
}

type HostMessageEvent = Extract<TerminalHostMessage, { type: 'event' }>;
type TerminalHostEvent = Exclude<HostMessageEvent, { event: 'host.ready' }>;

/**
 * Bounds accepted-but-not-yet-delivered input while allowing short bursts to coalesce. The private protocol has a
 * stricter per-request limit, so each drain emits at most one private frame's worth of text.
 */
const MAX_QUEUED_KEYBOARD_INPUT_CHARACTERS = MAX_TERMINAL_INPUT_LENGTH * 4;
const MAX_QUEUED_TERMINAL_INPUT_CHARACTERS =
    MAX_TERMINAL_INPUT_PAYLOAD_LENGTH + MAX_TERMINAL_INPUT_LENGTH * 4;

export interface TerminalHostControl {
    onEvent(listener: (event: TerminalHostEvent) => void): () => void;
    onExit(listener: (event: { code: number; signal: NodeJS.Signals | null }) => void): () => void;
    request(
        request: TerminalHostRequest,
        scope: TerminalHostScope,
        signal?: AbortSignal,
    ): Promise<unknown>;
    shutdown(): Promise<TerminalSnapshot[]>;
}

/**
 * Process-backed execution port with synchronous cached hot paths and authenticated request ordering.
 */
export class RemoteTerminalExecution extends EventTarget implements TerminalExecutionPort {
    private readonly generations = new Map<string, number>();
    private readonly identities = new Map<string, RemoteTerminalIdentity>();
    private readonly inputQueues = new Map<string, TerminalInputQueue<RemoteTerminalIdentity>>();
    private readonly resizeQueues = new Map<string, RemoteResizeQueue>();
    private readonly views = new Map<string, RemoteView>();

    constructor(
        private readonly supervisor: TerminalHostControl,
        private readonly logger: StructuredLogger,
    ) {
        super();
        supervisor.onEvent((event) => this.projectHostEvent(event));
        supervisor.onExit(() => this.handleHostExit());
    }

    private terminalScope(
        identity: RemoteTerminalIdentity,
        capability: 'terminal.input' | 'terminal.inspect' | 'terminal.lifecycle' | 'terminal.view',
        attachmentId?: string,
    ): TerminalHostScope {
        return {
            scope: 'terminal',
            capability,
            sessionId: identity.record.sessionId,
            terminalId: identity.record.id,
            ptyGeneration: identity.generation,
            ...(attachmentId && { attachmentId }),
        };
    }

    private isCurrentEvent(event: TerminalHostEvent): RemoteTerminalIdentity | undefined {
        const identity = this.identities.get(event.identity.terminalId);
        if (
            !identity ||
            identity.record.sessionId !== event.identity.sessionId ||
            identity.generation !== event.identity.ptyGeneration
        )
            return;
        return identity;
    }

    private projectHostEvent(event: TerminalHostEvent): void {
        const identity = this.isCurrentEvent(event);
        if (!identity) return;
        switch (event.event) {
            case 'terminal.output':
                if (!identity.attachmentId || event.identity.attachmentId !== identity.attachmentId)
                    return;
                this.emitExecution({
                    type: 'output',
                    terminalId: identity.record.id,
                    data: event.data,
                    ...(event.droppedBytes !== undefined && { droppedBytes: event.droppedBytes }),
                });
                return;
            case 'terminal.activity':
                this.emitExecution({
                    type: 'activity',
                    terminalId: identity.record.id,
                    processId: event.processId,
                });
                return;
            case 'terminal.title':
                this.emitExecution({
                    type: 'title',
                    terminalId: identity.record.id,
                    title: event.title,
                });
                return;
            case 'terminal.outputRecovery':
                this.emitExecution({
                    type: 'outputRecovery',
                    terminalId: identity.record.id,
                    provider: event.provider,
                    status: event.status,
                });
                return;
            case 'terminal.agent.started':
                if (identity.agent?.launchId !== event.launchId) return;
                identity.agent.processId = event.processId;
                this.emitExecution({
                    type: 'agentStarted',
                    terminalId: identity.record.id,
                    launchId: event.launchId,
                    processId: event.processId,
                });
                return;
            case 'terminal.agent.exit':
                if (identity.agent?.launchId !== event.launchId) return;
                delete identity.agent;
                this.emitExecution({
                    type: 'agentExit',
                    terminalId: identity.record.id,
                    launchId: event.launchId,
                    exitCode: event.exitCode,
                    ...(event.signal !== undefined && { signal: event.signal }),
                });
                return;
            case 'terminal.exit': {
                this.identities.delete(identity.record.id);
                this.retireInputQueue(
                    identity.record.id,
                    new CaxriError('UNAVAILABLE', 'Terminal exited before input completed'),
                    true,
                );
                this.resizeQueues.delete(identity.record.id);
                this.views.delete(identity.record.id);
                const capture = event.snapshot
                    ? Promise.resolve(event.snapshot)
                    : Promise.reject(new Error('Terminal Host exit omitted the final snapshot'));
                this.dispatchEvent(
                    new CustomEvent<TerminalExecutionExit>('exit', {
                        detail: {
                            capture,
                            exitCode: event.exitCode,
                            record: identity.record,
                            ...(event.signal !== undefined && { signal: event.signal }),
                        },
                    }),
                );
            }
        }
    }

    private emitExecution(event: TerminalExecutionEvent): void {
        this.dispatchEvent(new CustomEvent<TerminalExecutionEvent>('event', { detail: event }));
    }

    private handleHostExit(): void {
        const terminalIds = this.identities
            .values()
            .filter(({ processId }) => processId !== undefined)
            .map(({ record }) => record.id)
            .toArray();
        this.identities.clear();
        this.retireAllInputQueues('Terminal Host exited before input completed');
        this.resizeQueues.clear();
        if (terminalIds.length > 0)
            this.dispatchEvent(
                new CustomEvent<readonly string[]>('host-exit', { detail: terminalIds }),
            );
    }

    private background(promise: Promise<unknown>, method: string, terminalId?: string): void {
        // eslint-disable-next-line no-void -- Synchronous hot paths preserve acceptance while this observer records failure.
        void this.observeBackground(promise, method, terminalId);
    }

    private async drainInput(queue: TerminalInputQueue<RemoteTerminalIdentity>): Promise<void> {
        const terminalId = queue.identity.record.id;
        try {
            await queue.identity.ready;
            while (this.inputQueues.get(terminalId) === queue && queue.hasPendingChunks) {
                const batch = queue.takeBatch();
                // eslint-disable-next-line no-await-in-loop -- Input ordering requires one private request in flight per Terminal.
                const result = (await this.supervisor.request(
                    { method: 'terminal.input', params: batch.params },
                    this.terminalScope(queue.identity, 'terminal.input', queue.attachmentId),
                    queue.abortController.signal,
                )) as { accepted: boolean };
                if (!result.accepted)
                    throw new CaxriError('UNAVAILABLE', 'Terminal exited before input completed');
                if (queue.settleAcceptedBatch(batch)) return;
                if (this.inputQueues.get(terminalId) !== queue) return;
            }
        } catch (error) {
            queue.reject(error);
            throw error;
        } finally {
            if (this.inputQueues.get(terminalId) === queue) this.inputQueues.delete(terminalId);
        }
    }

    private retireInputQueue(
        terminalId: string,
        error: unknown,
        canFinishActiveBatch = false,
    ): void {
        const queue = this.inputQueues.get(terminalId);
        if (!queue) return;
        this.inputQueues.delete(terminalId);
        if (canFinishActiveBatch && queue.deferRejectionUntilActiveBatchSettles(error)) return;
        queue.reject(error);
    }

    private retireAllInputQueues(message: string): void {
        const error = new CaxriError('UNAVAILABLE', message);
        for (const terminalId of this.inputQueues.keys()) this.retireInputQueue(terminalId, error);
    }

    private async drainResize(queue: RemoteResizeQueue): Promise<void> {
        const terminalId = queue.identity.record.id;
        try {
            await queue.identity.ready;
            while (this.resizeQueues.get(terminalId) === queue && queue.latest) {
                const size = queue.latest;
                queue.latest = undefined;
                // eslint-disable-next-line no-await-in-loop -- Resize pressure stays bounded by serializing the latest dimensions.
                await this.supervisor.request(
                    { method: 'terminal.resize', params: size },
                    this.terminalScope(queue.identity, 'terminal.view', queue.view.attachmentId),
                );
            }
        } finally {
            if (this.resizeQueues.get(terminalId) === queue) this.resizeQueues.delete(terminalId);
        }
    }

    private hotPathCompletions(terminalIds: Iterable<string>): Array<Promise<void>> {
        const completions: Array<Promise<void>> = [];
        for (const terminalId of terminalIds) {
            const input = this.inputQueues.get(terminalId)?.completion;
            const resize = this.resizeQueues.get(terminalId)?.completion;
            if (input) completions.push(input);
            if (resize) completions.push(resize);
        }
        return completions;
    }

    private async settleHotPaths(terminalIds: Iterable<string>): Promise<void> {
        await Promise.allSettled(this.hotPathCompletions(terminalIds));
    }

    private async observeBackground(
        promise: Promise<unknown>,
        method: string,
        terminalId?: string,
    ): Promise<void> {
        try {
            await promise;
        } catch (error) {
            this.logger.write('warn', logEventCatalog.terminalHost.error, {
                fields: {
                    method,
                    ...(terminalId && { terminalId }),
                    errorType: error instanceof Error ? error.name : typeof error,
                },
            });
        }
    }

    private async attachReserved(
        identity: RemoteTerminalIdentity,
        view: RemoteView,
    ): Promise<{
        snapshot: TerminalSnapshot | null;
        wasAttached: boolean;
    }> {
        if (identity.attachmentId && identity.attachmentId !== view.attachmentId)
            this.retireInputQueue(
                identity.record.id,
                new CaxriError('CONFLICT', 'Terminal attachment changed before input completed'),
            );
        identity.attachmentId = view.attachmentId;
        return (await this.supervisor.request(
            {
                method: 'terminal.attach',
                params: {
                    attachmentId: view.attachmentId,
                    ...(view.size !== undefined && { size: view.size }),
                },
            },
            this.terminalScope(identity, 'terminal.view', view.attachmentId),
        )) as { snapshot: TerminalSnapshot | null; wasAttached: boolean };
    }

    private acceptInput(
        terminalId: string,
        data: string,
        maximumLength: number,
        shouldAcknowledge = false,
        expectedAgentLaunchId?: string,
    ): {
        accepted: boolean;
        queue?: TerminalInputQueue<RemoteTerminalIdentity>;
        receipt?: TerminalInputReceipt;
    } {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId || !identity.attachmentId) return { accepted: false };
        if (data.length > maximumLength) return { accepted: false };
        if (data.length === 0) return { accepted: true };
        let queue = this.inputQueues.get(terminalId);
        if (
            queue &&
            (queue.identity !== identity || queue.attachmentId !== identity.attachmentId)
        ) {
            this.retireInputQueue(
                terminalId,
                new CaxriError('CONFLICT', 'Terminal identity changed before input completed'),
            );
            queue = undefined;
        }
        if (!queue) {
            queue = new TerminalInputQueue(identity.attachmentId, identity);
            this.inputQueues.set(terminalId, queue);
        }
        const capacity =
            shouldAcknowledge || queue.hasAcknowledgedInput
                ? MAX_QUEUED_TERMINAL_INPUT_CHARACTERS
                : MAX_QUEUED_KEYBOARD_INPUT_CHARACTERS;
        if (queue.queuedCharacters + data.length > capacity)
            throw new CaxriError('CAPACITY', 'Terminal input queue capacity exceeded');
        const receipt = queue.enqueue(data, shouldAcknowledge, expectedAgentLaunchId);
        if (!queue.completion) {
            queue.completion = this.drainInput(queue);
            this.background(queue.completion, 'terminal.input', terminalId);
        }
        return { accepted: true, queue, ...(receipt && { receipt }) };
    }

    async reserve(record: TerminalRecord): Promise<void> {
        const previous = this.identities.get(record.id);
        this.retireInputQueue(
            record.id,
            new CaxriError('CONFLICT', 'Terminal generation changed before input completed'),
        );
        this.resizeQueues.delete(record.id);
        const generation = (this.generations.get(record.id) ?? 0) + 1;
        const identity: RemoteTerminalIdentity = {
            generation,
            ready: Promise.resolve(),
            record,
            ...(previous?.attachmentId && { attachmentId: previous.attachmentId }),
        };
        const ready = (async () => {
            await this.supervisor.request(
                { method: 'terminal.reserve', params: record },
                this.terminalScope(identity, 'terminal.lifecycle'),
            );
            const view = this.views.get(record.id);
            if (view) await this.attachReserved(identity, view);
        })();
        identity.ready = ready;
        this.identities.set(record.id, identity);
        try {
            await ready;
        } catch (error) {
            if (this.identities.get(record.id) === identity) {
                if (previous) this.identities.set(record.id, previous);
                else this.identities.delete(record.id);
            }
            throw error;
        }
    }

    async start(input: TerminalExecutionLaunch): Promise<number> {
        const identity = this.identities.get(input.record.id);
        if (!identity) throw new Error('Terminal execution was not reserved');
        await identity.ready;
        const previousAgent = identity.agent;
        identity.agent = input.agent ? { launchId: input.agent.launchId } : undefined;
        try {
            const result = (await this.supervisor.request(
                {
                    method: 'terminal.start',
                    params: {
                        record: input.record,
                        executable: input.executable,
                        args: input.args,
                        environment: input.environment as Record<string, string>,
                        ...(input.agent && {
                            agent: {
                                launchId: input.agent.launchId,
                                provider: input.agent.provider,
                                executable: input.agent.executable,
                                args: input.agent.args,
                                environment: input.agent.environment as Record<string, string>,
                            },
                        }),
                        ...(input.initialSnapshot && { initialSnapshot: input.initialSnapshot }),
                        ...(this.views.get(input.record.id)?.size && {
                            initialSize: this.views.get(input.record.id)!.size,
                        }),
                        ...(input.outputRecovery && { outputRecovery: input.outputRecovery }),
                        ...(input.colors && {
                            colors: {
                                background: input.colors.background,
                                foreground: input.colors.foreground,
                            },
                        }),
                    },
                },
                this.terminalScope(identity, 'terminal.lifecycle'),
            )) as { processId: number };
            identity.processId = result.processId;
            this.generations.set(input.record.id, identity.generation);
            return result.processId;
        } catch (error) {
            if (identity.agent?.launchId === input.agent?.launchId) identity.agent = previousAgent;
            throw error;
        }
    }

    async waitForAttachedSize(
        terminalId: string,
        timeoutMs: number,
        abortSignal?: AbortSignal,
    ): Promise<void> {
        const identity = this.identities.get(terminalId);
        if (!identity) return;
        await identity.ready;
        try {
            await this.supervisor.request(
                { method: 'terminal.waitForAttachedSize', params: { timeoutMs } },
                this.terminalScope(identity, 'terminal.view'),
                abortSignal,
            );
        } catch (error) {
            /**
             * Normalize the IPC rejection only when the caller aborted its stale restore.
             */
            if (!abortSignal?.aborted) throw error;
            if (!(error instanceof CaxriError) || error.code !== 'CANCELLED') throw error;
        }
    }

    write(terminalId: string, data: string): boolean {
        return this.acceptInput(terminalId, data, MAX_TERMINAL_INPUT_LENGTH).accepted;
    }

    async writeAcknowledged(
        terminalId: string,
        data: string,
        abortSignal?: AbortSignal,
    ): Promise<boolean> {
        if (abortSignal?.aborted)
            throw new CaxriError('CANCELLED', 'Terminal input was cancelled before admission');
        const result = this.acceptInput(terminalId, data, MAX_TERMINAL_INPUT_PAYLOAD_LENGTH, true);
        if (!result.accepted) return false;
        const { queue, receipt } = result;
        if (!queue || !receipt) return true;
        await queue.waitForReceipt(receipt, abortSignal, () => {
            if (this.inputQueues.get(terminalId) === queue)
                this.retireInputQueue(
                    terminalId,
                    new CaxriError('CANCELLED', 'Terminal input was cancelled'),
                );
        });
        return true;
    }

    writeAgentExact(terminalId: string, data: string, launchId: string): boolean {
        if (this.identities.get(terminalId)?.agent?.launchId !== launchId) return false;
        return this.acceptInput(terminalId, data, MAX_TERMINAL_INPUT_LENGTH, false, launchId)
            .accepted;
    }

    configureOutputRecovery(
        terminalId: string,
        provider: TerminalRecord['provider'],
        settings?: AgentOutputRecoverySettings,
    ): void {
        const identity = this.identities.get(terminalId);
        if (!identity) return;
        identity.record = { ...identity.record, provider };
        this.background(
            this.supervisor.request(
                {
                    method: 'terminal.recovery.configure',
                    params: { provider, ...(settings && { settings }) },
                },
                this.terminalScope(identity, 'terminal.lifecycle'),
            ),
            'terminal.recovery.configure',
            terminalId,
        );
    }

    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean {
        const identity = this.identities.get(terminalId);
        if (
            identity?.processId !== expectedProcessId ||
            (signal !== 'SIGINT' && signal !== 'SIGHUP')
        )
            return false;
        this.background(
            this.supervisor.request(
                { method: 'terminal.signal', params: { expectedProcessId, signal } },
                this.terminalScope(identity, 'terminal.lifecycle'),
            ),
            'terminal.signal',
            terminalId,
        );
        return true;
    }

    signalAgentExact(terminalId: string, expectedLaunchId: string, signal: string): boolean {
        const identity = this.identities.get(terminalId);
        if (
            identity?.agent?.launchId !== expectedLaunchId ||
            identity.agent.processId === undefined ||
            (signal !== 'SIGINT' && signal !== 'SIGHUP')
        )
            return false;
        this.background(
            this.supervisor.request(
                { method: 'terminal.agent.signal', params: { launchId: expectedLaunchId, signal } },
                this.terminalScope(identity, 'terminal.lifecycle'),
            ),
            'terminal.agent.signal',
            terminalId,
        );
        return true;
    }

    resize(terminalId: string, cols: number, rows: number): boolean {
        const identity = this.identities.get(terminalId);
        const view = this.views.get(terminalId);
        if (!view || !identity?.processId) return false;
        view.size = { cols, rows };
        let queue = this.resizeQueues.get(terminalId);
        if (queue && (queue.identity !== identity || queue.view !== view)) queue = undefined;
        if (!queue) {
            queue = { identity, view };
            this.resizeQueues.set(terminalId, queue);
        }
        queue.latest = { cols, rows };
        if (!queue.completion) {
            queue.completion = this.drainResize(queue);
            this.background(queue.completion, 'terminal.resize', terminalId);
        }
        return true;
    }

    async attach(
        terminalId: string,
        size?: { cols: number; rows: number },
    ): Promise<{ snapshot: TerminalSnapshot | null; wasAttached: boolean }> {
        const previous = this.views.get(terminalId);
        const view = { attachmentId: randomUUID(), ...(size && { size }) };
        this.views.set(terminalId, view);
        const identity = this.identities.get(terminalId);
        if (!identity) return { snapshot: null, wasAttached: Boolean(previous) };
        await identity.ready;
        return this.attachReserved(identity, view);
    }

    async snapshot(terminalId: string): Promise<TerminalSnapshot | null> {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId) return null;
        const result = (await this.supervisor.request(
            { method: 'terminal.snapshot', params: {} },
            this.terminalScope(identity, 'terminal.view'),
        )) as { snapshot: TerminalSnapshot | null };
        return result.snapshot;
    }

    detachView(terminalId: string): void {
        const identity = this.identities.get(terminalId);
        const view = this.views.get(terminalId);
        this.views.delete(terminalId);
        if (!identity || !view) return;
        const completions = this.hotPathCompletions([terminalId]);
        delete identity.attachmentId;
        this.background(
            (async () => {
                await Promise.allSettled(completions);
                await this.supervisor.request(
                    { method: 'terminal.detach', params: {} },
                    this.terminalScope(identity, 'terminal.view', view.attachmentId),
                );
            })(),
            'terminal.detach',
            terminalId,
        );
    }

    detachAllViews(): void {
        const attached = this.identities
            .values()
            .filter(({ attachmentId }) => attachmentId !== undefined)
            .toArray();
        this.views.clear();
        if (attached.length === 0) return;
        const completions = this.hotPathCompletions(attached.map(({ record }) => record.id));
        for (const identity of attached) delete identity.attachmentId;
        this.background(
            (async () => {
                await Promise.allSettled(completions);
                await this.supervisor.request(
                    { method: 'terminal.detachAll', params: {} },
                    { scope: 'server', capability: 'terminal.view' },
                );
            })(),
            'terminal.detachAll',
        );
    }

    async restartBarrier(terminalId: string): Promise<TerminalSnapshot | null> {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId) return null;
        await this.settleHotPaths([terminalId]);
        const result = (await this.supervisor.request(
            { method: 'terminal.stop', params: { persistSnapshot: true } },
            this.terminalScope(identity, 'terminal.lifecycle'),
        )) as { snapshot: TerminalSnapshot | null; stopped: true };
        delete identity.processId;
        delete identity.agent;
        return result.snapshot;
    }

    close(terminalId: string): void {
        const identity = this.identities.get(terminalId);
        const completions = this.hotPathCompletions([terminalId]);
        this.identities.delete(terminalId);
        this.views.delete(terminalId);
        if (!identity) return;
        this.background(
            (async () => {
                await Promise.allSettled(completions);
                await this.supervisor.request(
                    { method: 'terminal.stop', params: { persistSnapshot: false } },
                    this.terminalScope(identity, 'terminal.lifecycle'),
                );
            })(),
            'terminal.stop',
            terminalId,
        );
    }

    discard(terminalId: string): void {
        this.close(terminalId);
    }

    reassignSession(terminalId: string, sessionId: string): void {
        const identity = this.identities.get(terminalId);
        if (!identity) return;
        const request = this.supervisor.request(
            { method: 'terminal.reassign', params: { sessionId } },
            this.terminalScope(identity, 'terminal.lifecycle'),
        );
        identity.record = { ...identity.record, sessionId };
        this.background(request, 'terminal.reassign', terminalId);
    }

    terminateSession(sessionId: string, terminalIds: readonly string[]): string[] {
        const retired: string[] = [];
        for (const terminalId of terminalIds) {
            const identity = this.identities.get(terminalId);
            if (identity?.record.sessionId === sessionId && identity.processId)
                retired.push(terminalId);
            this.close(terminalId);
        }
        return retired;
    }

    runningCount(sessionId?: string): number {
        return this.identities
            .values()
            .filter(
                (identity) =>
                    identity.processId !== undefined &&
                    (sessionId === undefined || identity.record.sessionId === sessionId),
            )
            .toArray().length;
    }

    processId(terminalId: string): number | undefined {
        return this.identities.get(terminalId)?.processId;
    }

    agentProcessId(terminalId: string): number | undefined {
        return this.identities.get(terminalId)?.agent?.processId;
    }

    agentLaunchId(terminalId: string): string | undefined {
        return this.identities.get(terminalId)?.agent?.launchId;
    }

    async resources(terminalId: string): Promise<TerminalResourceUsage | null> {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId) return null;
        const result = (await this.supervisor.request(
            { method: 'terminal.resources', params: {} },
            this.terminalScope(identity, 'terminal.inspect'),
        )) as { resources: TerminalResourceUsage | null };
        return result.resources;
    }

    async shutdown(): Promise<Array<{ terminalId: string; capture: Promise<TerminalSnapshot> }>> {
        const liveIds = this.identities
            .values()
            .filter(({ processId }) => processId !== undefined)
            .map(({ record }) => record.id)
            .toArray();
        await this.settleHotPaths(liveIds);
        const snapshots = await this.supervisor.shutdown();
        const snapshotByTerminal = new Map(
            snapshots.map((snapshot) => [snapshot.terminalId, snapshot]),
        );
        this.retireAllInputQueues('Terminal shut down before input completed');
        this.identities.clear();
        this.resizeQueues.clear();
        this.views.clear();
        return liveIds.map((terminalId) => ({
            terminalId,
            capture: snapshotByTerminal.has(terminalId)
                ? Promise.resolve(snapshotByTerminal.get(terminalId)!)
                : Promise.reject(new Error('Terminal Host shutdown omitted the final snapshot')),
        }));
    }

    onEvent(listener: (event: TerminalExecutionEvent) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<TerminalExecutionEvent>).detail);
        this.addEventListener('event', handler);
        return () => this.removeEventListener('event', handler);
    }

    onExit(listener: (event: TerminalExecutionExit) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<TerminalExecutionExit>).detail);
        this.addEventListener('exit', handler);
        return () => this.removeEventListener('exit', handler);
    }

    onHostExit(listener: (terminalIds: readonly string[]) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<readonly string[]>).detail);
        this.addEventListener('host-exit', handler);
        return () => this.removeEventListener('host-exit', handler);
    }
}
