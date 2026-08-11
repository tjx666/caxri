import type { SessionState } from '@shared/types';

type EditorTab = SessionState['openTabs'][number];

interface EditorTabMotionItem {
    motionId: number;
    path: string;
    preview?: true;
}

export interface EditorTabMotionState {
    nextMotionId: number;
    tabs: EditorTabMotionItem[];
}

/**
 * Reconciles transient animation identity without changing persisted SessionState. A clean preview
 * is one replaceable UI slot, so its next path inherits the same identity; pinning matches by path,
 * while a genuinely new or reopened tab receives a new identity.
 */
export function reconcileEditorTabMotion(
    previous: EditorTabMotionState | undefined,
    openTabs: readonly EditorTab[],
): EditorTabMotionState {
    const prior = previous ?? { nextMotionId: 0, tabs: [] };
    const claimed = new Set<number>();
    let nextMotionId = prior.nextMotionId;
    const tabs = openTabs.map((tab) => {
        const exact = prior.tabs.find(
            (item) => item.path === tab.path && !claimed.has(item.motionId),
        );
        const replacedPreview = tab.preview
            ? prior.tabs.find((item) => item.preview && !claimed.has(item.motionId))
            : undefined;
        const motionId = exact?.motionId ?? replacedPreview?.motionId ?? nextMotionId++;
        claimed.add(motionId);
        return { motionId, path: tab.path, ...(tab.preview ? { preview: true as const } : {}) };
    });
    return { nextMotionId, tabs };
}

/** Discards transient identity state as soon as its owning Session no longer exists. */
export function pruneEditorTabMotionStates(
    states: Map<string, EditorTabMotionState>,
    liveSessionIds: readonly string[],
): void {
    const live = new Set(liveSessionIds);
    for (const sessionId of states.keys()) if (!live.has(sessionId)) states.delete(sessionId);
}
