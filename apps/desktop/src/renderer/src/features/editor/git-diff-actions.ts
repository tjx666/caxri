import { useSyncExternalStore } from 'react';

import { notifyListeners } from '@caxri/utils';
import type { MonacoDiffEditor } from '@monaco-editor/react';
import type { editor as Monaco } from 'monaco-editor';

import { editorSelectionEndLine } from './editor-status';

export type DiffNavigationDirection = 'next' | 'previous';

/**
 * Where the caret sits in the compared file, in that file's own line numbers.
 */
export interface DiffEditorFileSelection {
    line: number;
    column: number;
    selectionStartLine: number;
    selectionEndLine: number;
}

/**
 * The navigation boundary also accepts a one-hunk, single-sided code editor.
 */
export type DiffEditorActions = Pick<
    MonacoDiffEditor,
    'focus' | 'getLineChanges' | 'goToDiff' | 'onDidUpdateDiff'
> & {
    /**
     * Reads the caret from the side whose line numbers match the file on disk, so a caller can carry the reader's
     * position into the file itself. A diff surface publishes nothing to the editor status store: its models are
     * per-instance comparison snapshots, not the Session's document, so this registry is the only place that knows it.
     */
    getFileSelection(): DiffEditorFileSelection | undefined;
};

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
    // Isolates each diff-action subscriber so one throwing toolbar cannot stop this diff's other subscribers from
    // observing the update; Desktop mirrors `console.error` into `logs/desktop.jsonl`.
    notifyListeners(listeners, undefined, (error) =>
        console.error('editor.gitDiffActions listener failed', error),
    );
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

/**
 * Reads one code editor's current selection as a file position. Shared by both diff surfaces so the single-sided
 * added/deleted editor reports the same span shape as the two-sided comparison.
 */
export function codeEditorFileSelection(
    editor: Monaco.ICodeEditor,
): DiffEditorFileSelection | undefined {
    const selection = editor.getSelection();
    if (!selection) return undefined;
    const start = selection.getStartPosition();
    const end = selection.getEndPosition();
    return {
        line: selection.positionLineNumber,
        column: selection.positionColumn,
        selectionStartLine: start.lineNumber,
        selectionEndLine: editorSelectionEndLine(start, end),
    };
}

/**
 * Adapts a mounted Monaco diff editor to the registry contract.
 *
 * The caret is read from the modified side because that is the side whose line numbers address the file a caller can
 * open: the original side numbers a past revision, and a line there has no fixed counterpart in the current file.
 */
export function monacoDiffEditorActions(editor: MonacoDiffEditor): DiffEditorActions {
    return {
        focus: () => editor.focus(),
        getFileSelection: () => codeEditorFileSelection(editor.getModifiedEditor()),
        getLineChanges: () => editor.getLineChanges(),
        goToDiff: (direction) => editor.goToDiff(direction),
        onDidUpdateDiff: (listener) => editor.onDidUpdateDiff(listener),
    };
}

/**
 * Caret of the diff editor mounted for this tab occurrence, or `undefined` when none is mounted or it has no selection.
 */
export function getDiffEditorFileSelection(
    tabPath: string,
    paneId: string,
): DiffEditorFileSelection | undefined {
    return registrations.get(registrationKey(tabPath, paneId))?.editor.getFileSelection();
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

export function didFocusDiffEditor(tabPath: string, paneId: string): boolean {
    const registration = registrations.get(registrationKey(tabPath, paneId));
    if (!registration) return false;
    registration.editor.focus();
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
