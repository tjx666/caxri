import { Buffer } from 'node:buffer';

import type {
    AgentEndpointRef as AgentEndpointReference,
    CommandDispatcherOptions,
    CommandExecutionContext,
    CommandReplyEnvelope,
    DesktopLease,
    DesktopTargetPayload,
    LocalClientCommand,
    LocalServerReply,
    LogEventName,
    ProtocolEventEnvelope,
    ProtocolFeature,
    ServerDesktopCredential,
    ServerManifestIdentity,
    ServerOperationRequest,
    TransientServerEvent,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    CONTROL_TRANSPORT_MAX_FRAME_BYTES,
    localServerEventSchema,
    toWireError,
} from '@caxri/protocol';
import type {
    LogRecord,
    LogWriteOptions,
    ObservationContext,
    StructuredLogger,
} from '@caxri/system';
import {
    isSecretMatch,
    logEventCatalog,
    normalizeObservationContext,
    runWithObservationContext,
} from '@caxri/system';
import type { RawData } from 'ws';
import WebSocket from 'ws';

import type { BinaryStreamControlOptions } from './binary-stream-control';
import { delegationRequestLogFields, shouldLogSuccessfulRequest } from './request-observability';

const MAX_IN_FLIGHT_REQUESTS = 64;
export const HANDSHAKE_TIMEOUT_MS = 2_000;

/**
 * Stable reason codes attached to every `terminateSocket` call so an abrupt control-socket close is diagnosable from
 * `server-core.jsonl` alone, instead of only being visible as an unexplained drop on the Desktop side.
 */
export type ControlSocketTerminationReason =
    | 'binary-frame-received'
    | 'cancellation-dispatch-failed'
    | 'command-dispatch-failed'
    | 'desktop-operation-dispatch-failed'
    | 'desktop-target-consume-failed'
    | 'handshake-timeout'
    | 'hello-agent-auth-failed'
    | 'hello-agent-auth-unavailable'
    | 'hello-desktop-credential-mismatch'
    | 'hello-operator-token-mismatch'
    | 'hello-profile-mismatch'
    | 'invalid-message'
    | 'lease-renew-stale-generation'
    | 'queue-processing-failed'
    | 'replaced-desktop-no-lease'
    | 'replaced-desktop-notify-failed'
    | 'replaced-desktop-socket-not-open'
    | 'reply-drop-injected'
    | 'reply-settle-failed'
    | 'server-closing'
    | 'write-buffer-overflow'
    | 'write-failed';

export function controlMessageText(data: RawData): string {
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return Buffer.concat(data).toString('utf8');
}

function connectionObservationContext(
    context?: CommandExecutionContext,
): ObservationContext | undefined {
    const connection = context?.connection;
    if (!connection) return undefined;
    return normalizeObservationContext({
        bootId: connection.bootId,
        clientId: connection.clientId,
        connectionId: connection.connectionId,
        serverId: connection.serverId,
    });
}

/**
 * Terminates a control socket and records why. Every abrupt `socket.terminate()` call in `control-server.ts` routes
 * through this helper instead of calling `terminate()` directly, so the set of reasons stays centralized and every
 * termination is diagnosable (see `DESKTOP_LEASE_GRACE_MS` in `control-server-desktop-lease.ts` for the sleep/wake
 * investigation this came from).
 */
export function terminateSocket(
    socket: WebSocket,
    reason: ControlSocketTerminationReason,
    logger?: ControlServerOptions['logger'],
    context?: CommandExecutionContext,
): void {
    logger?.write('info', logEventCatalog.serverCore.socketTerminated, {
        context: connectionObservationContext(context),
        fields: { reason },
    });
    socket.terminate();
}

export function writeControlMessage(
    socket: WebSocket,
    message: unknown,
    flushed?: () => void,
    logger?: ControlServerOptions['logger'],
    context?: CommandExecutionContext,
): void {
    const source = JSON.stringify(message);
    if (
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount + Buffer.byteLength(source, 'utf8') >
            CONTROL_TRANSPORT_MAX_FRAME_BYTES
    ) {
        terminateSocket(socket, 'write-buffer-overflow', logger, context);
        return;
    }
    socket.send(source, (error) => {
        if (error) terminateSocket(socket, 'write-failed', logger, context);
        else flushed?.();
    });
}

export function trackControlRequest(state: ClientState, id: string): void {
    state.inFlightRequestIds.set(id, (state.inFlightRequestIds.get(id) ?? 0) + 1);
}

export function untrackControlRequest(state: ClientState, id: string): void {
    const count = state.inFlightRequestIds.get(id);
    if (!count || count === 1) state.inFlightRequestIds.delete(id);
    else state.inFlightRequestIds.set(id, count - 1);
}

export function controlCapacityReply(id: string): CommandReplyEnvelope {
    return {
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        id,
        ok: false,
        error: toWireError(new CaxriError('CAPACITY', 'Too many requests are in flight')),
    };
}

/**
 * Limits one peer's concurrently executing control work. Terminal and file bulk traffic has its own bounded stream
 * budget and never consumes this lane.
 */
export function reserveControlRequest(state: ClientState): (() => void) | undefined {
    if (state.inFlightRequests >= MAX_IN_FLIGHT_REQUESTS) return;
    state.inFlightRequests += 1;
    let isReleased = false;
    return () => {
        if (isReleased) return;
        isReleased = true;
        if (state.closed) return;
        state.inFlightRequests -= 1;
    };
}

/**
 * Queue metadata captured before an authenticated frame enters the ordered admission lane.
 */
export interface OrderedQueueTiming {
    enqueuedAt: number;
    queueDepth: number;
}

/**
 * Ordered-queue wait above this threshold escalates the per-request log to `warn`: it is the direct signature of
 * head-of-line blocking on the per-connection command queue, which the default `info` log level must surface.
 */
const REQUEST_QUEUE_WARN_MS = 1_000;
/**
 * Queue wait plus handler time above this threshold also escalates to `warn`; the Desktop client gives up at 15s, so a
 * request this slow is about to become a user-visible timeout.
 */
const REQUEST_TOTAL_WARN_MS = 5_000;

/**
 * Structural subset of `StructuredLogger` so tests can observe per-request log writes without touching the filesystem.
 */
interface ControlRequestLogSink {
    write(level: LogRecord['level'], event: LogEventName, options?: LogWriteOptions): void;
    recordMetric?: StructuredLogger['recordMetric'];
}

function requestParameters(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/**
 * Builds only opaque IDs that are useful across process boundaries. The normalizer drops path-like or prose values, so
 * adding an unrelated command parameter cannot silently expand the diagnostics content boundary.
 */
export function observationContextForRequest(
    request: { id: string; method: string; params?: unknown },
    context: CommandExecutionContext,
): ObservationContext {
    const parameters = requestParameters(request.params);
    const connection = context.connection;
    return normalizeObservationContext({
        traceId: request.id,
        requestId: request.id,
        operationId:
            typeof parameters.operationId === 'string' ? parameters.operationId : undefined,
        projectId: typeof parameters.projectId === 'string' ? parameters.projectId : undefined,
        sessionId: typeof parameters.sessionId === 'string' ? parameters.sessionId : undefined,
        terminalId: typeof parameters.terminalId === 'string' ? parameters.terminalId : undefined,
        agentRunId:
            typeof parameters.agentRunId === 'string'
                ? parameters.agentRunId
                : typeof parameters.runId === 'string'
                  ? parameters.runId
                  : undefined,
        ...(connection && {
            bootId: connection.bootId,
            clientId: connection.clientId,
            connectionId: connection.connectionId,
            serverId: connection.serverId,
        }),
    });
}

export function observeControlRequest<T>(
    state: Pick<ClientState, 'context'>,
    request: { id: string; method: string; params?: unknown },
    action: () => T,
): T {
    return runWithObservationContext(observationContextForRequest(request, state.context), action);
}

/**
 * Records control transport latency without retaining request parameters or other user content. The ordered-queue wait
 * is the head-of-line blocking signature this log exists to surface; successful requests stay at `debug` unless their
 * method uses an aggregate-only observability path.
 */
export function logControlRequestOutcome(
    options: Pick<ControlServerOptions, 'logger' | 'requestQueueWarnMs' | 'requestTotalWarnMs'>,
    request: { id: string; method: string; params?: unknown },
    reply: CommandReplyEnvelope,
    context: CommandExecutionContext,
    startedAt: number,
    timing: OrderedQueueTiming | undefined,
): void {
    const logger = options.logger;
    if (!logger) return;
    const durationMs = performance.now() - startedAt;
    const queueMs = timing ? startedAt - timing.enqueuedAt : 0;
    const isSlow =
        queueMs > (options.requestQueueWarnMs ?? REQUEST_QUEUE_WARN_MS) ||
        queueMs + durationMs > (options.requestTotalWarnMs ?? REQUEST_TOTAL_WARN_MS);
    const fields: Record<string, string | number | boolean | null> = {
        method: request.method,
        principal: context.principal.kind,
        queueMs,
        ...(timing && { queueDepth: timing.queueDepth }),
        ...delegationRequestLogFields(
            request.method,
            request.params,
            reply.ok ? reply.result : undefined,
        ),
    };
    const observationContext = observationContextForRequest(request, context);
    if (request.method === 'logs.query')
        logger.recordMetric?.('logs.query_latency', durationMs, {
            owner: 'control',
            phase: 'execute',
            outcome: reply.ok ? 'success' : 'failure',
        });
    logger.recordMetric?.('queue.wait', queueMs, {
        owner: 'control',
        phase: 'admission',
        outcome: reply.ok ? 'success' : 'failure',
    });
    if (timing)
        logger.recordMetric?.('queue.depth', timing.queueDepth, {
            owner: 'control',
            phase: 'admission',
            outcome: reply.ok ? 'success' : 'failure',
        });
    if (reply.ok) {
        if (isSlow || shouldLogSuccessfulRequest('control', request.method))
            logger.write(isSlow ? 'warn' : 'debug', logEventCatalog.ipc.request, {
                correlationId: request.id,
                context: observationContext,
                durationMs,
                fields,
            });
        return;
    }
    if (reply.error.code === 'CANCELLED') {
        logger.write('debug', logEventCatalog.ipc.request, {
            correlationId: request.id,
            context: observationContext,
            durationMs,
            fields: { ...fields, code: reply.error.code },
        });
        return;
    }
    /**
     * `warn`, not `error`: forwarded failures are already error-logged where they fault (domain service/Desktop); this
     * entry adds the control relay view (queue wait, principal) without duplicating the error beacon.
     */
    logger.write('warn', logEventCatalog.ipc.requestFailed, {
        correlationId: request.id,
        context: observationContext,
        durationMs,
        fields: { ...fields, code: reply.error.code, error: reply.error.message },
        ...(['CAPACITY', 'INTERNAL', 'TIMEOUT', 'UNAVAILABLE'].includes(reply.error.code) && {
            failure: {
                code: reply.error.code,
                owner: 'control',
                phase: 'execute',
                reason:
                    reply.error.code === 'CAPACITY'
                        ? ('capacity' as const)
                        : reply.error.code === 'TIMEOUT'
                          ? ('timeout' as const)
                          : ('core-unavailable' as const),
                remediation:
                    reply.error.code === 'CAPACITY'
                        ? ('reduce-load' as const)
                        : reply.error.code === 'UNAVAILABLE' || reply.error.code === 'INTERNAL'
                          ? ('restart-core' as const)
                          : ('retry' as const),
                retryable: reply.error.code !== 'INTERNAL',
            },
        }),
    });
}

export function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

export function isTokenMatch(candidate: string, expected: string): boolean {
    return isSecretMatch(candidate, expected);
}

export function operatorContext(profileId: string): CommandExecutionContext {
    return {
        capabilities: [
            'desktop.window',
            'diagnostics.read',
            'agents.read',
            'agents.control',
            'agents.dispatch',
            'agents.delegate',
            'agents.delegation.access',
            'agents.grant',
            'commander',
            'events.read',
            'host.read',
            'host.stop',
            'projects.read',
            'projects.write',
            'sessions.read',
            'settings.read',
            'settings.write',
            'settings.delegation.write',
            'terminals.read',
            'terminals.steer',
        ],
        /**
         * The authenticated profile is the retry identity across short-lived CLI connections.
         */
        principal: { kind: 'human-cli', id: `human-cli:${profileId}` },
    };
}

/**
 * A long poll may outlive its credential; withhold its result after revocation or expiry.
 */
export function refreshDelegationReply(
    reply: CommandReplyEnvelope,
    context: CommandExecutionContext,
    options: Pick<ControlServerOptions, 'refreshContext'>,
): CommandReplyEnvelope {
    if (context.principal.kind !== 'delegation-client') return reply;
    try {
        options.refreshContext?.(context);
        return reply;
    } catch (error) {
        return {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: reply.id,
            ok: false,
            error: toWireError(error),
        };
    }
}

export async function executeReply(
    id: string,
    action: () => Promise<unknown>,
): Promise<CommandReplyEnvelope> {
    try {
        return {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id,
            ok: true,
            result: await action(),
        };
    } catch (error) {
        return {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id,
            ok: false,
            error: toWireError(error),
        };
    }
}

export interface ClientState {
    closed: boolean;
    commands: readonly string[];
    context: CommandExecutionContext;
    desktopLease?: DesktopLease;
    desktopReady: boolean;
    inFlightRequestIds: Map<string, number>;
    inFlightRequests: number;
    features: readonly ProtocolFeature[];
    /**
     * Set once the lease's expiry timer has already fired once without a renewal reaching the wire. While active,
     * `leaseTimer` holds the grace-window timer rather than the original lease-duration timer; see
     * `DESKTOP_LEASE_GRACE_MS` in `control-server-desktop-lease.ts`.
     */
    leaseGraceActive?: boolean;
    /**
     * The pong listener registered by `probeDesktopLiveness` while a liveness probe is outstanding. Present only during
     * the window between entering grace and the probe resolving (a pong recovers the lease) or becoming moot (a renewal
     * lands through another path, the lease is revoked, or the Host is closing): see `clearLeaseLivenessProbe`.
     */
    leaseLivenessPongListener?: () => void;
    leaseTimer?: NodeJS.Timeout;
    socket: WebSocket;
}

export interface DesktopLeaseWaiter {
    reject(error: CaxriError): void;
    resolve(lease: DesktopLease): void;
    timer: NodeJS.Timeout;
}

export interface ControlServerOptions {
    authenticateDelegation?(credential: {
        clientId: string;
        generation: number;
        token: string;
    }): CommandExecutionContext;
    adapters: CommandDispatcherOptions;
    authenticateAgent?(credential: {
        hostId: string;
        endpointId: string;
        generation: number;
        token: string;
    }): CommandExecutionContext;
    consumeDesktopTarget?(targetId: string, generation: number): Promise<DesktopTargetPayload>;
    desktopCredential: ServerDesktopCredential;
    /**
     * Test seam for exercising lease expiry without a minute-long integration test.
     */
    desktopLeaseDurationMs?: number;
    /**
     * Test seam for exercising the post-expiry grace window (see `DESKTOP_LEASE_GRACE_MS` in
     * `control-server-desktop-lease.ts`) without a real-time wait.
     */
    desktopLeaseGraceMs?: number;
    /**
     * Test seams for exercising slow-request log escalation without second-long integration tests.
     */
    requestQueueWarnMs?: number;
    requestTotalWarnMs?: number;
    invokeDesktopOperation?(request: ServerOperationRequest): Promise<unknown>;
    /**
     * Per-request outcome log: success at `debug`, failures and slow/queued requests at `warn`. PTY hot-path methods
     * stay unlogged, matching the domain operation dispatcher; successful `logs.query` reads are metric-only even when
     * slow so the reader cannot advance its own cursor.
     */
    logger?: ControlRequestLogSink;
    identity: ServerManifestIdentity;
    handleBinaryStream?: BinaryStreamControlOptions['handleClaim'];
    /**
     * Durable identity loaded from the domain persistence port. Legacy transport tests that negotiate no A4 feature may
     * omit it; production must provide it before advertising durable recovery.
     */
    protocolIdentity?: { serverId: string; stateEpoch: string };
    onClientCountChanged?(count: number, event: 'connected' | 'disconnected' | 'reset'): void;
    /**
     * A socket that had completed a handshake closed, whatever its lease state. Per-connection memory state (window
     * presence) must not outlive the socket that reported it.
     */
    onConnectionClosed?(connectionId: string): void;
    /**
     * A Desktop completed its handshake with a capability lease, as opposed to an operator, CLI, or Agent client.
     */
    onDesktopAttached?(): void;
    onDesktopUnavailable?(): void;
    /**
     * Test-only fault injector called after command execution and durable receipt storage, but before the transport can
     * write the authoritative reply. Returning `true` simulates a connection loss at that exact boundary.
     */
    shouldDropCommandReply?(
        request: LocalClientCommand['request'],
        reply: LocalServerReply['reply'],
        context: CommandExecutionContext,
    ): boolean;
    onReplyFlushed?(
        request: LocalClientCommand['request'],
        reply: LocalServerReply['reply'],
        context: CommandExecutionContext,
    ): void;
    onRequestDisconnected?(requestId: string, context: CommandExecutionContext): void;
    refreshContext?(context: CommandExecutionContext): CommandExecutionContext;
}

export function assertDurableRecoveryIdentity(options: ControlServerOptions): void {
    const isAdvertisesDurableRecovery = (options.adapters.features?.length ?? 0) > 0;
    if (isAdvertisesDurableRecovery && !options.protocolIdentity)
        throw new CaxriError(
            'INTERNAL',
            'Durable recovery features require a persisted Server identity',
        );
}

/**
 * Raw domain payloads are a Desktop-only transport; other principals use projections.
 */
export function writeDesktopControlEvent(
    currentDesktop: ClientState | undefined,
    event: ProtocolEventEnvelope | TransientServerEvent,
    logger?: ControlServerOptions['logger'],
): void {
    const message = localServerEventSchema.parse({ type: 'event', event });
    if (currentDesktop?.desktopReady)
        writeControlMessage(
            currentDesktop.socket,
            message,
            undefined,
            logger,
            currentDesktop.context,
        );
}

/**
 * Delivers a transient, body-free receipt only to the exact authenticated Agent generation.
 */
export function writeAgentControlEvent(
    clients: Iterable<ClientState>,
    endpoint: AgentEndpointReference,
    event: TransientServerEvent,
    logger?: ControlServerOptions['logger'],
): void {
    const message = localServerEventSchema.parse({ type: 'event', event });
    for (const state of clients) {
        const principal = state.context.principal;
        if (
            principal.kind === 'agent' &&
            principal.endpointId === endpoint.endpointId &&
            principal.generation === endpoint.generation
        )
            writeControlMessage(state.socket, message, undefined, logger, state.context);
    }
}
