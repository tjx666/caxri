import type { ConfigKind } from './config-edit';

export interface SettingsWriteCoordinatorOptions {
    debounceMs?: number;
    onApplied?(): void;
    onError(error: unknown, kind: ConfigKind): void;
    /**
     * Persists the source, then returns the state mutation that may run only if this generation is still current.
     */
    persist(kind: ConfigKind, source: string): Promise<() => void>;
}

export interface SettingsWriteCoordinator {
    /**
     * Consumes one matching source from a local write whose Runtime change event can arrive before the request
     * resolves.
     */
    isOwnEcho: (kind: ConfigKind, source: string) => boolean;
    persistNow: (kind: ConfigKind, source: string) => void;
    schedule: (kind: ConfigKind, source: string) => void;
    supersede: (kind: ConfigKind) => void;
}

const DEFAULT_DEBOUNCE_MS = 300;

export function createSettingsWriteCoordinator(
    options: SettingsWriteCoordinatorOptions,
): SettingsWriteCoordinator {
    const timers: Partial<Record<ConfigKind, number>> = {};
    const generations: Record<ConfigKind, number> = {
        settings: 0,
        keybindings: 0,
        theme: 0,
    };
    const inFlightSources: Record<ConfigKind, Map<string, number>> = {
        settings: new Map(),
        keybindings: new Map(),
        theme: new Map(),
    };

    /**
     * Runtime broadcasts a successful write before resolving its request. Recording the source before persistence
     * starts lets the Renderer recognize that event without changing IPC.
     */
    const recordOwnWrite = (kind: ConfigKind, source: string): void => {
        const sources = inFlightSources[kind];
        sources.set(source, (sources.get(source) ?? 0) + 1);
    };

    const hasRemovedOwnWrite = (kind: ConfigKind, source: string): boolean => {
        const sources = inFlightSources[kind];
        const count = sources.get(source);
        if (count === undefined) return false;
        if (count === 1) sources.delete(source);
        else sources.set(source, count - 1);
        return true;
    };

    const isOwnEcho = (kind: ConfigKind, source: string): boolean =>
        hasRemovedOwnWrite(kind, source);

    const cancelTimer = (kind: ConfigKind): void => {
        const timer = timers[kind];
        if (timer !== undefined) clearTimeout(timer);
        delete timers[kind];
    };

    /**
     * A genuine external change becomes authoritative immediately. Any older local write that finishes later must be
     * handled as a new external state so the Renderer converges to disk.
     */
    const supersede = (kind: ConfigKind): void => {
        cancelTimer(kind);
        inFlightSources[kind].clear();
        generations[kind] += 1;
    };

    const persistNow = (kind: ConfigKind, source: string): void => {
        cancelTimer(kind);
        const generation = ++generations[kind];
        recordOwnWrite(kind, source);
        // eslint-disable-next-line no-void -- this boundary owns and reports its asynchronous write failures.
        void (async (): Promise<void> => {
            try {
                const apply = await options.persist(kind, source);
                if (generations[kind] !== generation) return;
                apply();
                options.onApplied?.();
            } catch (error) {
                /**
                 * A request can reject after Runtime has committed and broadcast the write (for example, when
                 * post-write Settings reconciliation fails). Keep the marker until that possibly delayed event arrives,
                 * otherwise recovery can misclassify the echo as external and cancel the next draft.
                 */
                options.onError(error, kind);
            }
        })();
    };

    /**
     * A pending draft owns the visible state immediately, before its debounce expires. Invalidating an older response
     * now prevents that response from making the control snap back while waiting.
     */
    const schedule = (kind: ConfigKind, source: string): void => {
        cancelTimer(kind);
        generations[kind] += 1;
        timers[kind] = setTimeout(
            () => persistNow(kind, source),
            options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
        );
    };

    return { isOwnEcho, persistNow, schedule, supersede };
}
