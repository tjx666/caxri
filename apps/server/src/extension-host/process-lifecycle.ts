export interface ExtensionHostProcessLifecycleOptions {
    disposeExtensions(): void;
    exit(exitCode: number): void;
    flushManifest(): Promise<void>;
    publish(state: 'stopped' | 'stopping'): void;
    schedule(callback: () => void): void;
    stopSampler(): void;
}

/**
 * Owns the child-process shutdown sequence so an explicit request and an unexpected parent disconnect cannot race into
 * duplicate disposal or leave the Extension Host orphaned after Server Core exits.
 */
export function createExtensionHostProcessLifecycle(
    options: ExtensionHostProcessLifecycleOptions,
): {
    scheduleRequestedShutdown(): void;
    stopAfterParentDisconnect(): Promise<void>;
    stopAfterProtocolViolation(): Promise<void>;
} {
    let state: 'active' | 'prepared' | 'stopped' = 'active';

    const prepare = (): void => {
        if (state !== 'active') return;
        state = 'prepared';
        options.stopSampler();
        options.publish('stopping');
        options.disposeExtensions();
    };
    const exit = async (exitCode: number): Promise<void> => {
        if (state === 'stopped') return;
        prepare();
        state = 'stopped';
        options.publish('stopped');
        /**
         * The process entrypoint exits explicitly, so pending filesystem work would otherwise be abandoned. Flush the
         * final manifest after fencing duplicate shutdown paths and before delegating to the real process exit.
         */
        await options.flushManifest();
        options.exit(exitCode);
    };

    return {
        scheduleRequestedShutdown() {
            prepare();
            options.schedule(() => {
                void exit(0);
            });
        },
        stopAfterParentDisconnect: () => exit(0),
        stopAfterProtocolViolation: () => exit(1),
    };
}
