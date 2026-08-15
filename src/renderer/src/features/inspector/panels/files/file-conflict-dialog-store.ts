import { create } from 'zustand';

import type { FileEntry } from '@shared/types';

export type FileConflictChoice = 'cancel' | 'keep-both' | 'replace';

export interface FileConflictRequest {
    /** The colliding name, shown in the dialog title and body. */
    name: string;
    /**
     * True when either side of the collision is a folder. `files.move`'s `replace` mode can only
     * atomically overwrite a plain file (see `mutations.ts`'s `assertReplaceableMove`), so a
     * folder-gated request hides Replace and swaps in folder-specific copy instead of offering a
     * choice Runtime would just reject.
     */
    folderGated: boolean;
}

interface FileConflictDialogState {
    request?: FileConflictRequest;
    resolve?: (choice: FileConflictChoice) => void;
}

/**
 * One shared store instance backs the single `FileConflictDialog` mounted by `FileTreePanel`, the
 * same one-instance-per-panel pattern the rest of the files feature already uses for clipboard and
 * operation state (`file-clipboard.ts`, `file-operation-state.ts`).
 */
export const useFileConflictDialogStore = create<FileConflictDialogState>(() => ({}));

/**
 * Opens the Finder-style Replace/Keep Both/Cancel prompt and resolves once the user picks one (or
 * the dialog is dismissed any other way, which `FileConflictDialog` treats as Cancel). Only one
 * conflict can be prompted at a time; a request that somehow arrives while another is still open
 * resolves the stale one as canceled first so no promise is ever left dangling.
 */
export function requestFileConflictChoice(
    request: FileConflictRequest,
): Promise<FileConflictChoice> {
    return new Promise((resolve) => {
        useFileConflictDialogStore.getState().resolve?.('cancel');
        useFileConflictDialogStore.setState({ request, resolve });
    });
}

/** Resolves the pending prompt and closes the dialog; a no-op once already resolved. */
export function resolveFileConflictChoice(choice: FileConflictChoice): void {
    const { resolve } = useFileConflictDialogStore.getState();
    if (!resolve) return;
    useFileConflictDialogStore.setState({ request: undefined, resolve: undefined });
    resolve(choice);
}

/**
 * Pure gating rule extracted for unit coverage: Replace is only offered when both sides of the
 * collision are ordinary files. An entry whose kind could not be resolved (a race between listing
 * and prompting) defaults to folder-gated rather than risking an unavailable Replace.
 */
export function isFolderGatedConflict(
    sourceKind: FileEntry['kind'] | undefined,
    targetKind: FileEntry['kind'] | undefined,
): boolean {
    return sourceKind !== 'file' || targetKind !== 'file';
}
