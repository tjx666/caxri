import type { ConfigKind } from './config-edit';

export interface SettingsWriteCoordinatorOptions {
    appliedSource?(kind: ConfigKind): string;
    currentSource?(kind: ConfigKind): string;
    debounceMs?: number;
    onApplied?(): void;
    onError(error: unknown, kind: ConfigKind): void;
    onExternalChange?(kind: ConfigKind, payload: ConfigChangedPayload): void;
    onOwnEcho?(kind: ConfigKind, source: string, isCurrentDraft: boolean): void;
    /**
     * Persists the source, then returns the state mutation that may run only if this generation is still current.
     */
    persist(kind: ConfigKind, source: string): Promise<() => void>;
    /**
     * Re-reads the Runtime's authoritative state after recovery or an indeterminate write result.
     */
    read?(kind: ConfigKind): Promise<() => void>;
}

interface ConfigChangedPayload {
    source: string;
    error?: string;
}

export interface SettingsWriteCoordinator {
    handleChanged: (kind: ConfigKind, payload: ConfigChangedPayload) => void;
    /**
     * Consumes one matching source from a local write whose Runtime change event can arrive before the request
     * resolves.
     */
    isOwnEcho: (kind: ConfigKind, source: string) => boolean;
    persistNow: (kind: ConfigKind, source: string) => void;
    reconcile: (kind: ConfigKind) => Promise<void>;
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
    const reconciliationGenerations: Record<ConfigKind, number> = {
        settings: 0,
        keybindings: 0,
        theme: 0,
    };
    const inFlightSources: Record<ConfigKind, Map<string, number[]>> = {
        settings: new Map(),
        keybindings: new Map(),
        theme: new Map(),
    };

    /**
     * Runtime broadcasts a successful write before resolving its request. Recording the source before persistence
     * starts lets the Renderer recognize that event without changing IPC.
     */
    const recordOwnWrite = (kind: ConfigKind, source: string, generation: number): void => {
        const sources = inFlightSources[kind];
        sources.set(source, [...(sources.get(source) ?? []), generation]);
    };

    const hasRemovedOwnWrite = (kind: ConfigKind, source: string): boolean => {
        const sources = inFlightSources[kind];
        const generationsForSource = sources.get(source);
        if (!generationsForSource?.length) return false;
        const [, ...remaining] = generationsForSource;
        if (remaining.length === 0) sources.delete(source);
        else sources.set(source, remaining);
        return true;
    };

    const retireOwnWrite = (kind: ConfigKind, source: string, generation: number): void => {
        const sources = inFlightSources[kind];
        const remaining = sources.get(source)?.filter((candidate) => candidate !== generation);
        if (!remaining?.length) sources.delete(source);
        else sources.set(source, remaining);
    };

    const retireOwnWritesThrough = (kind: ConfigKind, generation: number): void => {
        const sources = inFlightSources[kind];
        for (const [source, generationsForSource] of sources) {
            const remaining = generationsForSource.filter((candidate) => candidate > generation);
            if (remaining.length === 0) sources.delete(source);
            else sources.set(source, remaining);
        }
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

    /**
     * Snapshot recovery and error-bearing events make existing source markers untrustworthy. Keep them until the
     * authoritative read settles so a delayed local echo cannot masquerade as an external edit and cancel a newer
     * draft, then retire only markers that existed when recovery began.
     */
    const reconcile = async (kind: ConfigKind): Promise<void> => {
        const generation = ++generations[kind];
        const reconciliationGeneration = ++reconciliationGenerations[kind];
        if (!options.read) {
            retireOwnWritesThrough(kind, generation);
            return;
        }
        try {
            const apply = await options.read(kind);
            if (
                generations[kind] === generation &&
                reconciliationGenerations[kind] === reconciliationGeneration
            )
                apply();
        } catch (error) {
            options.onError(error, kind);
        } finally {
            retireOwnWritesThrough(kind, generation);
        }
    };

    /**
     * A failed request can still have committed in Runtime. Keep its token recognizable while the authoritative read is
     * pending, then retire only that request so an older failure never invalidates a newer in-flight write.
     */
    const reconcileUncertainWrite = async (
        kind: ConfigKind,
        source: string,
        writeGeneration: number,
    ): Promise<void> => {
        if (!options.read) {
            retireOwnWrite(kind, source, writeGeneration);
            return;
        }
        const generation = generations[kind];
        const reconciliationGeneration = ++reconciliationGenerations[kind];
        try {
            const apply = await options.read(kind);
            if (
                generations[kind] === generation &&
                reconciliationGenerations[kind] === reconciliationGeneration
            )
                apply();
        } catch (error) {
            options.onError(error, kind);
        } finally {
            retireOwnWrite(kind, source, writeGeneration);
        }
    };

    const handleChanged = (kind: ConfigKind, payload: ConfigChangedPayload): void => {
        if (payload.error) {
            options.onExternalChange?.(kind, payload);
            // eslint-disable-next-line no-void -- the synchronous event boundary reports read failures through onError.
            void reconcile(kind);
            return;
        }
        if (isOwnEcho(kind, payload.source)) {
            // The echo proves a write committed after any already-issued read. Invalidate only those reads; the write
            // response still owns its normal apply path and may carry derived data such as keybinding conflicts.
            reconciliationGenerations[kind] += 1;
            options.onOwnEcho?.(
                kind,
                payload.source,
                payload.source === options.currentSource?.(kind),
            );
            return;
        }
        if (payload.source === options.appliedSource?.(kind)) return;
        supersede(kind);
        options.onExternalChange?.(kind, payload);
    };

    const persistNow = (kind: ConfigKind, source: string): void => {
        cancelTimer(kind);
        const generation = ++generations[kind];
        recordOwnWrite(kind, source, generation);
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
                 * post-write Settings reconciliation fails). The result is therefore indeterminate: report the request
                 * error, then re-read that ConfigKind and retire only this write's now-untrustworthy echo marker.
                 */
                options.onError(error, kind);
                await reconcileUncertainWrite(kind, source, generation);
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

    return { handleChanged, isOwnEcho, persistNow, reconcile, schedule, supersede };
}
