export interface RuntimeParentPort {
    connected(): boolean;
    onDisconnect?(listener: () => void): void;
    onMessage(listener: (message: unknown) => void): void;
    send(message: unknown): void;
}

interface ElectronParentPortLike {
    on(event: 'message', listener: (event: { data: unknown }) => void): void;
    postMessage(message: unknown): void;
}

interface RuntimeProcessLike {
    connected?: boolean;
    on(event: 'message', listener: (message: unknown) => void): void;
    parentPort?: ElectronParentPortLike;
    send?(message: unknown): boolean;
}

interface RuntimeDisconnectSource {
    on(event: 'disconnect', listener: () => void): void;
}

/**
 * Supports both the legacy Electron utility-process parent port and the Host-owned Node IPC child. The Runtime
 * application remains unaware of which supervisor transport owns it.
 */
export function createRuntimeParentPort(source: RuntimeProcessLike): RuntimeParentPort {
    if (source.parentPort) {
        return {
            connected: () => true,
            onMessage: (listener) => source.parentPort!.on('message', ({ data }) => listener(data)),
            send: (message) => source.parentPort!.postMessage(message),
        };
    }
    if (source.send) {
        return {
            connected: () => source.connected !== false,
            onDisconnect: (listener) =>
                (source as RuntimeProcessLike & RuntimeDisconnectSource).on('disconnect', listener),
            onMessage: (listener) => source.on('message', listener),
            send: (message) => {
                if (source.connected === false)
                    throw new Error('Runtime parent IPC channel is unavailable');
                /**
                 * Node returns `false` for a connected channel when its IPC backlog crosses the backpressure threshold;
                 * the message is still queued and must not crash Runtime.
                 */
                source.send!(message);
            },
        };
    }
    throw new Error('Caxri Runtime requires an authenticated supervisor IPC channel');
}
