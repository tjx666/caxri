import { Buffer } from 'node:buffer';
import process from 'node:process';

import type {
    AgentOutputRecoverySettings,
    AgentProvider,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
    TerminalWheelInput,
} from '@caxri/protocol';
import {
    CaxriError,
    defaultAgentOutputRecoverySettings,
    errorMessage,
    toWireError,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, mergeObservationContext, runWithObservationContext } from '@caxri/system';
import type * as pty from 'node-pty';

import type {
    ManagedAgentLauncherEvent,
    ManagedAgentLauncherSignal,
    ManagedAgentLaunchPlan,
    PreparedManagedAgentLaunch,
} from './agent-launcher';
import { submitAgentText } from './agent-submission';
import type { TerminalHostAuthority, TerminalHostAuthorizationFailure } from './authorization';
import { authorizeTerminalHostRequest } from './authorization';
import type {
    TerminalExecutionEvent,
    TerminalExecutionExit,
    TerminalExecutionStart,
} from './engine';
import { TerminalExecutionEngine } from './engine';
import type { AgentInputHandoff } from './engine/agent-input';
import { noOpAgentInputHandoff } from './engine/agent-input';
import { projectTerminalExecutionEvent, settleTerminalExit } from './execution-event-projection';
import { TerminalGenerationLedger } from './generation-ledger';
import type { StoppableTerminalIdentity } from './generation-stop';
import { stopTerminalGeneration } from './generation-stop';
import type {
    TerminalHostMessage,
    TerminalHostRequestEnvelope,
    TerminalShutdownFailure,
} from './protocol';
import {
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
    observe(
        terminalId: string,
        observerId: string,
    ): Promise<{ snapshot: TerminalSnapshot | null; nextSequence: number }>;
    unobserve(terminalId: string, observerId: string): void;
    takeOver(
        terminalId: string,
        holderId: string,
        size: { cols: number; rows: number },
        timeoutMs: number,
    ): { expiresAt: number };
    renewTakeOver(
        terminalId: string,
        holderId: string,
        timeoutMs: number,
    ): {
        expiresAt: number;
    };
    releaseTakeOver(terminalId: string, holderId: string): void;
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
    textTail?(terminalId: string, maximumCharacters: number): Promise<string | null>;
    /**
     * Fails with `CONFLICT` when a live PTY still owns the Terminal ID. Returning that PTY's PID instead would let the
     * caller record a new generation as running on a process that belongs to the previous one, still being stopped.
     */
    start(input: TerminalExecutionStart): number;
    waitForAttachedSize(terminalId: string, timeoutMs: number): Promise<void>;
    scroll(terminalId: string, wheel: TerminalWheelInput): boolean;
    write(terminalId: string, data: string | Buffer): boolean;
    writeWithCompletion?(terminalId: string, data: string | Buffer): Promise<boolean>;
    quiesceInput?(terminalId: string): AgentInputHandoff;
}

export interface ManagedAgentExecutionOwner {
    cancel(terminalId: string, launchId: string): Promise<boolean>;
    close(): Promise<void>;
    prepare(input: {
        terminalId: string;
        launchId: string;
        plan: ManagedAgentLaunchPlan;
    }): PreparedManagedAgentLaunch;
    signalExact(terminalId: string, launchId: string, signal: ManagedAgentLauncherSignal): boolean;
    isRunningExact(terminalId: string, launchId: string): boolean;
}

interface RuntimeTerminalIdentity extends StoppableTerminalIdentity {
    agentProcessId?: number;
    agentProvider?: AgentProvider;
    attachmentId?: string;
    ptyGeneration: number;
    record: TerminalRecord;
    sessionId: string;
}

export interface TerminalHostRuntimeOptions {
    appVersion: string;
    bootId: string;
    buildId: string;
    commit: string;
    credential: string;
    engine?: TerminalExecutionOwner;
    logger: StructuredLogger;
    agentLauncher?: ManagedAgentExecutionOwner;
    outputFlushMs?: number;
    onProtocolViolation?: () => void;
    send(message: TerminalHostMessage): void;
    spawn?: typeof pty.spawn;
}

/**
 * Authenticated Terminal Host composition root. It owns private identity fencing and translates the wire contract into
 * volatile execution operations without importing Core persistence or public request handlers.
 */
export class TerminalHostRuntime {
    private readonly colors = new Map<string, { background: string; foreground: string }>();
    private readonly engine: TerminalExecutionOwner;
    private readonly generations = new TerminalGenerationLedger();
    private readonly identities = new Map<string, RuntimeTerminalIdentity>();
    private readonly recoverySettings = new Map<AgentProvider, AgentOutputRecoverySettings>();
    /**
     * Memoizes the one shutdown capture this process ever performs. Both the `host.shutdown` request (Server Core's
     * normal path) and `stopAfterParentDisconnect` (the SIGTERM/disconnect fallback in `process.ts`) can race to call
     * this; the second caller must observe the same settled result instead of re-running PTY teardown against
     * already-cleared identities.
     */
    private shutdownCapture?: Promise<{
        failures: TerminalShutdownFailure[];
        snapshots: TerminalSnapshot[];
    }>;
    /**
     * Resolved the moment a shutdown capture actually begins; see `waitForShutdownRequest`.
     */
    private readonly hostShutdownRequested = Promise.withResolvers<void>();

    constructor(private readonly options: TerminalHostRuntimeOptions) {
        if (options.engine) {
            this.engine = options.engine;
            return;
        }
        if (!options.spawn) throw new Error('Terminal Host requires a PTY spawn implementation');
        this.engine = new TerminalExecutionEngine({
            agentOutputRecoverySettings: (provider) =>
                this.recoverySettings.get(provider) ?? defaultAgentOutputRecoverySettings,
            currentProvider: (terminalId) => this.identities.get(terminalId)?.agentProvider,
            emit: (event) => this.projectExecutionEvent(event),
            logger: options.logger,
            onExit: (event) => this.projectExecutionExit(event),
            outputFlushMs: options.outputFlushMs,
            spawn: options.spawn,
            terminalColors: (terminalId) => this.colors.get(terminalId),
        });
    }

    /**
     * Emits only the request identity and classification. Private request parameters can contain Terminal input, launch
     * arguments, environment values, or snapshots and must never enter diagnostics.
     */
    /**
     * `reason` is the closed authorization-failure enum, never the peer-supplied identity, so a denied stale reserve or
     * start after `terminal.retire` stays distinguishable from a generation or attachment mismatch in the Host log.
     */
    private logRequestFailure(
        envelope: TerminalHostRequestEnvelope,
        code: string,
        reason?: TerminalHostAuthorizationFailure,
    ): void {
        this.options.logger.write('warn', logEventCatalog.terminalHost.requestFailed, {
            correlationId: envelope.id,
            context: envelope.observation,
            fields: {
                method: envelope.request.method,
                capability: envelope.scope.capability,
                code,
                ...(reason && { reason }),
                ...(envelope.scope.scope === 'terminal' && {
                    terminalId: envelope.scope.terminalId,
                }),
            },
        });
    }

    private authority(): TerminalHostAuthority {
        return {
            bootId: this.options.bootId,
            credential: this.options.credential,
            isRetired: (terminalId) => this.generations.isRetired(terminalId),
            launchGeneration: (terminalId) => this.generations.launchGeneration(terminalId),
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
        projectTerminalExecutionEvent(event, this.eventIdentity(identity), (message) =>
            this.options.send(message),
        );
    }

    private async projectExecutionExit(event: TerminalExecutionExit): Promise<void> {
        const { record } = event;
        const identity = this.identities.get(record.id);
        if (!identity) return;
        const snapshot = await settleTerminalExit(event, identity.agentLaunchId, this.options);
        if (this.identities.get(record.id) === identity) {
            this.identities.delete(record.id);
            this.colors.delete(record.id);
        }
        this.options.send({
            type: 'event',
            event: 'terminal.exit',
            identity: this.eventIdentity(identity),
            exitCode: event.exitCode,
            ...(event.signal !== undefined && { signal: event.signal }),
            ...(snapshot && { snapshot }),
        });
    }

    private projectManagedAgentStartFailure(terminalId: string, launchId: string): void {
        const identity = this.identities.get(terminalId);
        if (!identity || identity.agentLaunchId !== launchId) return;
        this.projectManagedAgentEvent({
            type: 'exited',
            terminalId,
            launchId,
            exitCode: null,
            signal: null,
        });
    }

    private reserve(envelope: TerminalHostRequestEnvelope, record: TerminalRecord): void {
        if (envelope.scope.scope !== 'terminal')
            throw new CaxriError('FORBIDDEN', 'Terminal scope is required');
        const previous = this.identities.get(record.id);
        this.identities.set(record.id, {
            ptyGeneration: envelope.scope.ptyGeneration,
            record,
            running: false,
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

    /**
     * Captures every live Terminal's final snapshot with `allSettled` instead of `all`: one Terminal whose parser
     * barrier rejects (e.g. a stuck write queue) must not discard every other Terminal's scrollback, which is the
     * all-or-nothing failure this method replaces. Memoized on `shutdownCapture` because both the `host.shutdown`
     * request and the SIGTERM/disconnect fallback (`stopAfterParentDisconnect`) can independently decide to shut down;
     * the second caller reuses the first's already-settled result instead of tearing down cleared identities again.
     */
    private captureShutdown(): Promise<{
        failures: TerminalShutdownFailure[];
        snapshots: TerminalSnapshot[];
    }> {
        if (this.shutdownCapture) return this.shutdownCapture;
        this.hostShutdownRequested.resolve();
        this.shutdownCapture = (async () => {
            const entries = this.engine.shutdown();
            const settled = await Promise.allSettled(entries.map(({ capture }) => capture));
            const snapshots: TerminalSnapshot[] = [];
            const failures: TerminalShutdownFailure[] = [];
            settled.forEach((outcome, index) => {
                if (outcome.status === 'fulfilled') snapshots.push(outcome.value);
                else
                    failures.push({
                        terminalId: entries[index].terminalId,
                        // Bounded well under the protocol's 4_096-character cap so a pathological error message can
                        // never fail the reply's own schema validation and abort the shutdown reply.
                        error: errorMessage(outcome.reason, 'unknown').slice(0, 2_000),
                    });
            });
            this.identities.clear();
            this.colors.clear();
            await this.options.agentLauncher?.close();
            return { failures, snapshots };
        })();
        return this.shutdownCapture;
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
                const { failures, snapshots } = await this.captureShutdown();
                return { stopped: true, snapshots, ...(failures.length > 0 && { failures }) };
            }
            case 'terminal.reserve':
                this.reserve(envelope, request.params);
                return { reserved: true };
            case 'terminal.start': {
                const scope = this.requireTerminalScope(envelope);
                const { record } = request.params;
                const previous = this.identities.get(record.id);
                const previousColors = this.colors.get(record.id);
                this.reserve(envelope, record);
                const launching = this.identities.get(record.id);
                if (record.provider && request.params.outputRecovery)
                    this.recoverySettings.set(record.provider, request.params.outputRecovery);
                if (request.params.colors) this.colors.set(record.id, request.params.colors);
                else this.colors.delete(record.id);
                this.engine.reconcileOutputRecoverySettings();
                let preparedAgent: PreparedManagedAgentLaunch | undefined;
                try {
                    if (request.params.agent) {
                        if (!this.options.agentLauncher)
                            throw new CaxriError(
                                'UNAVAILABLE',
                                'Managed Agent launcher is unavailable',
                            );
                        preparedAgent = this.options.agentLauncher.prepare({
                            terminalId: record.id,
                            launchId: request.params.agent.launchId,
                            plan: {
                                executable: request.params.agent.executable,
                                args: request.params.agent.args,
                                environment: request.params.agent.environment,
                                cwd: record.cwd,
                            },
                        });
                        const identity = this.identities.get(record.id)!;
                        identity.agentLaunchId = request.params.agent.launchId;
                        identity.agentProvider = request.params.agent.provider;
                        void preparedAgent.started.catch(() =>
                            this.projectManagedAgentStartFailure(
                                record.id,
                                request.params.agent!.launchId,
                            ),
                        );
                    }
                    const processId = this.engine.start({
                        args: request.params.args,
                        environment: {
                            ...request.params.environment,
                            ...preparedAgent?.environment,
                        },
                        executable: request.params.executable,
                        initialSize: request.params.initialSize,
                        initialSnapshot: request.params.initialSnapshot?.payload ?? '',
                        record,
                    });
                    this.generations.recordStart(record.id, scope.ptyGeneration);
                    this.identities.get(record.id)!.running = true;
                    if (scope.ptyGeneration > 1)
                        this.options.logger.recordMetric('process.restarts', 1, {
                            owner: 'terminal-host',
                            phase: 'startup',
                            outcome: 'restart',
                        });
                    return { processId };
                } catch (error) {
                    if (request.params.agent)
                        await this.options.agentLauncher?.cancel(
                            record.id,
                            request.params.agent.launchId,
                        );
                    /**
                     * Roll back only this launch's own identity. Agent cancellation above can wait, and a retirement or
                     * newer reservation that landed meanwhile owns the ID now; restoring over it would resurrect a
                     * closed Terminal or erase the replacement.
                     */
                    if (this.identities.get(record.id) === launching) {
                        if (previous) this.identities.set(record.id, previous);
                        else this.identities.delete(record.id);
                        if (previousColors) this.colors.set(record.id, previousColors);
                        else this.colors.delete(record.id);
                    }
                    throw error;
                }
            }
            case 'terminal.input': {
                const scope = this.requireTerminalScope(envelope);
                if (
                    request.params.expectedAgentLaunchId !== undefined &&
                    this.identities.get(scope.terminalId)?.agentLaunchId !==
                        request.params.expectedAgentLaunchId
                )
                    throw new CaxriError('CONFLICT', 'Managed Agent changed before Terminal input');
                return {
                    accepted: this.engine.write(
                        scope.terminalId,
                        request.params.encoding === 'binary'
                            ? Buffer.from(request.params.data, 'latin1')
                            : request.params.data,
                    ),
                };
            }
            case 'terminal.agent.input': {
                const scope = this.requireTerminalScope(envelope);
                return { accepted: this.engine.write(scope.terminalId, request.params.data) };
            }
            case 'terminal.agent.submit': {
                const scope = this.requireTerminalScope(envelope);
                return submitAgentText(
                    this.engine,
                    this.identities.get(scope.terminalId),
                    scope.terminalId,
                    request.params.launchId,
                    request.params.text,
                    () =>
                        this.options.agentLauncher?.isRunningExact(
                            scope.terminalId,
                            request.params.launchId,
                        ) === true,
                );
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
            case 'terminal.observe': {
                const scope = this.requireTerminalScope(envelope);
                return this.engine.observe(scope.terminalId, request.params.observerId);
            }
            case 'terminal.unobserve': {
                const scope = this.requireTerminalScope(envelope);
                this.engine.unobserve(scope.terminalId, request.params.observerId);
                return { detached: true };
            }
            case 'terminal.takeOver': {
                const scope = this.requireTerminalScope(envelope);
                return this.engine.takeOver(
                    scope.terminalId,
                    request.params.holderId,
                    request.params.size,
                    request.params.timeoutMs,
                );
            }
            case 'terminal.renewTakeOver': {
                const scope = this.requireTerminalScope(envelope);
                return this.engine.renewTakeOver(
                    scope.terminalId,
                    request.params.holderId,
                    request.params.timeoutMs,
                );
            }
            case 'terminal.releaseTakeOver': {
                const scope = this.requireTerminalScope(envelope);
                this.engine.releaseTakeOver(scope.terminalId, request.params.holderId);
                return { released: true };
            }
            case 'terminal.observer.input': {
                const scope = this.requireTerminalScope(envelope);
                return { accepted: this.engine.write(scope.terminalId, request.params.data) };
            }
            case 'terminal.observer.scroll': {
                const scope = this.requireTerminalScope(envelope);
                return { accepted: this.engine.scroll(scope.terminalId, request.params) };
            }
            case 'terminal.snapshot': {
                const scope = this.requireTerminalScope(envelope);
                return { snapshot: await this.engine.snapshot(scope.terminalId) };
            }
            case 'terminal.textTail': {
                const scope = this.requireTerminalScope(envelope);
                return {
                    tail: this.engine.textTail
                        ? await this.engine.textTail(
                              scope.terminalId,
                              request.params.maximumCharacters,
                          )
                        : null,
                };
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
            case 'terminal.agent.signal': {
                const scope = this.requireTerminalScope(envelope);
                return {
                    accepted:
                        this.options.agentLauncher?.signalExact(
                            scope.terminalId,
                            request.params.launchId,
                            request.params.signal,
                        ) ?? false,
                };
            }
            case 'terminal.stop': {
                const scope = this.requireTerminalScope(envelope);
                const context = {
                    agentLauncher: this.options.agentLauncher,
                    colors: this.colors,
                    engine: this.engine,
                    identities: this.identities,
                    logger: this.options.logger,
                };
                // Authorization admitted this stop against the current identity of its generation.
                const identity = this.identities.get(scope.terminalId)!;
                return stopTerminalGeneration(
                    context,
                    envelope,
                    identity,
                    request.params.persistSnapshot,
                );
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
            case 'terminal.configure': {
                const { colors, provider, settings } = request.params;
                const live = this.identities.get(this.requireTerminalScope(envelope).terminalId)!;
                live.record = { ...live.record, provider };
                if (colors) this.colors.set(live.record.id, colors);
                if (provider && settings) this.recoverySettings.set(provider, settings);
                this.engine.reconcileOutputRecoverySettings();
                return { configured: true };
            }
            case 'terminal.retire': {
                const { terminalId } = request.params;
                // Fence before the first await so a reserve or start arriving during Agent cancellation is rejected.
                this.generations.retire(terminalId);
                const identity = this.identities.get(terminalId);
                if (identity?.agentLaunchId)
                    await this.options.agentLauncher?.cancel(terminalId, identity.agentLaunchId);
                this.engine.close(terminalId);
                this.identities.delete(terminalId);
                this.colors.delete(terminalId);
                return { retired: true };
            }
            case 'terminal.detachAll':
                this.engine.detachAllViews();
                for (const identity of this.identities.values()) delete identity.attachmentId;
                return { detached: true };
            case 'terminal.runningCount':
                return { count: this.engine.runningCount(request.params.sessionId) };
        }
    }

    private async acceptEnvelope(envelope: TerminalHostRequestEnvelope): Promise<void> {
        const authorization = authorizeTerminalHostRequest(envelope, this.authority());
        if (!authorization.ok) {
            this.logRequestFailure(envelope, 'CAPABILITY_DENIED', authorization.reason);
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
            this.logRequestFailure(envelope, wire.code);
            if (['INTERNAL', 'TIMEOUT', 'UNAVAILABLE'].includes(wire.code))
                this.options.logger.write('warn', logEventCatalog.terminalHost.requestFailed, {
                    correlationId: envelope.id,
                    context: envelope.observation,
                    failure: {
                        code: wire.code,
                        owner: 'terminal-host',
                        phase: 'execute',
                        reason:
                            wire.code === 'TIMEOUT'
                                ? 'timeout'
                                : wire.code === 'UNAVAILABLE'
                                  ? 'terminal-host-exited'
                                  : 'unknown',
                        remediation: 'restart-terminal-host',
                        retryable: wire.code !== 'INTERNAL',
                    },
                });
            this.options.send({
                type: 'reply',
                id: envelope.id,
                ok: false,
                error: { code: wire.code, message: wire.message },
            });
        }
    }

    quiesceManagedAgentInput(terminalId: string): AgentInputHandoff {
        return this.engine.quiesceInput?.(terminalId) ?? noOpAgentInputHandoff();
    }

    projectManagedAgentEvent(event: ManagedAgentLauncherEvent): void {
        const identity = this.identities.get(event.terminalId);
        if (!identity || identity.agentLaunchId !== event.launchId) return;
        const wireIdentity = this.eventIdentity(identity);
        if (event.type === 'started') {
            identity.agentProcessId = event.processId;
            this.options.send({
                type: 'event',
                event: 'terminal.agent.started',
                identity: wireIdentity,
                launchId: event.launchId,
                processId: event.processId,
            });
            return;
        }
        delete identity.agentLaunchId;
        delete identity.agentProcessId;
        delete identity.agentProvider;
        this.engine.reconcileOutputRecoverySettings();
        this.options.send({
            type: 'event',
            event: 'terminal.agent.exit',
            identity: wireIdentity,
            launchId: event.launchId,
            exitCode: event.exitCode,
            ...(event.signal && { signal: event.signal }),
        });
    }

    ready(): void {
        this.options.send({
            type: 'event',
            event: 'host.ready',
            bootId: this.options.bootId,
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
        const scopeContext =
            envelope.scope.scope === 'terminal'
                ? { sessionId: envelope.scope.sessionId, terminalId: envelope.scope.terminalId }
                : undefined;
        await runWithObservationContext(
            mergeObservationContext(envelope.observation, scopeContext),
            () => this.acceptEnvelope(envelope),
        );
    }

    /**
     * Resolves once a shutdown capture has actually begun (through either `host.shutdown` or this same method), or
     * after `timeoutMs` elapses, whichever is first. Terminal Host owns no filesystem or database persistence of its
     * own: SQLite lives only in Server Core (see `.agents/skills/project-architecture`), so a bare SIGTERM must not
     * immediately discard captured snapshots. The entrypoint (`process.ts`) uses this to give Server Core's own
     * `host.shutdown` request, which walks this exact capture and can persist the result, a bounded chance to arrive
     * over the still-connected parent IPC channel before falling back to `stopAfterParentDisconnect`.
     */
    async waitForShutdownRequest(timeoutMs: number): Promise<boolean> {
        if (this.shutdownCapture) return true;
        const timedOut = Symbol('terminal-host-shutdown-wait-timed-out');
        const requested = async (): Promise<'requested'> => {
            await this.hostShutdownRequested.promise;
            return 'requested';
        };
        const outcome = await Promise.race([
            requested(),
            new Promise<typeof timedOut>((resolve) => {
                const timer = setTimeout(() => resolve(timedOut), timeoutMs);
                timer.unref();
            }),
        ]);
        return outcome !== timedOut;
    }

    /**
     * SIGTERM/parent-disconnect fallback: captures every live Terminal's final snapshot the same way `host.shutdown`
     * does, but the result cannot be persisted here (see `waitForShutdownRequest`) and is discarded after capture. Safe
     * to call after `host.shutdown` already ran: `captureShutdown` reuses its memoized result instead of tearing down
     * already-cleared identities again.
     */
    async stopAfterParentDisconnect(): Promise<void> {
        await this.captureShutdown();
    }
}
