import { useCallback, useSyncExternalStore } from 'react';

import { notifyListeners } from './notify-listeners';

/**
 * Per-Session view state kept outside component state. The Session body keys its segment by tab, so switching tabs (or
 * Android Back tearing the tab down) unmounts the Files and Changes views; state held in a hook would drop an unsaved
 * edit and the open folder with it. A value equal to `initial` is not stored, so an untouched Session costs nothing.
 */
export const createSessionViewStore = <State>(initial: State) => {
    const states = new Map<string, State>();
    const listeners = new Set<() => void>();
    const get = (key: string): State => states.get(key) ?? initial;
    const set = (key: string, next: State): void => {
        if (Object.is(next, get(key))) return;
        if (Object.is(next, initial)) states.delete(key);
        else states.set(key, next);
        notifyListeners(listeners, undefined);
    };
    return {
        get,
        set,
        /**
         * Applies `change` to the current value, so consecutive edits within one event compose.
         */
        update: (key: string, change: (current: State) => State): void =>
            set(key, change(get(key))),
        subscribe: (listener: () => void): (() => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};

export type SessionViewStore<State> = ReturnType<typeof createSessionViewStore<State>>;

/**
 * Reads one Session's value from `store` and returns it with a functional updater.
 */
export const useSessionViewState = <State>(
    store: SessionViewStore<State>,
    key: string,
): [State, (change: (current: State) => State) => void] => {
    const state = useSyncExternalStore(
        store.subscribe,
        () => store.get(key),
        () => store.get(key),
    );
    const update = useCallback(
        (change: (current: State) => State) => store.update(key, change),
        [key, store],
    );
    return [state, update];
};
