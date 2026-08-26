import { randomUUID } from 'node:crypto';

import type {
    AgentOutputRecoverySettings,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
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

interface RemoteTerminalIdentity {
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

type TerminalHostEvent = Exclude<
    Extract<TerminalHostMessage, { type: 'event' }>,
    { event: 'host.ready' }
>;

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
 * Process-backed execution port. It preserves synchronous hot-path acceptance from cached identities while every
 * private request remains ordered and authenticated by {@link TerminalHostSupervisor}.
 */
export class RemoteTerminalExecution extends EventTarget implements TerminalExecutionPort {
    private readonly generations = new Map<string, number>();
    private readonly identities = new Map<string, RemoteTerminalIdentity>();
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
            case 'terminal.exit': {
                this.identities.delete(identity.record.id);
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
        if (terminalIds.length > 0)
            this.dispatchEvent(
                new CustomEvent<readonly string[]>('host-exit', { detail: terminalIds }),
            );
    }

    private background(promise: Promise<unknown>, method: string, terminalId?: string): void {
        // eslint-disable-next-line no-void -- Synchronous hot paths preserve acceptance while this observer records failure.
        void this.observeBackground(promise, method, terminalId);
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

    async reserve(record: TerminalRecord): Promise<void> {
        const previous = this.identities.get(record.id);
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
        const result = (await this.supervisor.request(
            {
                method: 'terminal.start',
                params: {
                    record: input.record,
                    executable: input.executable,
                    args: input.args,
                    environment: input.environment as Record<string, string>,
                    ...(input.initialSnapshot && { initialSnapshot: input.initialSnapshot }),
                    ...(this.views.get(input.record.id)?.size && {
                        initialSize: this.views.get(input.record.id)!.size,
                    }),
                    ...(input.outputRecovery && { outputRecovery: input.outputRecovery }),
                    ...(input.colors && { colors: input.colors }),
                },
            },
            this.terminalScope(identity, 'terminal.lifecycle'),
        )) as { processId: number };
        identity.processId = result.processId;
        this.generations.set(input.record.id, identity.generation);
        return result.processId;
    }

    waitForAttachedSize(
        terminalId: string,
        timeoutMs: number,
        abortSignal?: AbortSignal,
    ): Promise<void> {
        const identity = this.identities.get(terminalId);
        if (!identity) return Promise.resolve();
        return (async () => {
            await identity.ready;
            await this.supervisor.request(
                { method: 'terminal.waitForAttachedSize', params: { timeoutMs } },
                this.terminalScope(identity, 'terminal.view'),
                abortSignal,
            );
        })();
    }

    write(terminalId: string, data: string): boolean {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId || !identity.attachmentId) return false;
        this.background(
            this.supervisor.request(
                { method: 'terminal.input', params: { data } },
                this.terminalScope(identity, 'terminal.input', identity.attachmentId),
            ),
            'terminal.input',
            terminalId,
        );
        return true;
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

    resize(terminalId: string, cols: number, rows: number): boolean {
        const identity = this.identities.get(terminalId);
        const view = this.views.get(terminalId);
        if (!view || !identity?.processId) return false;
        view.size = { cols, rows };
        this.background(
            this.supervisor.request(
                { method: 'terminal.resize', params: { cols, rows } },
                this.terminalScope(identity, 'terminal.view', view.attachmentId),
            ),
            'terminal.resize',
            terminalId,
        );
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
        this.background(
            this.supervisor.request(
                { method: 'terminal.detach', params: {} },
                this.terminalScope(identity, 'terminal.view', view.attachmentId),
            ),
            'terminal.detach',
            terminalId,
        );
        delete identity.attachmentId;
    }

    detachAllViews(): void {
        this.views.clear();
        this.background(
            this.supervisor.request(
                { method: 'terminal.detachAll', params: {} },
                { scope: 'server', capability: 'terminal.view' },
            ),
            'terminal.detachAll',
        );
        for (const identity of this.identities.values()) delete identity.attachmentId;
    }

    async restartBarrier(terminalId: string): Promise<TerminalSnapshot | null> {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId) return null;
        const result = (await this.supervisor.request(
            { method: 'terminal.stop', params: { persistSnapshot: true } },
            this.terminalScope(identity, 'terminal.lifecycle'),
        )) as { snapshot: TerminalSnapshot | null; stopped: true };
        delete identity.processId;
        return result.snapshot;
    }

    close(terminalId: string): void {
        const identity = this.identities.get(terminalId);
        this.identities.delete(terminalId);
        this.views.delete(terminalId);
        if (!identity) return;
        this.background(
            this.supervisor.request(
                { method: 'terminal.stop', params: { persistSnapshot: false } },
                this.terminalScope(identity, 'terminal.lifecycle'),
            ),
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
        const snapshots = await this.supervisor.shutdown();
        const snapshotByTerminal = new Map(
            snapshots.map((snapshot) => [snapshot.terminalId, snapshot]),
        );
        this.identities.clear();
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
