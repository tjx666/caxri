import { useSyncExternalStore } from 'react';

import type { MonacoDiffEditor } from '@monaco-editor/react';

export type DiffNavigationDirection = 'next' | 'previous';

/**
 * The navigation boundary also accepts a one-hunk, single-sided code editor.
 */
export type DiffEditorActions = Pick<
    MonacoDiffEditor,
    'getLineChanges' | 'goToDiff' | 'onDidUpdateDiff'
>;

export interface DiffEditorActionState {
    hasChanges: boolean;
}

interface DiffEditorRegistration {
    disposeDiffListener: () => void;
    editor: DiffEditorActions;
    hasChanges: boolean;
}

const emptyActionState: DiffEditorActionState = { hasChanges: false };
const registrations = new Map<string, DiffEditorRegistration>();
const snapshots = new Map<string, DiffEditorActionState>();
const subscribers = new Map<string, Set<() => void>>();

function registrationKey(tabPath: string, paneId: string): string {
    return `${paneId}\u{0}${tabPath}`;
}

function notify(key: string): void {
    const listeners = subscribers.get(key);
    if (!listeners) return;
    for (const listener of listeners) listener();
}

function updateSnapshot(key: string, registration: DiffEditorRegistration): void {
    if (registrations.get(key) !== registration) return;
    const hasChanges = (registration.editor.getLineChanges()?.length ?? 0) > 0;
    const previous = snapshots.get(key);
    if ((previous?.hasChanges ?? false) === hasChanges) {
        registration.hasChanges = hasChanges;
        return;
    }
    registration.hasChanges = hasChanges;
    snapshots.set(key, hasChanges ? { hasChanges: true } : emptyActionState);
    notify(key);
}

export function getDiffEditorActionState(tabPath: string, paneId: string): DiffEditorActionState {
    return snapshots.get(registrationKey(tabPath, paneId)) ?? emptyActionState;
}

export function subscribeDiffEditorActions(
    tabPath: string,
    paneId: string,
    listener: () => void,
): () => void {
    const key = registrationKey(tabPath, paneId);
    const listeners = subscribers.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    subscribers.set(key, listeners);
    return () => {
        const current = subscribers.get(key);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) subscribers.delete(key);
    };
}

/**
 * Binds one mounted Monaco diff editor to the tab occurrence that owns it. The binding is deliberately keyed by pane as
 * well as virtual tab path: the same diff may be open in two panes, but toolbar actions must drive the focused pane's
 * actual editor.
 */
export function registerDiffEditorActions(
    tabPath: string,
    paneId: string,
    editor: DiffEditorActions,
): () => void {
    const key = registrationKey(tabPath, paneId);
    const previous = registrations.get(key);
    previous?.disposeDiffListener();
    const registration: DiffEditorRegistration = {
        // The listener is created immediately below before any event can be delivered.
        // eslint-disable-next-line no-use-before-define, @typescript-eslint/no-use-before-define -- registration teardown closes over its listener
        disposeDiffListener: () => diffListener.dispose(),
        editor,
        hasChanges: false,
    };
    registrations.set(key, registration);
    const diffListener = editor.onDidUpdateDiff(() => updateSnapshot(key, registration));
    updateSnapshot(key, registration);
    return () => {
        if (registrations.get(key) !== registration) return;
        registration.disposeDiffListener();
        registrations.delete(key);
        snapshots.delete(key);
        notify(key);
    };
}

/**
 * Moves the registered editor to Monaco's next or previous diff. Returning `false` keeps disabled toolbar actions and
 * unavailable editors observable without making callers reach into the registry.
 */
export function didNavigateDiffEditor(
    tabPath: string,
    paneId: string,
    direction: DiffNavigationDirection,
): boolean {
    const key = registrationKey(tabPath, paneId);
    const registration = registrations.get(key);
    if (!registration) return false;
    updateSnapshot(key, registration);
    if (!registration.hasChanges) return false;
    registration.editor.goToDiff(direction);
    return true;
}

export function useDiffEditorActionState(
    tabPath: string,
    paneId: string | undefined,
): DiffEditorActionState {
    return useSyncExternalStore(
        (listener) => (paneId ? subscribeDiffEditorActions(tabPath, paneId, listener) : () => {}),
        () => (paneId ? getDiffEditorActionState(tabPath, paneId) : emptyActionState),
        () => (paneId ? getDiffEditorActionState(tabPath, paneId) : emptyActionState),
    );
}
