import { isPathAtOrBelow } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { createStore } from '../../../lib/store';

export interface PendingFileOperation {
    id: string;
    label: string;
    projectId: string;
    /**
     * Directory (or item) paths whose listing this operation can still change. UI blocking is scoped to these subtrees
     * instead of gating the entire Project, so one slow folder copy no longer freezes unrelated Paste/Duplicate/Drag
     * actions elsewhere in the tree.
     */
    affectedPaths: readonly string[];
    /**
     * Only a durable mutation (create/rename/move) is journaled with a Server-recognized `operationId`, so only those
     * can be canceled through `files.operation.cancel`. A plain copy has no journal entry to cancel: offering Cancel
     * for it would be a dead button.
     */
    cancelable: boolean;
    startedAt: number;
}

interface BeginFileOperationInput {
    id: string;
    label: string;
    projectId: string;
    affectedPaths: readonly string[];
    cancelable?: boolean;
}

interface FileOperationState {
    operations: PendingFileOperation[];
    begin(operation: BeginFileOperationInput): boolean;
    finish(id: string): void;
    update(id: string, label: string): void;
    clear(): void;
}

/**
 * Renderer lifecycle for long file mutations; Server remains the authority for every path.
 */
export const useFileOperationStore = createStore<FileOperationState>(
    'file-operation',
    (set, get) => ({
        operations: [],
        begin(operation) {
            if (get().operations.some((current) => current.id === operation.id)) return false;
            set((state) => ({
                operations: [
                    ...state.operations,
                    {
                        ...operation,
                        cancelable: operation.cancelable === true,
                        startedAt: Date.now(),
                    },
                ],
            }));
            return true;
        },
        finish: (id) =>
            set((state) => ({
                operations: state.operations.filter((operation) => operation.id !== id),
            })),
        update: (id, label) =>
            set((state) => ({
                operations: state.operations.map((operation) =>
                    operation.id === id ? { ...operation, label } : operation,
                ),
            })),
        clear: () => set({ operations: [] }),
    }),
);

/**
 * True when a Project-scoped action targeting `path` overlaps a pending file operation's affected subtree. Used instead
 * of "any operation pending for this Project" so a slow copy in one folder cannot block Paste/Duplicate/Drag somewhere
 * unrelated in the same tree.
 */
export function isPathBlockedByFileOperations(
    operations: readonly PendingFileOperation[],
    projectId: string,
    path: string,
): boolean {
    return operations.some(
        (operation) =>
            operation.projectId === projectId &&
            operation.affectedPaths.some((affected) => isPathAtOrBelow(path, affected)),
    );
}

/**
 * Row-level subscription to {@link isPathBlockedByFileOperations}: the selector returns a boolean, so a tree row only
 * re-renders when its own blocking state flips rather than whenever the operation list changes identity.
 */
export function useIsPathBlockedByFileOperations(projectId: string, path: string): boolean {
    return useFileOperationStore((state) =>
        isPathBlockedByFileOperations(state.operations, projectId, path),
    );
}

/**
 * Shared copy for every Paste/Duplicate menu entry disabled by an in-flight file operation.
 */
export function fileOperationBusyReason(t: Translate): string {
    return t('viewContainers.files.busyReason');
}

/**
 * Why Paste cannot run into a directory, or `undefined` while it can. An empty clipboard wins over a busy target:
 * waiting for the operation would not give the user anything to paste.
 */
export function pasteDisabledReason(
    {
        isBlocked,
        isClipboardEmpty,
    }: {
        isBlocked: boolean;
        isClipboardEmpty: boolean;
    },
    t: Translate,
): string | undefined {
    if (isClipboardEmpty) return t('viewContainers.files.nothingToPaste');
    if (isBlocked) return fileOperationBusyReason(t);
    return undefined;
}

/**
 * Every pending operation for a Project whose affected subtree overlaps `path`, oldest first.
 */
export function fileOperationsBlockingPath(
    operations: readonly PendingFileOperation[],
    projectId: string,
    path: string,
): PendingFileOperation[] {
    return operations.filter(
        (operation) =>
            operation.projectId === projectId &&
            operation.affectedPaths.some((affected) => isPathAtOrBelow(path, affected)),
    );
}

/**
 * A Cancel affordance appears only once an operation has been running long enough that a progress label alone is no
 * longer reassuring, and only for a durable mutation Server can actually cancel.
 */
export const CANCEL_REVEAL_THRESHOLD_MS = 1_500;

/**
 * Milliseconds until the Cancel affordance should appear, or `undefined` when it must stay hidden because the operation
 * is absent or not cancelable. Zero means the threshold has already passed.
 */
export function cancelRevealDelayMs(
    operation: Pick<PendingFileOperation, 'cancelable' | 'startedAt'> | undefined,
    now: number,
): number | undefined {
    if (!operation?.cancelable) return undefined;
    return Math.max(operation.startedAt + CANCEL_REVEAL_THRESHOLD_MS - now, 0);
}
