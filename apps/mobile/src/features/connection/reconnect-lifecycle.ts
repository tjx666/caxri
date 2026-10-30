import type { MobileClientCloseReason } from '@caxri/mobile-transport';

export interface ClosableMobileConnection {
    close(reason: MobileClientCloseReason): void;
}

export interface TerminableMobileConnection<Reason> extends ClosableMobileConnection {
    onTermination(listener: (reason: Reason) => void): () => void;
}

/**
 * Captures a connection that had already terminated before its owner could subscribe. This closes the attach-before-
 * subscribe window without delaying normal terminal callbacks or coupling the transport to React state.
 */
export const observeMobileConnectionTermination = <Reason>(
    connection: TerminableMobileConnection<Reason>,
    onTerminated: (reason: Reason) => void,
): { didTerminate: boolean; unsubscribe: () => void } => {
    let didTerminate = false;
    const unsubscribe = connection.onTermination((reason) => {
        didTerminate = true;
        onTerminated(reason);
    });
    return { didTerminate, unsubscribe };
};

/**
 * What the owner does when its connection ended: `revoked` forgets the pairing, `route-upgrade` reconnects at once
 * while the status stays "connected" (the phone is only changing route), and anything else is a lost connection that
 * shows as stale and backs off.
 */
export const terminationOutcome = (
    reason: 'disconnected' | 'revoked' | 'route-upgrade',
): { kind: 'lost' | 'revoked' | 'route-upgrade' } => ({
    kind: reason === 'disconnected' ? 'lost' : reason,
});

export const reconnectWaitForAttempt = (
    retryAttempt: number,
    delay: (attempt: number) => number,
) => (retryAttempt === 0 ? 0 : delay(retryAttempt - 1));

/**
 * How long a connection must have lived before its end counts as a fresh failure rather than part of a loop.
 */
export const STABLE_CONNECTION_MS = 10_000;

/**
 * The reconnect attempt after an established connection ended. A stable connection reconnects at once, but one that
 * ended soon after it was adopted keeps backing off: a screen that closes the connection on open would otherwise
 * reconnect without delay until the Server's per-source admission limit locks the phone out for about a minute.
 */
export const retryAttemptAfterConnectionEnded = (
    retryAttempt: number,
    connectedAt: number,
    now: number,
): number => (now - connectedAt >= STABLE_CONNECTION_MS ? 0 : retryAttempt + 1);

export const foregroundRecoveryAction = ({
    backgroundedAt,
    hasConnection,
    now,
}: {
    backgroundedAt: number | null;
    hasConnection: boolean;
    now: number;
}): 'probe' | 'reconnect' =>
    hasConnection && (backgroundedAt === null || now - backgroundedAt <= 10_000)
        ? 'probe'
        : 'reconnect';

/**
 * Resolves one reconnect attempt without depending on React. A connection that arrives after effect cleanup is closed
 * immediately, preventing an obsolete screen lifecycle from leaking or adopting a live socket.
 */
export const runReconnectAttempt = async <Connection extends ClosableMobileConnection>({
    connect,
    isActive,
    onConnected,
    onFailed,
}: {
    connect: () => Promise<Connection>;
    isActive: () => boolean;
    onConnected: (connection: Connection) => void;
    onFailed: (error: unknown) => void;
}): Promise<void> => {
    try {
        const connection = await connect();
        if (!isActive()) {
            connection.close('superseded');
            return;
        }
        onConnected(connection);
    } catch (error) {
        if (isActive()) onFailed(error);
    }
};

/**
 * A connection that missed a probe or read deadline is suspect, not dead: a computer whose Server is starved of CPU
 * answers seconds late over a socket that still works, and dropping it costs a full handshake on that same overloaded
 * Server. Dials a replacement while the suspect keeps serving; any authenticated frame on the suspect before the
 * replacement is ready proves it alive and discards the replacement. A failed replacement also keeps the suspect, whose
 * heartbeat still ends it if the path is really gone. Orca's mobile client likewise counts any authenticated inbound
 * frame as proof of life.
 */
export const hedgeSuspectConnection = async <Connection extends ClosableMobileConnection>({
    connect,
    isCurrent,
    onReplaced,
    suspect,
}: {
    connect: () => Promise<Connection>;
    /**
     * Whether the suspect still owns the phone's connection slot, or left it empty by ending meanwhile.
     */
    isCurrent: () => boolean;
    onReplaced: (connection: Connection) => void;
    suspect: { onObservation(listener: () => void): () => void };
}): Promise<'kept' | 'replaced'> => {
    const observed = { isAlive: false };
    const stopObserving = suspect.onObservation(() => {
        observed.isAlive = true;
    });
    try {
        const replacement = await connect();
        if (observed.isAlive || !isCurrent()) {
            replacement.close('superseded');
            return 'kept';
        }
        onReplaced(replacement);
        return 'replaced';
    } catch {
        return 'kept';
    } finally {
        stopObserving();
    }
};

/**
 * Counts reconnect attempts that are still dialing, so a network hint for the same network can leave them alone
 * (`network-recovery.ts`).
 */
export const countWhileDialing = async <Result>(
    dialing: { current: number },
    dial: () => Promise<Result>,
): Promise<Result> => {
    dialing.current += 1;
    try {
        return await dial();
    } finally {
        dialing.current -= 1;
    }
};
