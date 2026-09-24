export interface ClosableMobileConnection {
    close(): void;
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

export const reconnectWaitForAttempt = (
    retryAttempt: number,
    delay: (attempt: number) => number,
) => (retryAttempt === 0 ? 0 : delay(retryAttempt - 1));

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
            connection.close();
            return;
        }
        onConnected(connection);
    } catch (error) {
        if (isActive()) onFailed(error);
    }
};
