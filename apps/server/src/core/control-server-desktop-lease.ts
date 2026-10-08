import { randomUUID } from 'node:crypto';

import type { DesktopLease, DesktopOperation } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    fromWireError,
    localClientDesktopReplySchema,
    localServerDesktopCommandSchema,
    localServerDesktopLeaseRevokedSchema,
} from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';
import WebSocket from 'ws';

import type { ClientState, ControlServerOptions } from './control-server-support';
import { terminateSocket, writeControlMessage } from './control-server-support';

export const DESKTOP_LEASE_MS = 60_000;
/**
 * Grace window granted once, after a Desktop lease's own expiry timer fires, before the lease is actually revoked.
 * macOS can suspend the Desktop and Server Core processes together during system sleep; every `setTimeout` in both
 * processes freezes and fires late (in arrival order) on wake. The Desktop renews its lease every 20s
 * (`DESKTOP_LEASE_RENEW_MS` in `packages/client/src/supervise/client.ts`), well inside the 60s `DESKTOP_LEASE_MS`
 * window, but a woken process's already-armed 60s timer can still fire before the woken client's 20s renew reaches the
 * wire. Matching the grace to the renew interval absorbs that race: a suspended-but-alive Desktop gets one more renew
 * interval to land its renewal, while a genuinely dead Desktop is still revoked within roughly `DESKTOP_LEASE_MS +
 * DESKTOP_LEASE_GRACE_MS` (see `renewDesktop`/`armLeaseTimer` below). Because the Desktop's own renewal is
 * fire-and-forget over a socket the Server cannot independently confirm is live, the grace window also runs a
 * server-initiated WebSocket ping/pong liveness probe (`probeDesktopLiveness`) that recovers the lease without
 * depending on that renewal reaching the wire at all.
 */
const DESKTOP_LEASE_GRACE_MS = 20_000;
const DESKTOP_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Minimal state a Desktop lease lifecycle helper needs from `ControlServer`. Kept as a structural interface (rather
 * than importing the class) so `revokeDesktop`/`renewDesktop`/`onDesktopLeaseTimerFired` stay unit-testable with a
 * plain object and so `control-server.ts` can pass `this` directly without a circular import.
 */
export interface DesktopLeaseHost {
    readonly binaryRuntime: {
        revokeConnection(connectionId: string, reason: 'stale-generation'): void;
    };
    readonly binaryStreams: {
        revokeConnection(connectionId: string, reason: 'stale-generation'): void;
    };
    readonly clients: Map<WebSocket, ClientState>;
    currentDesktop: ClientState | undefined;
    readonly options: ControlServerOptions;
    readonly pendingDesktopCommands: Map<string, PendingDesktopCommand>;
}

/**
 * Settles a Desktop's reverse reply to a Server-issued `desktop-command`, if `raw` parses as one. Returns `true` once
 * `raw` is recognized as a Desktop reply frame, even a stale one the caller should otherwise ignore, so the caller's
 * schema-detection chain can move on to the next frame kind without re-parsing.
 */
export function didHandleDesktopReply(
    host: DesktopLeaseHost,
    state: ClientState,
    raw: unknown,
): boolean {
    const parsed = localClientDesktopReplySchema.safeParse(raw);
    if (!parsed.success) return false;
    const pending = parsed.data.reply.id
        ? host.pendingDesktopCommands.get(parsed.data.reply.id)
        : undefined;
    if (!pending) return true;
    if (
        pending.state !== state ||
        host.currentDesktop !== state ||
        parsed.data.generation !== state.desktopLease?.generation
    )
        return true;
    clearTimeout(pending.timer);
    host.pendingDesktopCommands.delete(parsed.data.reply.id!);
    if (parsed.data.reply.ok) pending.resolve(parsed.data.reply.result);
    else pending.reject(fromWireError(parsed.data.reply.error));
    return true;
}

function rejectDesktopCommands(host: DesktopLeaseHost, state: ClientState): void {
    for (const [id, pending] of host.pendingDesktopCommands) {
        if (pending.state !== state) continue;
        clearTimeout(pending.timer);
        host.pendingDesktopCommands.delete(id);
        pending.reject(new CaxriError('UNAVAILABLE', 'Desktop capability lease ended'));
    }
}

/**
 * Detaches the outstanding liveness-probe pong listener, if any. Called wherever a grace window resolves or becomes
 * moot (recovery, an ordinary renewal, revocation, and Host shutdown) so a pong that arrives late on a discarded socket
 * can never reach a `state` it no longer applies to.
 */
export function clearLeaseLivenessProbe(state: ClientState): void {
    if (!state.leaseLivenessPongListener) return;
    state.socket.removeListener('pong', state.leaseLivenessPongListener);
    state.leaseLivenessPongListener = undefined;
}

export function revokeDesktop(
    host: DesktopLeaseHost,
    state: ClientState,
    shouldNotifyUnavailable = true,
    reason: 'connection-closed' | 'lease-expired' | 'replaced' = 'lease-expired',
): void {
    if (state.leaseTimer) clearTimeout(state.leaseTimer);
    state.leaseTimer = undefined;
    state.leaseGraceActive = false;
    clearLeaseLivenessProbe(state);
    const connectionId = state.context.connection?.connectionId;
    if (connectionId) {
        host.binaryStreams.revokeConnection(connectionId, 'stale-generation');
        host.binaryRuntime.revokeConnection(connectionId, 'stale-generation');
    }
    host.options.logger?.write('info', logEventCatalog.serverCore.desktopLeaseRevoked, {
        fields: {
            generation: state.desktopLease?.generation ?? null,
            reason,
            wasCurrent: host.currentDesktop === state,
        },
    });
    rejectDesktopCommands(host, state);
    host.clients.delete(state.socket);
    const wasCurrent = host.currentDesktop === state;
    if (wasCurrent) host.currentDesktop = undefined;
    host.options.onClientCountChanged?.(host.clients.size, 'disconnected');
    if (wasCurrent && shouldNotifyUnavailable) host.options.onDesktopUnavailable?.();
}

/**
 * Arms (or re-arms) the lease-expiry timer without touching the grace state. Callers that are starting a fresh lease
 * period, an initial `hello` or a successful renewal, clear `leaseGraceActive` themselves via `renewDesktop`;
 * `onDesktopLeaseTimerFired` re-arms this timer for the grace window while intentionally leaving `leaseGraceActive`
 * set.
 */
function armLeaseTimer(
    state: ClientState,
    durationMs: number,
    onFired: (state: ClientState) => void,
): void {
    if (state.leaseTimer) clearTimeout(state.leaseTimer);
    state.leaseTimer = setTimeout(() => onFired(state), durationMs);
    state.leaseTimer.unref();
}

/**
 * Sends one WebSocket ping as a server-initiated liveness check for the start of the grace window. This is a companion
 * to the Desktop's own wake-triggered `renewLeaseNow()` fast path
 * (`packages/client/src/supervise/server-connection.ts`): that call is fire-and-forget over a socket the Server cannot
 * independently confirm is still live, so a dropped or delayed renewal must not be the only way to survive the grace
 * window. `ws` answers a received ping with a pong automatically at the protocol level (no client-side code is
 * required), so a pong is evidence the peer's TCP connection and event loop are actually live, not just that
 * `readyState` still reports `OPEN` (which a half-open connection can do indefinitely). A pong that lands before the
 * grace timer fires again recovers the lease exactly like a renewal; see `clearLeaseLivenessProbe` for how a stale pong
 * (after replace, an ordinary renewal, revocation, or Host shutdown) is kept from resurrecting stale state.
 */
function probeDesktopLiveness(host: DesktopLeaseHost, state: ClientState, graceMs: number): void {
    if (state.socket.readyState !== WebSocket.OPEN) return;
    const onPong = (): void => {
        if (host.currentDesktop !== state || !state.leaseGraceActive) return;
        const generation = state.desktopLease?.generation ?? null;
        renewDesktop(host, state);
        host.options.logger?.write('info', logEventCatalog.serverCore.desktopLeaseRecovered, {
            fields: { generation, graceMs, reason: 'pong' },
        });
    };
    state.leaseLivenessPongListener = onPong;
    state.socket.once('pong', onPong);
    state.socket.ping();
}

/**
 * Handles a fired lease-expiry (or grace) timer. See `DESKTOP_LEASE_GRACE_MS` for why a bare `revokeDesktop` on first
 * fire is wrong: a suspended-then-woken Desktop looks identical, at this instant, to a genuinely dead one. The first
 * fire only starts a grace window (and, via `probeDesktopLiveness`, a server-initiated liveness check that does not
 * depend on the Desktop's own renewal reaching the wire); only a _second_ fire, with no renewal or recovering pong in
 * between, revokes the lease. `renewDesktop` clears `leaseGraceActive` on every successful renewal, so either path
 * landing during the grace window cancels the revocation entirely.
 */
export function onDesktopLeaseTimerFired(host: DesktopLeaseHost, state: ClientState): void {
    if (host.currentDesktop !== state) return;
    if (!state.leaseGraceActive) {
        state.leaseGraceActive = true;
        const graceMs = host.options.desktopLeaseGraceMs ?? DESKTOP_LEASE_GRACE_MS;
        host.options.logger?.write('info', logEventCatalog.serverCore.desktopLeaseGraceEntered, {
            fields: { generation: state.desktopLease?.generation ?? null, graceMs },
        });
        probeDesktopLiveness(host, state, graceMs);
        armLeaseTimer(state, graceMs, (armed) => onDesktopLeaseTimerFired(host, armed));
        return;
    }
    revokeDesktop(host, state, true, 'lease-expired');
}

export function renewDesktop(host: DesktopLeaseHost, state: ClientState): DesktopLease {
    const lease = state.desktopLease;
    if (!lease || host.currentDesktop !== state)
        throw new CaxriError('CONFLICT', 'Desktop capability lease is stale');
    clearLeaseLivenessProbe(state);
    const durationMs = host.options.desktopLeaseDurationMs ?? DESKTOP_LEASE_MS;
    const renewed = { ...lease, expiresAt: Date.now() + durationMs };
    state.desktopLease = renewed;
    state.leaseGraceActive = false;
    armLeaseTimer(state, durationMs, (armed) => onDesktopLeaseTimerFired(host, armed));
    return renewed;
}

/**
 * Routes one typed window operation to exactly the current Desktop generation. Named distinctly from
 * `ControlServer.invokeDesktop` (its only caller), which just forwards to this with `this.leaseHost`.
 */
export function routeDesktopOperation(
    host: DesktopLeaseHost,
    operation: DesktopOperation,
    expectedGeneration: number,
): Promise<unknown> {
    const state = host.currentDesktop;
    const lease = state?.desktopLease;
    if (!state || !lease || !state.desktopReady)
        return Promise.reject(new CaxriError('UNAVAILABLE', 'Desktop is unavailable'));
    if (lease.generation !== expectedGeneration)
        return Promise.reject(
            new CaxriError('CONFLICT', 'Desktop capability lease changed before routing'),
        );
    const id = randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            host.pendingDesktopCommands.delete(id);
            reject(new CaxriError('TIMEOUT', 'Desktop command timed out'));
        }, DESKTOP_COMMAND_TIMEOUT_MS);
        host.pendingDesktopCommands.set(id, { reject, resolve, state, timer });
        writeControlMessage(
            state.socket,
            localServerDesktopCommandSchema.parse({
                type: 'desktop-command',
                lease,
                request: { protocolVersion: CAXRI_PROTOCOL_VERSION, id, operation },
            }),
            undefined,
            host.options.logger,
            state.context,
        );
    });
}

/**
 * Ends a replaced Desktop only after its typed revocation is queued. An abrupt close would look like a recoverable
 * outage to Main and let two same-profile instances repeatedly evict each other.
 */
export function closeReplacedDesktop(
    state: ClientState,
    logger?: ControlServerOptions['logger'],
): void {
    const generation = state.desktopLease?.generation;
    if (!generation) {
        terminateSocket(state.socket, 'replaced-desktop-no-lease', logger, state.context);
        return;
    }
    if (state.socket.readyState !== WebSocket.OPEN) {
        terminateSocket(state.socket, 'replaced-desktop-socket-not-open', logger, state.context);
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
            if (error)
                terminateSocket(
                    state.socket,
                    'replaced-desktop-notify-failed',
                    logger,
                    state.context,
                );
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
