import { logEventCatalog } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import type { DesktopLeaseHost } from '../control-server-desktop-lease';
import { clearLeaseLivenessProbe, onDesktopLeaseTimerFired } from '../control-server-desktop-lease';
import type { ClientState, ControlServerOptions } from '../control-server-support';
import { operatorContext } from '../control-server-support';

/**
 * Stands in for the `ws` `WebSocket` instance during the lease-expiry timer, `ping`, `pong` sequence. `ws` answers a
 * real received ping with a pong automatically at the protocol level (see `probeDesktopLiveness` in
 * `control-server-desktop-lease.ts`), so this fixture only needs to record `ping()` calls and let the test decide when
 * (or whether) a pong "arrives" via `emitPong()`.
 */
interface FakeDesktopSocket {
    readonly OPEN: 1;
    readonly readyState: number;
    once: (event: 'pong', listener: () => void) => void;
    ping: () => void;
    removeListener: (event: 'pong', listener: () => void) => void;
    emitPong(): void;
}

function createFakeDesktopSocket(readyState: 0 | 1 = 1): FakeDesktopSocket {
    let pongListener: (() => void) | undefined;
    return {
        OPEN: 1,
        readyState,
        once: vi.fn((event: string, listener: () => void) => {
            if (event === 'pong') pongListener = listener;
        }),
        ping: vi.fn(),
        removeListener: vi.fn((event: string, listener: () => void) => {
            if (event === 'pong' && pongListener === listener) pongListener = undefined;
        }),
        emitPong(): void {
            const listener = pongListener;
            pongListener = undefined;
            listener?.();
        },
    };
}

function createLeaseState(overrides: Partial<ClientState> = {}): ClientState {
    return {
        closed: false,
        commands: [],
        context: operatorContext('profile-1'),
        desktopLease: { desktopId: 'desktop-1', generation: 1, expiresAt: Date.now() + 1000 },
        desktopReady: true,
        inFlightRequestIds: new Map(),
        inFlightRequests: 0,
        features: [],
        socket: createFakeDesktopSocket() as unknown as WebSocket,
        ...overrides,
    };
}

function createHost(
    state: ClientState,
    optionsOverride: Partial<ControlServerOptions> = {},
): DesktopLeaseHost {
    const clients = new Map<WebSocket, ClientState>([[state.socket, state]]);
    return {
        binaryRuntime: { revokeConnection: vi.fn() },
        binaryStreams: { revokeConnection: vi.fn() },
        clients,
        currentDesktop: state,
        options: {
            adapters: {} as ControlServerOptions['adapters'],
            desktopCredential: {} as ControlServerOptions['desktopCredential'],
            identity: {} as ControlServerOptions['identity'],
            logger: { write: vi.fn() },
            ...optionsOverride,
        },
        pendingDesktopCommands: new Map(),
    };
}

function fakeSocketOf(state: ClientState): FakeDesktopSocket {
    return state.socket as unknown as FakeDesktopSocket;
}

afterEach(() => {
    vi.useRealTimers();
});

/**
 * Regression coverage for https://github.com/tjx666/caxri/issues/553's follow-up: the Desktop's own wake-triggered
 * `renewLeaseNow()` (`packages/client/src/supervise/server-connection.ts`) is fire-and-forget over a socket the Server
 * cannot independently confirm is live, so the grace window must not depend on that renewal reaching the wire at all.
 * These tests exercise `probeDesktopLiveness`'s ping/pong recovery directly against the timer state machine.
 */
describe('onDesktopLeaseTimerFired liveness probe', () => {
    it('recovers the lease from a pong that lands before the grace window elapses', () => {
        vi.useFakeTimers();
        const state = createLeaseState();
        const originalExpiresAt = state.desktopLease!.expiresAt;
        // Captured separately from `host.options.logger.write` so the assertion below does not read an unbound
        // method off a typed interface (`@typescript-eslint/unbound-method`).
        const write = vi.fn();
        const host = createHost(state, { desktopLeaseGraceMs: 200, logger: { write } });

        onDesktopLeaseTimerFired(host, state);
        expect(state.leaseGraceActive).toBe(true);
        expect(fakeSocketOf(state).ping).toHaveBeenCalledTimes(1);

        fakeSocketOf(state).emitPong();

        expect(state.leaseGraceActive).toBe(false);
        expect(state.desktopLease!.expiresAt).toBeGreaterThan(originalExpiresAt);
        expect(write).toHaveBeenCalledWith(
            'info',
            logEventCatalog.serverCore.desktopLeaseRecovered,
            {
                fields: { generation: 1, graceMs: 200, reason: 'pong' },
            },
        );

        // The recovered lease must survive past the original grace window; only the pong-driven renewal explains this.
        vi.advanceTimersByTime(500);
        expect(host.currentDesktop).toBe(state);
    });

    it('revokes the lease when no pong arrives before the grace window elapses', () => {
        vi.useFakeTimers();
        const state = createLeaseState();
        const onDesktopUnavailable = vi.fn();
        const host = createHost(state, { desktopLeaseGraceMs: 200, onDesktopUnavailable });

        onDesktopLeaseTimerFired(host, state);
        vi.advanceTimersByTime(200);

        expect(onDesktopUnavailable).toHaveBeenCalledTimes(1);
        expect(host.currentDesktop).toBeUndefined();
    });

    it('ignores a pong that arrives after the Desktop was replaced', () => {
        vi.useFakeTimers();
        const state = createLeaseState();
        const host = createHost(state, { desktopLeaseGraceMs: 200 });

        onDesktopLeaseTimerFired(host, state);
        const replacement = createLeaseState({
            desktopLease: { desktopId: 'desktop-2', generation: 2, expiresAt: Date.now() + 1000 },
        });
        host.currentDesktop = replacement;

        fakeSocketOf(state).emitPong();

        expect(host.currentDesktop).toBe(replacement);
        // The stale pong must not resurrect the replaced `state`: grace stays active and its lease is untouched.
        expect(state.leaseGraceActive).toBe(true);
        expect(state.desktopLease?.generation).toBe(1);
    });

    it('detaches the pong listener on dispose so a later pong is inert', () => {
        vi.useFakeTimers();
        const state = createLeaseState();
        const host = createHost(state, { desktopLeaseGraceMs: 200 });

        onDesktopLeaseTimerFired(host, state);
        expect(state.leaseLivenessPongListener).toBeDefined();

        // Mirrors what `ControlServer.close()` does for the current Desktop mid-grace.
        clearLeaseLivenessProbe(state);
        expect(state.leaseLivenessPongListener).toBeUndefined();
        expect(fakeSocketOf(state).removeListener).toHaveBeenCalledTimes(1);

        fakeSocketOf(state).emitPong();

        expect(state.leaseGraceActive).toBe(true);
        expect(state.desktopLease?.generation).toBe(1);
    });
});
