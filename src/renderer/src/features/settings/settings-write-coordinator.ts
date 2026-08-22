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

    const cancelTimer = (kind: ConfigKind): void => {
        const timer = timers[kind];
        if (timer !== undefined) clearTimeout(timer);
        delete timers[kind];
    };

    const supersede = (kind: ConfigKind): void => {
        cancelTimer(kind);
        generations[kind] += 1;
    };

    const persistNow = (kind: ConfigKind, source: string): void => {
        cancelTimer(kind);
        const generation = ++generations[kind];
        // eslint-disable-next-line no-void -- this boundary owns and reports its asynchronous write failures.
        void (async (): Promise<void> => {
            try {
                const apply = await options.persist(kind, source);
                if (generations[kind] !== generation) return;
                apply();
                options.onApplied?.();
            } catch (error) {
                options.onError(error, kind);
            }
        })();
    };

    const schedule = (kind: ConfigKind, source: string): void => {
        cancelTimer(kind);
        timers[kind] = setTimeout(
            () => persistNow(kind, source),
            options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
        );
    };

    return { persistNow, schedule, supersede };
}
