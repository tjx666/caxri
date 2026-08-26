import process from 'node:process';

import type {
    AgentOutputRecoverySettings,
    AgentProvider,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
} from '@caxri/protocol';
import { CaxriError, defaultAgentOutputRecoverySettings, toWireError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type {
    TerminalExecutionEvent,
    TerminalExecutionExit,
    TerminalExecutionStart,
} from './engine';
import { TerminalExecutionEngine } from './engine';
import type {
    TerminalHostAuthority,
    TerminalHostMessage,
    TerminalHostRequestEnvelope,
} from './protocol';
import {
    authorizeTerminalHostRequest,
    isBoundedTerminalHostMessage,
    TERMINAL_HOST_PROTOCOL_VERSION,
    terminalHostRequestEnvelopeSchema,
} from './protocol';

export interface TerminalExecutionOwner {
    attach(
        terminalId: string,
        size?: { cols: number; rows: number },
    ): Promise<{ snapshot: TerminalSnapshot | null; wasAttached: boolean }>;
    close(terminalId: string): void;
    detachAllViews(): void;
    detachView(terminalId: string): void;
    processId(terminalId: string): number | undefined;
    reassignSession(terminalId: string, sessionId: string): void;
    reconcileOutputRecoverySettings(): void;
    resize(terminalId: string, cols: number, rows: number): boolean;
    resources(terminalId: string): Promise<TerminalResourceUsage | null>;
    restartBarrier(terminalId: string): Promise<TerminalSnapshot> | undefined;
    runningCount(sessionId?: string): number;
    shutdown(): Array<{ terminalId: string; capture: Promise<TerminalSnapshot> }>;
    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean;
    snapshot(terminalId: string): Promise<TerminalSnapshot | null>;
    start(input: TerminalExecutionStart): number;
    waitForAttachedSize(terminalId: string, timeoutMs: number): Promise<void>;
    write(terminalId: string, data: string): boolean;
}

interface RuntimeTerminalIdentity {
    attachmentId?: string;
    ptyGeneration: number;
    record: TerminalRecord;
    sessionId: string;
}

export interface TerminalHostRuntimeOptions {
    appVersion: string;
    buildId: string;
    commit: string;
    credential: string;
    engine?: TerminalExecutionOwner;
    logger: StructuredLogger;
    onProtocolViolation?: () => void;
    send(message: TerminalHostMessage): void;
    serverId: string;
}

/**
 * Authenticated Terminal Host composition root. It owns private identity fencing and translates the wire contract into
 * volatile execution operations without importing Core persistence or public request handlers.
 */
export class TerminalHostRuntime {
    private readonly colors = new Map<string, { background: string; foreground: string }>();
    private readonly engine: TerminalExecutionOwner;
    private readonly generations = new Map<string, number>();
    private readonly identities = new Map<string, RuntimeTerminalIdentity>();
    private readonly recoverySettings = new Map<AgentProvider, AgentOutputRecoverySettings>();

    constructor(private readonly options: TerminalHostRuntimeOptions) {
        this.engine =
            options.engine ??
            new TerminalExecutionEngine({
                agentOutputRecoverySettings: (provider) =>
                    this.recoverySettings.get(provider) ?? defaultAgentOutputRecoverySettings,
                currentProvider: (terminalId) => this.identities.get(terminalId)?.record.provider,
                emit: (event) => this.projectExecutionEvent(event),
                logger: options.logger,
                onExit: (event) => this.projectExecutionExit(event),
                terminalColors: (terminalId) => this.colors.get(terminalId),
            });
    }

    private authority(): TerminalHostAuthority {
        return {
            credential: this.options.credential,
            serverId: this.options.serverId,
            launchGeneration: (terminalId) => (this.generations.get(terminalId) ?? 0) + 1,
            terminal: (terminalId) => this.identities.get(terminalId),
        };
    }

    private eventIdentity(identity: RuntimeTerminalIdentity): {
        scope: 'terminal';
        sessionId: string;
        terminalId: string;
        ptyGeneration: number;
        attachmentId?: string;
    } {
        return {
            scope: 'terminal',
            sessionId: identity.sessionId,
            terminalId: identity.record.id,
            ptyGeneration: identity.ptyGeneration,
            ...(identity.attachmentId && { attachmentId: identity.attachmentId }),
        };
    }

    private projectExecutionEvent(event: TerminalExecutionEvent): void {
        const identity = this.identities.get(event.terminalId);
        if (!identity) return;
        const wireIdentity = this.eventIdentity(identity);
        switch (event.type) {
            case 'output':
                if (!identity.attachmentId) return;
                this.options.send({
                    type: 'event',
                    event: 'terminal.output',
                    identity: { ...wireIdentity, attachmentId: identity.attachmentId },
                    data: event.data,
                    ...(event.droppedBytes !== undefined && { droppedBytes: event.droppedBytes }),
                });
                return;
            case 'activity':
                this.options.send({
                    type: 'event',
                    event: 'terminal.activity',
                    identity: wireIdentity,
                    processId: event.processId,
                });
                return;
            case 'title':
                this.options.send({
                    type: 'event',
                    event: 'terminal.title',
                    identity: wireIdentity,
                    title: event.title,
                });
                return;
            case 'outputRecovery':
                this.options.send({
                    type: 'event',
                    event: 'terminal.outputRecovery',
                    identity: wireIdentity,
                    provider: event.provider,
                    status: event.status,
                });
        }
    }

    private async projectExecutionExit(event: TerminalExecutionExit): Promise<void> {
        const identity = this.identities.get(event.record.id);
        if (!identity) return;
        const snapshot = await event.capture;
        if (this.identities.get(event.record.id) === identity) {
            this.identities.delete(event.record.id);
            this.colors.delete(event.record.id);
        }
        this.options.send({
            type: 'event',
            event: 'terminal.exit',
            identity: this.eventIdentity(identity),
            exitCode: event.exitCode,
            ...(event.signal !== undefined && { signal: event.signal }),
            snapshot,
        });
    }

    private reserve(envelope: TerminalHostRequestEnvelope, record: TerminalRecord): void {
        if (envelope.scope.scope !== 'terminal')
            throw new CaxriError('FORBIDDEN', 'Terminal scope is required');
        const previous = this.identities.get(record.id);
        this.identities.set(record.id, {
            ptyGeneration: envelope.scope.ptyGeneration,
            record,
            sessionId: record.sessionId,
            ...(previous?.attachmentId && { attachmentId: previous.attachmentId }),
        });
    }

    private requireTerminalScope(
        envelope: TerminalHostRequestEnvelope,
    ): Extract<TerminalHostRequestEnvelope['scope'], { scope: 'terminal' }> {
        if (envelope.scope.scope !== 'terminal')
            throw new CaxriError('FORBIDDEN', 'Terminal scope is required');
        return envelope.scope;
    }

    private async dispatch(envelope: TerminalHostRequestEnvelope): Promise<unknown> {
        const { request } = envelope;
        switch (request.method) {
            case 'host.initialize':
                if (
                    request.params.appVersion !== this.options.appVersion ||
                    request.params.buildId !== this.options.buildId ||
                    request.params.commit !== this.options.commit
                )
                    throw new CaxriError(
                        'CONFLICT',
                        'Terminal Host build identity does not match Server Core',
                    );
                return { initialized: true };
            case 'host.shutdown': {
                const snapshots = await Promise.all(
                    this.engine.shutdown().map(({ capture }) => capture),
                );
                this.identities.clear();
                this.colors.clear();
                return { stopped: true, snapshots };
            }
            case 'terminal.reserve':
                this.reserve(envelope, request.params);
                return { reserved: true };
            case 'terminal.start': {
                const scope = this.requireTerminalScope(envelope);
                const { record } = request.params;
                const previous = this.identities.get(record.id);
                this.reserve(envelope, record);
                if (record.provider && request.params.outputRecovery)
                    this.recoverySettings.set(record.provider, request.params.outputRecovery);
                if (request.params.colors) this.colors.set(record.id, request.params.colors);
                else this.colors.delete(record.id);
                this.engine.reconcileOutputRecoverySettings();
                try {
                    const processId = this.engine.start({
                        args: request.params.args,
                        environment: request.params.environment,
                        executable: request.params.executable,
                        initialSize: request.params.initialSize,
                        initialSnapshot: request.params.initialSnapshot?.payload ?? '',
                        record,
                    });
                    this.generations.set(record.id, scope.ptyGeneration);
                    return { processId };
                } catch (error) {
                    if (previous) this.identities.set(record.id, previous);
                    else this.identities.delete(record.id);
                    this.colors.delete(record.id);
                    throw error;
                }
            }
            case 'terminal.input': {
                const scope = this.requireTerminalScope(envelope);
                return { accepted: this.engine.write(scope.terminalId, request.params.data) };
            }
            case 'terminal.resize': {
                const scope = this.requireTerminalScope(envelope);
                return {
                    accepted: this.engine.resize(
                        scope.terminalId,
                        request.params.cols,
                        request.params.rows,
                    ),
                };
            }
            case 'terminal.attach': {
                const scope = this.requireTerminalScope(envelope);
                const identity = this.identities.get(scope.terminalId)!;
                identity.attachmentId = request.params.attachmentId;
                return this.engine.attach(scope.terminalId, request.params.size);
            }
            case 'terminal.detach': {
                const scope = this.requireTerminalScope(envelope);
                this.engine.detachView(scope.terminalId);
                const identity = this.identities.get(scope.terminalId);
                if (identity) delete identity.attachmentId;
                return { detached: true };
            }
            case 'terminal.snapshot': {
                const scope = this.requireTerminalScope(envelope);
                return { snapshot: await this.engine.snapshot(scope.terminalId) };
            }
            case 'terminal.waitForAttachedSize': {
                const scope = this.requireTerminalScope(envelope);
                await this.engine.waitForAttachedSize(scope.terminalId, request.params.timeoutMs);
                return { attached: true };
            }
            case 'terminal.signal': {
                const scope = this.requireTerminalScope(envelope);
                return {
                    accepted: this.engine.signalExact(
                        scope.terminalId,
                        request.params.expectedProcessId,
                        request.params.signal,
                    ),
                };
            }
            case 'terminal.stop': {
                const scope = this.requireTerminalScope(envelope);
                const capture = request.params.persistSnapshot
                    ? this.engine.restartBarrier(scope.terminalId)
                    : undefined;
                if (!request.params.persistSnapshot) this.engine.close(scope.terminalId);
                const snapshot = capture ? await capture : null;
                if (!request.params.persistSnapshot) {
                    this.identities.delete(scope.terminalId);
                    this.colors.delete(scope.terminalId);
                }
                return { snapshot, stopped: true };
            }
            case 'terminal.reassign': {
                const scope = this.requireTerminalScope(envelope);
                this.engine.reassignSession(scope.terminalId, request.params.sessionId);
                const identity = this.identities.get(scope.terminalId)!;
                identity.sessionId = request.params.sessionId;
                identity.record = { ...identity.record, sessionId: request.params.sessionId };
                return { reassigned: true };
            }
            case 'terminal.resources': {
                const scope = this.requireTerminalScope(envelope);
                return { resources: await this.engine.resources(scope.terminalId) };
            }
            case 'terminal.recovery.configure': {
                const scope = this.requireTerminalScope(envelope);
                const identity = this.identities.get(scope.terminalId)!;
                identity.record = { ...identity.record, provider: request.params.provider };
                if (request.params.provider && request.params.settings)
                    this.recoverySettings.set(request.params.provider, request.params.settings);
                this.engine.reconcileOutputRecoverySettings();
                return { configured: true };
            }
            case 'terminal.detachAll':
                this.engine.detachAllViews();
                for (const identity of this.identities.values()) delete identity.attachmentId;
                return { detached: true };
            case 'terminal.runningCount':
                return { count: this.engine.runningCount(request.params.sessionId) };
        }
    }

    ready(): void {
        this.options.send({
            type: 'event',
            event: 'host.ready',
            serverId: this.options.serverId,
            protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
            appVersion: this.options.appVersion,
            buildId: this.options.buildId,
            commit: this.options.commit,
            pid: process.pid,
        });
    }

    async accept(value: unknown): Promise<void> {
        if (!isBoundedTerminalHostMessage(value)) {
            this.options.onProtocolViolation?.();
            return;
        }
        const parsed = terminalHostRequestEnvelopeSchema.safeParse(value);
        if (!parsed.success) {
            this.options.onProtocolViolation?.();
            return;
        }
        const envelope = parsed.data;
        const authorization = authorizeTerminalHostRequest(envelope, this.authority());
        if (!authorization.ok) {
            this.options.send({
                type: 'reply',
                id: envelope.id,
                ok: false,
                error: {
                    code: 'CAPABILITY_DENIED',
                    message: 'Terminal Host request was not authorized',
                },
            });
            return;
        }
        try {
            const result = await this.dispatch(envelope);
            this.options.send({ type: 'reply', id: envelope.id, ok: true, result });
        } catch (error) {
            const wire = toWireError(error);
            this.options.send({
                type: 'reply',
                id: envelope.id,
                ok: false,
                error: { code: wire.code, message: wire.message },
            });
        }
    }

    async stopAfterParentDisconnect(): Promise<void> {
        await Promise.all(this.engine.shutdown().map(({ capture }) => capture));
        this.identities.clear();
        this.colors.clear();
    }
}
