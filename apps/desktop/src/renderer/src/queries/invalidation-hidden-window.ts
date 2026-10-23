import type { ExtensionViewEventContext } from '@caxri/protocol';

/**
 * Changed paths `files.changed` reports for one Workbench Project, merged until they are invalidated.
 */
export interface PendingFileChangeBatch {
    changes: Map<string, 'create' | 'update' | 'delete'>;
    gitIgnoreRulesChanged: boolean;
    overflow: boolean;
    sessionId: string;
}

/**
 * One Session-scoped Source Control content or view-badge change from `viewContainers.viewChanged`.
 */
export interface ViewChange {
    context: Extract<ExtensionViewEventContext, { kind: 'session' }>;
    kind: 'badge' | 'content';
    viewId: string;
}

/**
 * A window hidden through a long Agent run merges every changed path into one deferred batch. Past this many distinct
 * paths the batch degrades to `overflow`, which refreshes every listing once on reveal instead of growing unbounded.
 */
const MAX_DEFERRED_FILE_CHANGES = 2000;

/**
 * Re-invalidates, with an active refetch, what changed while the window was hidden.
 */
export interface HiddenWindowRevealHandlers {
    files: (workbenchProjectId: string, batch: PendingFileChangeBatch) => void;
    git: (sessionIds: readonly string[]) => void;
    view: (change: ViewChange) => void;
}

export interface HiddenWindowDeferral {
    dispose: () => void;
    isHidden: () => boolean;
    deferFiles: (workbenchProjectId: string, batch: PendingFileChangeBatch) => void;
    deferGit: (sessionIds: readonly string[]) => void;
    deferView: (change: ViewChange) => void;
}

/**
 * An Agent working while the window is minimized or covered emits `git.changed`, `files.changed`, and Source Control
 * view changes for every burst of writes, and each refetch costs the Server a `git status`, a diff, or a directory
 * listing. Nobody sees those results until the window shows again, so a hidden window only marks the reads stale and
 * records what changed here, then invalidates exactly that once more with an active refetch on reveal. The reveal pass
 * keys on what changed rather than `isInvalidated`, because a fetch already in flight when the window hid resolves with
 * pre-change data and clears that flag. A visible but unfocused window (a second monitor) still refetches immediately.
 */
export function createHiddenWindowDeferral(
    reveal: HiddenWindowRevealHandlers,
): HiddenWindowDeferral {
    const gitSessionIds = new Set<string>();
    const fileBatches = new Map<string, PendingFileChangeBatch>();
    const viewChanges = new Map<string, ViewChange>();
    /**
     * Absent only in node-environment unit tests, which never hide a window.
     */
    const page = 'document' in globalThis ? document : undefined;
    const isHidden = (): boolean => page?.visibilityState === 'hidden';
    const handleVisibilityChange = (): void => {
        if (isHidden()) return;
        const sessionIds = gitSessionIds.values().toArray();
        const batches = fileBatches.entries().toArray();
        const changes = viewChanges.values().toArray();
        gitSessionIds.clear();
        fileBatches.clear();
        viewChanges.clear();
        if (sessionIds.length > 0) reveal.git(sessionIds);
        for (const [workbenchProjectId, batch] of batches) reveal.files(workbenchProjectId, batch);
        for (const change of changes) reveal.view(change);
    };
    page?.addEventListener('visibilitychange', handleVisibilityChange);
    return {
        dispose: () => {
            page?.removeEventListener('visibilitychange', handleVisibilityChange);
            gitSessionIds.clear();
            fileBatches.clear();
            viewChanges.clear();
        },
        isHidden,
        deferFiles: (workbenchProjectId, batch) => {
            const target = fileBatches.get(workbenchProjectId) ?? {
                changes: new Map(),
                gitIgnoreRulesChanged: false,
                overflow: false,
                sessionId: batch.sessionId,
            };
            target.overflow ||= batch.overflow;
            target.gitIgnoreRulesChanged ||= batch.gitIgnoreRulesChanged;
            target.sessionId = batch.sessionId;
            if (!target.overflow)
                for (const [path, kind] of batch.changes) target.changes.set(path, kind);
            if (target.overflow || target.changes.size > MAX_DEFERRED_FILE_CHANGES) {
                target.overflow = true;
                target.changes.clear();
            }
            fileBatches.set(workbenchProjectId, target);
        },
        deferGit: (sessionIds) => {
            for (const sessionId of sessionIds) gitSessionIds.add(sessionId);
        },
        deferView: (change) => {
            const { context } = change;
            viewChanges.set(
                `${change.kind}\0${change.viewId}\0${context.sessionId}\0${context.workbenchProjectId}`,
                change,
            );
        },
    };
}
