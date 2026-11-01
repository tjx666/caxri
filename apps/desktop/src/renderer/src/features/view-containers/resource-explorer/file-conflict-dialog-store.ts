import type { FileEntry } from '@caxri/protocol';

import { createStore } from '../../../lib/store';

export type FileConflictChoice = 'cancel' | 'keep-both' | 'replace';

export interface FileConflictRequest {
    /**
     * The colliding name, shown in the dialog title and body.
     */
    name: string;
    /**
     * True when either side of the collision is a folder. `files.move`'s `replace` mode can only atomically overwrite a
     * plain file (see `mutations.ts`'s `assertReplaceableMove`), so a folder-gated request hides Replace and swaps in
     * folder-specific copy instead of offering a choice Server would just reject.
     */
    folderGated: boolean;
    /**
     * How many entries of the same batch are still queued behind this one. The dialog offers "Apply to all remaining"
     * only when it is above zero.
     */
    remaining?: number;
}

/**
 * The user's answer: the choice, and whether it also applies to every remaining entry of the batch.
 */
export interface FileConflictDecision {
    shouldApplyToAll: boolean;
    choice: FileConflictChoice;
}

/**
 * Carries a batch's "Apply to all remaining" answer across the entries of one multi-move so later conflicts skip the
 * dialog. `choice` is set once the user ticked the box.
 */
export interface FileConflictBatch {
    choice?: FileConflictChoice;
    remaining: number;
}

interface FileConflictDialogState {
    request?: FileConflictRequest;
    resolve?: (decision: FileConflictDecision) => void;
}

/**
 * One shared store instance backs the single `FileConflictDialog` mounted by `ResourceExplorerView`, the same
 * one-instance-per-panel pattern the rest of the files feature already uses for clipboard and operation state
 * (`file-clipboard.ts`, `file-operation-state.ts`).
 */
export const useFileConflictDialogStore = createStore<FileConflictDialogState>(
    'file-conflict-dialog',
    () => ({}),
);

/**
 * Opens the Finder-style Replace/Keep Both/Cancel prompt and resolves once the user picks one (or the dialog is
 * dismissed any other way, which `FileConflictDialog` treats as Cancel). Only one conflict can be prompted at a time; a
 * request that somehow arrives while another is still open resolves the stale one as canceled first so no promise is
 * ever left dangling.
 */
export function requestFileConflictChoice(
    request: FileConflictRequest,
): Promise<FileConflictDecision> {
    return new Promise((resolve) => {
        useFileConflictDialogStore
            .getState()
            .resolve?.({ choice: 'cancel', shouldApplyToAll: false });
        useFileConflictDialogStore.setState({ request, resolve });
    });
}

/**
 * Resolves the pending prompt and closes the dialog; a no-op once already resolved.
 */
export function resolveFileConflictChoice(
    choice: FileConflictChoice,
    shouldApplyToAll = false,
): void {
    const { resolve } = useFileConflictDialogStore.getState();
    if (!resolve) return;
    useFileConflictDialogStore.setState({ request: undefined, resolve: undefined });
    resolve({ choice, shouldApplyToAll });
}

/**
 * The choice a batch already settled for this conflict, or `undefined` when the dialog must open. Replace never carries
 * over to a folder-gated conflict, since Server would reject it; that one asks again.
 */
export function batchConflictChoice(
    batch: FileConflictBatch | undefined,
    isFolderGated: boolean,
): FileConflictChoice | undefined {
    if (!batch?.choice) return undefined;
    return isFolderGated && batch.choice === 'replace' ? undefined : batch.choice;
}

/**
 * Pure gating rule extracted for unit coverage: Replace is only offered when both sides of the collision are ordinary
 * files. An entry whose kind could not be resolved (a race between listing and prompting) defaults to folder-gated
 * rather than risking an unavailable Replace.
 */
export function isFolderGatedConflict(
    sourceKind: FileEntry['kind'] | undefined,
    targetKind: FileEntry['kind'] | undefined,
): boolean {
    return sourceKind !== 'file' || targetKind !== 'file';
}
