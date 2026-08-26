export interface ExtensionHostProcessLifecycleOptions {
    disposeExtensions(): void;
    exit(exitCode: number): void;
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
    stopAfterParentDisconnect(): void;
} {
    let state: 'active' | 'prepared' | 'stopped' = 'active';

    const prepare = (): void => {
        if (state !== 'active') return;
        state = 'prepared';
        options.stopSampler();
        options.publish('stopping');
        options.disposeExtensions();
    };
    const exit = (): void => {
        if (state === 'stopped') return;
        prepare();
        state = 'stopped';
        options.publish('stopped');
        options.exit(0);
    };

    return {
        scheduleRequestedShutdown() {
            prepare();
            options.schedule(exit);
        },
        stopAfterParentDisconnect: exit,
    };
}
