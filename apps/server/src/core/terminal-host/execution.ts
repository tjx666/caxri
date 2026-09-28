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
import { didWriteAgentInputExact, sendAgentInput, submitAgentInput } from './agent-input';
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
import {
    canSignalHostAgentExact,
    canSignalHostProcessExact,
    configureHostOutputRecovery,
} from './host-actions';
import { projectLiveTerminalHostEvent } from './host-event-projection';
import { afterHotPaths, hotPathCompletions, settleHotPaths } from './hot-paths';
import type { TerminalInputReceipt } from './input-queue';
import { TerminalInputQueue } from './input-queue';
import { terminalStartRequest } from './launch-request';
import { RemoteMobileTerminalControl } from './mobile-observation';
import { buildShutdownCaptures } from './shutdown-captures';

export class RemoteTerminalExecution extends EventTarget implements TerminalExecutionPort {
    private readonly generations = new Map<string, number>();
    private readonly identities = new Map<string, RemoteTerminalIdentity>();
    private readonly inputQueues = new Map<string, TerminalInputQueue<RemoteTerminalIdentity>>();
    private readonly resizeQueues = new Map<string, RemoteResizeQueue>();
    private readonly views = new Map<string, RemoteView>();
    private readonly mobileControl: RemoteMobileTerminalControl;
    /**
     * Both forward straight to `mobileControl` with its own signature, so binding in the constructor keeps the
     * pass-through to one declaration per capability instead of re-typing every parameter the interface already pins
     * down. Assigned after `mobileControl` exists, not as a field initializer, which would run before it.
     */
    readonly inputForGeneration: TerminalExecutionPort['inputForGeneration'];
    readonly scrollForGeneration: TerminalExecutionPort['scrollForGeneration'];

    constructor(
        private readonly supervisor: TerminalHostControl,
        private readonly logger: StructuredLogger,
    ) {
        super();
        this.mobileControl = new RemoteMobileTerminalControl(this.identities, supervisor);
        this.inputForGeneration = this.mobileControl.inputForGeneration.bind(this.mobileControl);
        this.scrollForGeneration = this.mobileControl.scrollForGeneration.bind(this.mobileControl);
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

    /**
     * Detaches the Terminal's live identity and view, returning the hot-path work admitted under it so the Host request
     * that follows cannot overtake input or resize the Renderer already saw accepted.
     */
    private forgetIdentity(terminalId: string): {
        completions: Array<Promise<void>>;
        identity?: RemoteTerminalIdentity;
    } {
        const identity = this.identities.get(terminalId);
        const completions = hotPathCompletions(this.inputQueues, this.resizeQueues, [terminalId]);
        this.identities.delete(terminalId);
        this.views.delete(terminalId);
        return { completions, ...(identity && { identity }) };
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
        /**
         * Closure, discard, a newer reservation, or Host loss may replace the identity while its reservation settles.
         * Sending the start anyway would launch a PTY for a generation nothing tracks any more.
         */
        if (this.identities.get(input.record.id) !== identity)
            throw new CaxriError('CONFLICT', 'Terminal generation changed before launch');
        const previousAgent = identity.agent;
        identity.agent = input.agent ? { launchId: input.agent.launchId } : undefined;
        try {
            const result = (await this.supervisor.request(
                terminalStartRequest(input, this.views.get(input.record.id)?.size),
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
            // Normalize the IPC rejection only when the caller aborted its stale restore.
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
        return didWriteAgentInputExact({
            supervisor: this.supervisor,
            identities: this.identities,
            terminalId,
            data,
            launchId,
            onDelivered,
            encoding,
            acceptAttached: () =>
                this.acceptInput(
                    terminalId,
                    data,
                    MAX_INPUT_LENGTH,
                    Boolean(onDelivered),
                    launchId,
                    encoding,
                ),
            background: (task) => this.background(task, 'terminal.agent.input', terminalId),
        });
    }

    async writeAgent(terminalId: string, data: string, signal?: AbortSignal): Promise<boolean> {
        return (await sendAgentInput(this.supervisor, this.identities, terminalId, data, signal))
            .accepted;
    }

    submitAgentExact(
        terminalId: string,
        expectedSessionId: string,
        expectedAgentLaunchId: string,
        text: string,
        signal?: AbortSignal,
    ): Promise<'accepted' | 'rejected' | 'unknown'> {
        return submitAgentInput(
            this.supervisor,
            this.identities,
            terminalId,
            expectedSessionId,
            expectedAgentLaunchId,
            text,
            signal,
        );
    }

    configureOutputRecovery(
        terminalId: string,
        provider: TerminalRecord['provider'],
        settings?: AgentOutputRecoverySettings,
    ): void {
        configureHostOutputRecovery(
            this.supervisor,
            this.identities,
            terminalId,
            provider,
            settings,
            (request, method, id) => this.background(request, method, id),
        );
    }

    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean {
        return canSignalHostProcessExact(
            this.supervisor,
            this.identities,
            terminalId,
            expectedProcessId,
            signal,
            (request, method, id) => this.background(request, method, id),
        );
    }

    signalAgentExact(terminalId: string, expectedLaunchId: string, signal: string): boolean {
        return canSignalHostAgentExact(
            this.supervisor,
            this.identities,
            terminalId,
            expectedLaunchId,
            signal,
            (request, method, id) => this.background(request, method, id),
        );
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
            afterHotPaths(completions, () =>
                this.supervisor.request(
                    { method: 'terminal.detach', params: {} },
                    terminalScope(identity, 'terminal.view', view.attachmentId),
                ),
            ),
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
            afterHotPaths(completions, () =>
                this.supervisor.request(
                    { method: 'terminal.detachAll', params: {} },
                    { scope: 'server', capability: 'terminal.view' },
                ),
            ),
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

    /**
     * Sends `terminal.retire` even without a live identity: a PTY that exited naturally, or a discarded launch, leaves
     * its generation baseline on the Host, and only this signal releases it. With no identity the request is skipped
     * unless a Host is running when it would be sent, since `request` would otherwise start a Host that never saw the
     * Terminal. A live identity always sends it, so a reservation still waiting for Host startup is retired after it.
     */
    close(terminalId: string): void {
        const { completions, identity } = this.forgetIdentity(terminalId);
        this.generations.delete(terminalId);
        this.background(
            afterHotPaths(completions, async () => {
                if (!identity && !this.supervisor.isRunning()) return;
                await this.supervisor.request(
                    { method: 'terminal.retire', params: { terminalId } },
                    { scope: 'server', capability: 'terminal.lifecycle' },
                );
            }),
            'terminal.retire',
            terminalId,
        );
    }

    discard(terminalId: string): void {
        const { completions, identity } = this.forgetIdentity(terminalId);
        if (!identity) return;
        this.background(
            afterHotPaths(completions, () =>
                this.supervisor.request(
                    { method: 'terminal.stop', params: { persistSnapshot: false } },
                    terminalScope(identity, 'terminal.lifecycle'),
                ),
            ),
            'terminal.stop',
            terminalId,
        );
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
