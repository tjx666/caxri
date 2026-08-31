export interface ClosableMobileConnection {
    close(): void;
}

export const reconnectWaitForAttempt = (
    retryAttempt: number,
    delay: (attempt: number) => number,
) => (retryAttempt === 0 ? 0 : delay(retryAttempt - 1));

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
    onFailed: () => void;
}): Promise<void> => {
    try {
        const connection = await connect();
        if (!isActive()) {
            connection.close();
            return;
        }
        onConnected(connection);
    } catch {
        if (isActive()) onFailed();
    }
};
