import { randomUUID } from 'node:crypto';

import type {
    AgentOutputRecoverySettings,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
} from '@caxri/protocol';
import {
    CaxriError,
    MAX_TERMINAL_INPUT_LENGTH as MAX_INPUT_LENGTH,
    MAX_TERMINAL_INPUT_PAYLOAD_LENGTH as MAX_INPUT_PAYLOAD_LENGTH,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type {
    TerminalExecutionEvent,
    TerminalExecutionExit,
    TerminalExecutionLaunch,
    TerminalExecutionPort,
    TerminalObserverEvent,
} from '../../domains/terminal';
import { canSendAgentInput, deliverAgentInput, sendAgentInput } from './agent-input';
import {
    attachFailureLog,
    didRestorePublishedAttachment,
    forgetAttachment,
    restoreRequestedView,
} from './attach-failure';
import { observeBackgroundFailure } from './background-failure';
import type {
    RemoteResizeQueue,
    RemoteTerminalIdentity,
    RemoteView,
    TerminalHostControl,
    TerminalHostEvent,
} from './execution-contract';
import { listenExecutionEvent } from './execution-events';
import { currentIdentity, terminalScope } from './execution-scope';
import { projectLiveTerminalHostEvent } from './host-event-projection';
import { hotPathCompletions, settleHotPaths } from './hot-paths';
import type { TerminalInputReceipt } from './input-queue';
import { TerminalInputQueue } from './input-queue';
import { RemoteMobileTerminalControl } from './mobile-observation';
import { buildShutdownCaptures } from './shutdown-captures';

/**
 * Process-backed port: Renderer input and resize accept from cached identities; managed Agent input awaits Host.
 */
export class RemoteTerminalExecution extends EventTarget implements TerminalExecutionPort {
    private readonly generations = new Map<string, number>();
    private readonly identities = new Map<string, RemoteTerminalIdentity>();
    private readonly inputQueues = new Map<string, TerminalInputQueue<RemoteTerminalIdentity>>();
    private readonly resizeQueues = new Map<string, RemoteResizeQueue>();
    private readonly views = new Map<string, RemoteView>();
    private readonly mobileControl: RemoteMobileTerminalControl;

    constructor(
        private readonly supervisor: TerminalHostControl,
        private readonly logger: StructuredLogger,
    ) {
        super();
        this.mobileControl = new RemoteMobileTerminalControl(this.identities, supervisor);
        supervisor.onEvent((event) => this.projectHostEvent(event));
        supervisor.onExit(() => this.handleHostExit());
    }

    private projectHostEvent(event: TerminalHostEvent): void {
        const identity = currentIdentity(this.identities, event);
        if (!identity) return;
        if (event.event !== 'terminal.exit') {
            projectLiveTerminalHostEvent(
                event,
                identity,
                this.views.get(identity.record.id)?.attachmentId,
                (projected) => this.emitExecution(projected),
                (projected) => this.emitObserver(projected),
            );
            return;
        }
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

    private emitExecution(event: TerminalExecutionEvent): void {
        this.dispatchEvent(new CustomEvent<TerminalExecutionEvent>('event', { detail: event }));
    }

    private emitObserver(event: TerminalObserverEvent): void {
        this.dispatchEvent(new CustomEvent<TerminalObserverEvent>('observer', { detail: event }));
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
        void observeBackgroundFailure(this.logger, promise, method, terminalId);
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
                    terminalScope(queue.identity, 'terminal.input', queue.attachmentId),
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
                    terminalScope(queue.identity, 'terminal.view', queue.view.attachmentId),
                );
            }
        } finally {
            if (this.resizeQueues.get(terminalId) === queue) this.resizeQueues.delete(terminalId);
        }
    }

    private async attachReserved(
        identity: RemoteTerminalIdentity,
        view: RemoteView,
    ): Promise<{
        snapshot: TerminalSnapshot | null;
        wasAttached: boolean;
    }> {
        if (identity.attachmentId && identity.attachmentId !== view.attachmentId) {
            /**
             * Terminal Host invalidates the previous attachment as soon as it accepts `terminal.attach`. Drain work
             * already admitted under that capability first so a Renderer remount cannot discard typed input or resize.
             */
            await settleHotPaths(this.inputQueues, this.resizeQueues, [identity.record.id]);
        }
        // Published before the request resolves, so bytes the host emits after taking the snapshot are forwarded again.
        identity.attachmentId = view.attachmentId;
        try {
            const result = (await this.supervisor.request(
                {
                    method: 'terminal.attach',
                    params: {
                        attachmentId: view.attachmentId,
                        ...(view.size !== undefined && { size: view.size }),
                    },
                },
                terminalScope(identity, 'terminal.view', view.attachmentId),
            )) as { snapshot: TerminalSnapshot | null; wasAttached: boolean };
            identity.heldAttachmentId = view.attachmentId;
            return result;
        } catch (error) {
            const isRolledBack = didRestorePublishedAttachment(identity, view, error);
            const log = attachFailureLog(identity, error, isRolledBack);
            this.logger.write('warn', logEventCatalog.terminalHost.attachFailed, log);
            throw error;
        }
    }

    private acceptInput(
        terminalId: string,
        data: string,
        maximumLength: number,
        shouldAcknowledge = false,
        expectedAgentLaunchId?: string,
        encoding?: 'binary',
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
        queue.assertCapacity(data.length, shouldAcknowledge);
        const receipt = queue.enqueue(data, shouldAcknowledge, expectedAgentLaunchId, encoding);
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
                terminalScope(identity, 'terminal.lifecycle'),
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
                terminalScope(identity, 'terminal.lifecycle'),
            )) as { processId: number };
            identity.processId = result.processId;
            if (this.identities.get(input.record.id) === identity)
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
                terminalScope(identity, 'terminal.view'),
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
        return this.acceptInput(terminalId, data, MAX_INPUT_LENGTH).accepted;
    }

    async writeAcknowledged(
        terminalId: string,
        data: string,
        abortSignal?: AbortSignal,
        encoding?: 'binary',
    ): Promise<boolean> {
        if (abortSignal?.aborted)
            throw new CaxriError('CANCELLED', 'Terminal input was cancelled before admission');
        const result = this.acceptInput(
            terminalId,
            data,
            MAX_INPUT_PAYLOAD_LENGTH,
            true,
            undefined,
            encoding,
        );
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

    writeAgentExact(
        terminalId: string,
        data: string,
        launchId: string,
        onDelivered?: (wasAccepted: boolean) => void,
        encoding?: 'binary',
    ): boolean {
        const identity = this.identities.get(terminalId);
        if (identity?.agent?.launchId !== launchId) return false;
        if (!identity.attachmentId) {
            if (encoding) return false;
            if (!canSendAgentInput(identity, data)) return false;
            /**
             * Background delegations use Host's exact-launch Agent capability without a Renderer attachment. That
             * answer arrives too late for this return value, so it reaches the caller through `onDelivered` instead:
             * the launch can change while `identity.ready` is awaited, and the Host can refuse outright.
             */
            this.background(
                deliverAgentInput(this.supervisor, this.identities, terminalId, data, onDelivered),
                'terminal.agent.input',
                terminalId,
            );
            return true;
        }
        return this.acceptInput(terminalId, data, MAX_INPUT_LENGTH, false, launchId, encoding)
            .accepted;
    }

    async writeAgent(terminalId: string, data: string, signal?: AbortSignal): Promise<boolean> {
        return (await sendAgentInput(this.supervisor, this.identities, terminalId, data, signal))
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
                terminalScope(identity, 'terminal.lifecycle'),
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
                terminalScope(identity, 'terminal.lifecycle'),
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
                terminalScope(identity, 'terminal.lifecycle'),
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

    /**
     * Recording the view before the first `await` is what closes the output gate: `identity.attachmentId` cannot rotate
     * until `identity.ready` and any hot-path work admitted under the old attachment have settled, and everything the
     * Host flushes in between is already on the parsed screen the snapshot below is about to capture. Forwarding it
     * would put the same bytes in both the snapshot and the replay the Renderer runs after it.
     */
    async attach(
        terminalId: string,
        size?: { cols: number; rows: number },
    ): Promise<{ snapshot: TerminalSnapshot | null; wasAttached: boolean }> {
        const previous = this.views.get(terminalId);
        const view = { attachmentId: randomUUID(), ...(size && { size }) };
        this.views.set(terminalId, view);
        const identity = this.identities.get(terminalId);
        if (!identity) return { snapshot: null, wasAttached: Boolean(previous) };
        try {
            await identity.ready;
            return await this.attachReserved(identity, view);
        } catch (error) {
            // A `reserve` that replaced `identity` while this call was parked re-attached `view` itself and owns it now.
            if (this.identities.get(terminalId) === identity)
                restoreRequestedView(this.views, terminalId, view, previous, identity, error);
            throw error;
        }
    }

    async snapshot(terminalId: string): Promise<TerminalSnapshot | null> {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId) return null;
        const result = (await this.supervisor.request(
            { method: 'terminal.snapshot', params: {} },
            terminalScope(identity, 'terminal.view'),
        )) as { snapshot: TerminalSnapshot | null };
        return result.snapshot;
    }

    observe(
        terminalId: string,
        observerId: string,
    ): Promise<{ snapshot: TerminalSnapshot | null; nextSequence: number; generation: number }> {
        return this.mobileControl.observe(terminalId, observerId);
    }

    unobserve(terminalId: string, observerId: string): Promise<void> {
        return this.mobileControl.unobserve(terminalId, observerId);
    }

    takeOver(
        terminalId: string,
        holderId: string,
        expectedGeneration: number,
        size: { cols: number; rows: number },
        timeoutMs: number,
    ): Promise<{ expiresAt: number }> {
        return this.mobileControl.takeOver(
            terminalId,
            holderId,
            expectedGeneration,
            size,
            timeoutMs,
        );
    }

    renewTakeOver(
        terminalId: string,
        holderId: string,
        expectedGeneration: number,
        timeoutMs: number,
    ): Promise<{ expiresAt: number }> {
        return this.mobileControl.renewTakeOver(
            terminalId,
            holderId,
            expectedGeneration,
            timeoutMs,
        );
    }

    releaseTakeOver(
        terminalId: string,
        holderId: string,
        expectedGeneration: number,
    ): Promise<void> {
        return this.mobileControl.releaseTakeOver(terminalId, holderId, expectedGeneration);
    }

    inputForGeneration(
        terminalId: string,
        expectedGeneration: number,
        data: string,
        signal?: AbortSignal,
    ): Promise<boolean> {
        return this.mobileControl.inputForGeneration(terminalId, expectedGeneration, data, signal);
    }

    async textTail(terminalId: string, maximumCharacters: number): Promise<string | null> {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId) return null;
        const result = (await this.supervisor.request(
            { method: 'terminal.textTail', params: { maximumCharacters } },
            terminalScope(identity, 'terminal.inspect'),
        )) as { tail: string | null };
        return result.tail;
    }

    detachView(terminalId: string): void {
        const identity = this.identities.get(terminalId);
        const view = this.views.get(terminalId);
        this.views.delete(terminalId);
        if (!identity || !view) return;
        const completions = hotPathCompletions(this.inputQueues, this.resizeQueues, [terminalId]);
        forgetAttachment(identity);
        this.background(
            (async () => {
                await Promise.allSettled(completions);
                await this.supervisor.request(
                    { method: 'terminal.detach', params: {} },
                    terminalScope(identity, 'terminal.view', view.attachmentId),
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
        const completions = hotPathCompletions(
            this.inputQueues,
            this.resizeQueues,
            attached.map(({ record }) => record.id),
        );
        for (const identity of attached) forgetAttachment(identity);
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
        await settleHotPaths(this.inputQueues, this.resizeQueues, [terminalId]);
        const result = (await this.supervisor.request(
            { method: 'terminal.stop', params: { persistSnapshot: true } },
            terminalScope(identity, 'terminal.lifecycle'),
        )) as { snapshot: TerminalSnapshot | null; stopped: true };
        delete identity.processId;
        delete identity.agent;
        return result.snapshot;
    }

    close(terminalId: string, permanence: 'permanent' | 'reusable' = 'permanent'): void {
        const identity = this.identities.get(terminalId);
        const completions = hotPathCompletions(this.inputQueues, this.resizeQueues, [terminalId]);
        this.identities.delete(terminalId);
        this.views.delete(terminalId);
        if (permanence === 'permanent') this.generations.delete(terminalId);
        if (!identity) return;
        this.background(
            (async () => {
                await Promise.allSettled(completions);
                await this.supervisor.request(
                    { method: 'terminal.stop', params: { persistSnapshot: false } },
                    terminalScope(identity, 'terminal.lifecycle'),
                );
            })(),
            'terminal.stop',
            terminalId,
        );
    }

    discard(terminalId: string): void {
        this.close(terminalId, 'reusable');
    }

    markCoreStopping(): void {
        this.supervisor.markCoreStopping?.();
    }

    reassignSession(terminalId: string, sessionId: string): void {
        const identity = this.identities.get(terminalId);
        if (!identity) return;
        const request = this.supervisor.request(
            { method: 'terminal.reassign', params: { sessionId } },
            terminalScope(identity, 'terminal.lifecycle'),
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
            terminalScope(identity, 'terminal.inspect'),
        )) as { resources: TerminalResourceUsage | null };
        return result.resources;
    }

    async shutdown(): Promise<Array<{ terminalId: string; capture: Promise<TerminalSnapshot> }>> {
        const liveIds = this.identities
            .values()
            .filter(({ processId }) => processId !== undefined)
            .map(({ record }) => record.id)
            .toArray();
        await settleHotPaths(this.inputQueues, this.resizeQueues, liveIds);
        const { failures, snapshots } = await this.supervisor.shutdown(liveIds.length);
        this.retireAllInputQueues('Terminal shut down before input completed');
        this.identities.clear();
        this.generations.clear();
        this.resizeQueues.clear();
        this.views.clear();
        return buildShutdownCaptures(liveIds, snapshots, failures);
    }

    onEvent(listener: (event: TerminalExecutionEvent) => void): () => void {
        return listenExecutionEvent(this, 'event', listener);
    }

    onObserverEvent(listener: (event: TerminalObserverEvent) => void): () => void {
        return listenExecutionEvent(this, 'observer', listener);
    }

    onExit(listener: (event: TerminalExecutionExit) => void): () => void {
        return listenExecutionEvent(this, 'exit', listener);
    }

    onHostExit(listener: (terminalIds: readonly string[]) => void): () => void {
        return listenExecutionEvent(this, 'host-exit', listener);
    }
}
