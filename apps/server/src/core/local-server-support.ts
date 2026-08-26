import { createHash, timingSafeEqual } from 'node:crypto';

import type {
    CaxriError,
    CommandDispatcherOptions,
    CommandExecutionContext,
    CommandReplyEnvelope,
    DesktopLease,
    DesktopTargetPayload,
    HostDesktopCredential,
    HostManifestIdentity,
    LocalClientCommand,
    LocalServerReply,
    LogEventName,
    RuntimeRequest,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    getMethodSpec,
    localServerDesktopLeaseRevokedSchema,
    toWireError,
} from '@caxri/protocol';
import type { LogRecord } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import WebSocket from 'ws';

export const MAX_IN_FLIGHT_REQUESTS = 64;
/**
 * Reserve a small bounded lane so a busy Desktop cannot starve interactive PTY traffic.
 */
export const MAX_NON_TERMINAL_IN_FLIGHT_REQUESTS = 48;
export const HANDSHAKE_TIMEOUT_MS = 2_000;
export const DESKTOP_LEASE_MS = 60_000;
export const DESKTOP_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Queue metadata captured before an authenticated frame enters the ordered admission lane.
 */
export interface OrderedQueueTiming {
    enqueuedAt: number;
    queueDepth: number;
}

export function isConcurrentRead(method: string): boolean {
    return getMethodSpec(method)?.effect === 'read';
}

const RUNTIME_SCHEDULED_FILE_MUTATIONS = new Set(['files.copy', 'files.write']);

/**
 * Reads do not carry mutation ordering, while non-expiring file mutations already serialize overlapping paths inside
 * the Runtime. Both may settle outside the connection-wide ordered lane once their adapter admission is complete.
 */
export function shouldSettleOutsideOrderedLane(method: string): boolean {
    return isConcurrentRead(method) || RUNTIME_SCHEDULED_FILE_MUTATIONS.has(method);
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
interface HostRequestLogSink {
    write(
        level: LogRecord['level'],
        event: LogEventName,
        options?: Pick<LogRecord, 'correlationId' | 'durationMs' | 'fields'>,
    ): void;
}

/**
 * Records Host transport latency without retaining request parameters or other user content. The ordered-queue wait is
 * the head-of-line blocking signature this log exists to surface; successful requests stay at `debug` unless slow.
 */
export function logHostRequestOutcome(
    options: Pick<LocalHostServerOptions, 'logger' | 'requestQueueWarnMs' | 'requestTotalWarnMs'>,
    request: { id: string; method: string },
    reply: CommandReplyEnvelope,
    context: CommandExecutionContext,
    startedAt: number,
    timing: OrderedQueueTiming | undefined,
): void {
    const logger = options.logger;
    if (!logger) return;
    if (request.method === 'terminal.input' || request.method === 'terminal.resize') return;
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
    };
    if (reply.ok) {
        logger.write(isSlow ? 'warn' : 'debug', logEventCatalog.ipc.request, {
            correlationId: request.id,
            durationMs,
            fields,
        });
        return;
    }
    if (reply.error.code === 'CANCELLED') {
        logger.write('debug', logEventCatalog.ipc.request, {
            correlationId: request.id,
            durationMs,
            fields: { ...fields, code: reply.error.code },
        });
        return;
    }
    /**
     * `warn`, not `error`: forwarded failures are already error-logged where they fault (Runtime/Desktop); this entry
     * adds the Host-side relay view (queue wait, principal) without duplicating the error beacon.
     */
    logger.write('warn', logEventCatalog.ipc.requestFailed, {
        correlationId: request.id,
        durationMs,
        fields: { ...fields, code: reply.error.code, error: reply.error.message },
    });
}

export function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

export function isTokenMatch(candidate: string, expected: string): boolean {
    const candidateDigest = createHash('sha256').update(candidate).digest();
    const expectedDigest = createHash('sha256').update(expected).digest();
    return timingSafeEqual(candidateDigest, expectedDigest);
}

export function operatorContext(profileId: string): CommandExecutionContext {
    return {
        capabilities: [
            'desktop.window',
            'diagnostics.read',
            'agents.read',
            'agents.control',
            'agents.dispatch',
            'agents.grant',
            'events.read',
            'host.read',
            'host.stop',
            'projects.read',
            'sessions.read',
            'settings.read',
            'settings.write',
            'terminals.read',
            'terminals.steer',
        ],
        /**
         * The authenticated profile is the retry identity across short-lived CLI connections.
         */
        principal: { kind: 'human-cli', id: `human-cli:${profileId}` },
    };
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
    context: CommandExecutionContext;
    desktopLease?: DesktopLease;
    desktopReady: boolean;
    inFlightRequestIds: Map<string, number>;
    inFlightRequests: number;
    inFlightTerminalRequests: number;
    leaseTimer?: NodeJS.Timeout;
    socket: WebSocket;
}

/**
 * Ends a replaced Desktop only after its typed revocation is queued. An abrupt close would look like a recoverable
 * outage to Main and let two same-profile instances repeatedly evict each other.
 */
export function closeReplacedDesktop(state: ClientState): void {
    const generation = state.desktopLease?.generation;
    if (!generation) {
        state.socket.terminate();
        return;
    }
    if (state.socket.readyState !== WebSocket.OPEN) {
        state.socket.terminate();
        return;
    }
    state.socket.send(
        JSON.stringify(
            localServerDesktopLeaseRevokedSchema.parse({
                type: 'desktop-lease.revoked',
                generation,
                reason: 'replaced',
            }),
        ),
        (error) => {
            if (error) state.socket.terminate();
            else state.socket.close(1000);
        },
    );
}

export interface PendingDesktopCommand {
    reject(error: CaxriError): void;
    resolve(value: unknown): void;
    state: ClientState;
    timer: NodeJS.Timeout;
}

export interface DesktopLeaseWaiter {
    reject(error: CaxriError): void;
    resolve(lease: DesktopLease): void;
    timer: NodeJS.Timeout;
}

export interface LocalHostServerOptions {
    adapters: CommandDispatcherOptions;
    authenticateAgent?(credential: {
        hostId: string;
        endpointId: string;
        generation: number;
        token: string;
    }): CommandExecutionContext;
    consumeDesktopTarget?(targetId: string, generation: number): Promise<DesktopTargetPayload>;
    desktopCredential: HostDesktopCredential;
    /**
     * Test seam for exercising lease expiry without a minute-long integration test.
     */
    desktopLeaseDurationMs?: number;
    /**
     * Test seams for exercising slow-request log escalation without second-long integration tests.
     */
    requestQueueWarnMs?: number;
    requestTotalWarnMs?: number;
    invokeDesktopRuntime?(request: RuntimeRequest): Promise<unknown>;
    /**
     * Per-request outcome log: success at `debug`, failures and slow/queued requests at `warn`. PTY hot-path methods
     * stay unlogged, matching the Runtime dispatcher.
     */
    logger?: HostRequestLogSink;
    identity: HostManifestIdentity;
    onClientCountChanged?(count: number): void;
    onDesktopUnavailable?(): void;
    onReplyFlushed?(
        request: LocalClientCommand['request'],
        reply: LocalServerReply['reply'],
        context: CommandExecutionContext,
    ): void;
    onRequestDisconnected?(requestId: string, context: CommandExecutionContext): void;
    refreshContext?(context: CommandExecutionContext): CommandExecutionContext;
}
