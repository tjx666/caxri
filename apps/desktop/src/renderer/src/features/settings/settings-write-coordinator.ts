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
     * Re-reads the Server's authoritative state after recovery or an indeterminate write result.
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
     * Consumes one matching source from a local write whose Server change event can arrive before the request resolves.
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
    const reconciliationsInFlight: Record<ConfigKind, number> = {
        settings: 0,
        keybindings: 0,
        theme: 0,
    };
    const followUpReconciliation: Record<ConfigKind, boolean> = {
        settings: false,
        keybindings: false,
        theme: false,
    };
    const inFlightSources: Record<ConfigKind, Map<string, number[]>> = {
        settings: new Map(),
        keybindings: new Map(),
        theme: new Map(),
    };
    const untrustedSources: Record<ConfigKind, Map<string, number>> = {
        settings: new Map(),
        keybindings: new Map(),
        theme: new Map(),
    };

    /**
     * Server broadcasts a successful write before resolving its request. Recording the source before persistence starts
     * lets the Renderer recognize that event without changing IPC.
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

    /**
     * A retired token remains a one-shot ambiguity marker. Its eventual event may be either a delayed local echo or an
     * external editor restoring identical text, so matching it must re-read Server instead of applying either guess.
     */
    const retireOwnWritesThrough = (kind: ConfigKind, generation: number): void => {
        const sources = inFlightSources[kind];
        for (const [source, generationsForSource] of sources) {
            const remaining = generationsForSource.filter((candidate) => candidate > generation);
            const retiredCount = generationsForSource.length - remaining.length;
            if (retiredCount > 0) {
                const retiredSources = untrustedSources[kind];
                retiredSources.set(source, (retiredSources.get(source) ?? 0) + retiredCount);
            }
            if (remaining.length === 0) sources.delete(source);
            else sources.set(source, remaining);
        }
    };

    const hasRemovedUntrustedSource = (kind: ConfigKind, source: string): boolean => {
        const sources = untrustedSources[kind];
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
        retireOwnWritesThrough(kind, generations[kind]);
        generations[kind] += 1;
    };

    const shouldRunFollowUpReconciliation = (kind: ConfigKind): boolean => {
        reconciliationsInFlight[kind] -= 1;
        if (reconciliationsInFlight[kind] !== 0 || !followUpReconciliation[kind]) return false;
        followUpReconciliation[kind] = false;
        return true;
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
        reconciliationsInFlight[kind] += 1;
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
            if (shouldRunFollowUpReconciliation(kind)) {
                void reconcile(kind);
            }
        }
    };

    /**
     * A failed request can still have committed in Server. Keep its token recognizable while the authoritative read is
     * pending, then retire every token at or before that request. Any later matching event is ambiguous and converges
     * through another read, while tokens from genuinely newer writes remain recognizable.
     */
    const reconcileUncertainWrite = async (
        kind: ConfigKind,
        writeGeneration: number,
    ): Promise<void> => {
        if (!options.read) {
            retireOwnWritesThrough(kind, writeGeneration);
            return;
        }
        const generation = generations[kind];
        const reconciliationGeneration = ++reconciliationGenerations[kind];
        reconciliationsInFlight[kind] += 1;
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
            retireOwnWritesThrough(kind, writeGeneration);
            if (shouldRunFollowUpReconciliation(kind)) {
                void reconcile(kind);
            }
        }
    };

    const handleChanged = (kind: ConfigKind, payload: ConfigChangedPayload): void => {
        if (payload.error) {
            options.onExternalChange?.(kind, payload);
            void reconcile(kind);
            return;
        }
        if (isOwnEcho(kind, payload.source)) {
            if (reconciliationsInFlight[kind] > 0) {
                /**
                 * A read issued before this echo can contain a stale snapshot. Invalidate it and queue one fresh read
                 * after every current read settles; the write response still keeps its independent apply path.
                 */
                reconciliationGenerations[kind] += 1;
                followUpReconciliation[kind] = true;
            }
            options.onOwnEcho?.(
                kind,
                payload.source,
                payload.source === options.currentSource?.(kind),
            );
            return;
        }
        if (hasRemovedUntrustedSource(kind, payload.source)) {
            void reconcile(kind);
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
        void (async (): Promise<void> => {
            try {
                const apply = await options.persist(kind, source);
                if (generations[kind] !== generation) return;
                apply();
                options.onApplied?.();
            } catch (error) {
                /**
                 * A request can reject after Server has committed and broadcast the write (for example, when post-write
                 * Settings reconciliation fails). The result is therefore indeterminate: report the request error, then
                 * re-read that ConfigKind and retire every marker no newer than this write.
                 */
                options.onError(error, kind);
                await reconcileUncertainWrite(kind, generation);
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
