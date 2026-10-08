import type { StateCreator, StoreApi, UseBoundStore } from 'zustand';
import { create } from 'zustand';

/**
 * Global name the read-only inspector is published under.
 */
const INSPECTOR_KEY = '__caxriStores';

/**
 * Live Renderer stores, keyed by the name their `createStore` call gave them.
 *
 * Zustand stores are module-scoped singletons that nothing attaches to `window`, so a packaged build (which ships no
 * React DevTools hook) otherwise leaves a CDP session no way to read UI state at all: walking React fibers from the DOM
 * reaches components, not the stores behind them. This registry is that handle. A store joins it when its module is
 * first imported, so the list grows as the app pulls features in rather than being complete at startup.
 */
const stores = new Map<string, StoreApi<unknown>>();

/**
 * Data-only view of a store's state. Zustand keeps actions in the same object as values, and a function survives
 * neither `JSON.stringify` nor CDP's `returnByValue`, so a snapshot that kept them would reach the debugger with keys
 * silently missing instead of visibly excluded.
 */
function inspectableState(state: unknown): Record<string, unknown> {
    if (typeof state !== 'object' || state === null) return {};
    return Object.fromEntries(
        Object.entries(state).filter(([, value]) => typeof value !== 'function'),
    );
}

/**
 * Registration order follows whichever feature module the app happened to import first, which would make two
 * consecutive reads of the same app look like different state. Sorting by name keeps a snapshot diffable.
 */
function sortedEntries(): Array<[string, StoreApi<unknown>]> {
    return [...stores].toSorted(([left], [right]) => left.localeCompare(right));
}

interface RendererStoreInspector {
    /**
     * Names of every store imported so far, sorted.
     */
    names(): string[];
    getState(name: string): Record<string, unknown> | undefined;
    snapshot(): Record<string, Record<string, unknown>>;
}

/**
 * Declared here rather than in `env.d.ts` alongside the Preload bridges: those describe contracts this file does not
 * own, while this one is published a few lines below, and keeping the shape beside `installStoreInspector` is what
 * stops the two from drifting.
 */
declare global {
    // eslint-disable-next-line vars-on-top -- `declare global { var … }` is the required ambient form
    var __caxriStores: RendererStoreInspector;
}

/**
 * Creates a Renderer store and registers it for inspection. Renderer code creates stores only through this function;
 * calling zustand's `create` directly leaves the store invisible to a live debugging session.
 */
export function createStore<T>(
    name: string,
    initializer: StateCreator<T, [], []>,
): UseBoundStore<StoreApi<T>> {
    const store = create<T>()(initializer);
    stores.set(name, store);
    return store;
}

/**
 * Publishes the inspector on `globalThis.__caxriStores`. Read-only by design: it exposes no `setState`, because a
 * debugger that can also write turns the state it was opened to explain into state nobody can reproduce.
 */
export function installStoreInspector(): void {
    const inspector: RendererStoreInspector = {
        names: () => sortedEntries().map(([name]) => name),
        getState: (name) => {
            const store = stores.get(name);
            return store && inspectableState(store.getState());
        },
        snapshot: () =>
            Object.fromEntries(
                sortedEntries().map(([name, store]) => [name, inspectableState(store.getState())]),
            ),
    };
    Object.defineProperty(globalThis, INSPECTOR_KEY, { configurable: true, value: inspector });
}
