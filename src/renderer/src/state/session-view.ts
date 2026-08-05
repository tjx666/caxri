import { useMemo } from 'react';
import { create } from 'zustand';

import {
    setSessionDocument,
    type EditorDocument,
    type SessionDocuments,
} from '@shared/editor-state';
import type { InspectorMode } from '@shared/types';
import { activateWorkState, resolveActiveWork, type WorkItem } from '@shared/work-item';

import {
    getSelectedSession,
    getSessionState,
    getSessionTerminals,
    useSelectedSession,
    useSessionState,
    useSessionTerminals,
} from './selectors';
import { patchSessionState } from './workbench';

/**
 * Upper bound on cached file contents per Session. Closing a tab evicts its document immediately, so
 * this cap only matters for a Session with an unusually large open-tab set (`openTabs` allows 100).
 * Twenty documents keep every realistically reachable tab warm while bounding renderer memory; the
 * evicted tab stays open and re-reads from disk when it is selected again.
 */
export const MAX_CACHED_DOCUMENTS_PER_SESSION = 20;

interface SessionViewState {
    /** Locally focused WorkItem per Session; the persisted `activeTab` is the durable fallback. */
    activeWork: Record<string, WorkItem | undefined>;
    documents: SessionDocuments;
    /** Least-recently-used order per Session, most recent last. Drives {@link evictExcess}. */
    recentDocuments: Record<string, string[]>;
    activateWork(item: WorkItem): void;
    setActiveWork(sessionId: string, item?: WorkItem): void;
    cacheDocument(sessionId: string, document: EditorDocument): void;
    cacheDocuments(sessionId: string, documents: readonly EditorDocument[]): void;
    updateDocumentContent(sessionId: string, path: string, content: string): void;
    evictDocument(sessionId: string, path: string): void;
    dropSessions(sessionIds: readonly string[]): void;
    setInspectorMode(mode: InspectorMode): void;
}

function touch(recent: readonly string[] | undefined, path: string): string[] {
    return [...(recent ?? []).filter((value) => value !== path), path];
}

/**
 * Drops the least recently used clean documents once a Session exceeds the cache cap. A dirty buffer
 * is never evicted implicitly: unlike the external-change rule, which replaces a dirty buffer with a
 * newer disk state the user can see, silent eviction would simply lose unsaved edits.
 */
function evictExcess(
    documents: Record<string, EditorDocument>,
    recent: readonly string[],
): { documents: Record<string, EditorDocument>; recent: string[] } {
    const tracked = new Set(recent);
    const cached = [
        ...Object.keys(documents).filter((path) => !tracked.has(path)),
        ...recent.filter((path) => documents[path]),
    ];
    if (cached.length <= MAX_CACHED_DOCUMENTS_PER_SESSION) return { documents, recent: cached };
    const remaining = { ...documents };
    const kept: string[] = [];
    let excess = cached.length - MAX_CACHED_DOCUMENTS_PER_SESSION;
    for (const path of cached) {
        if (excess > 0 && !remaining[path].dirty) {
            delete remaining[path];
            excess -= 1;
            continue;
        }
        kept.push(path);
    }
    return { documents: remaining, recent: kept };
}

function withDocuments(
    state: SessionViewState,
    sessionId: string,
    documents: Record<string, EditorDocument>,
    recent: readonly string[],
): Pick<SessionViewState, 'documents' | 'recentDocuments'> {
    const trimmed = evictExcess(documents, recent);
    return {
        documents: { ...state.documents, [sessionId]: trimmed.documents },
        recentDocuments: { ...state.recentDocuments, [sessionId]: trimmed.recent },
    };
}

export const useSessionViewStore = create<SessionViewState>((set, get) => ({
    activeWork: {},
    documents: {},
    recentDocuments: {},

    /**
     * The single write path for "what is focused in the center pane": updates the Session-scoped
     * `activeWork` plus the persisted `sessionState.activeTab` (and, for a Terminal, the layout's
     * active group) in one update. `resolveActiveWork` is the corresponding single read path.
     */
    activateWork(item) {
        const sessionId = getSelectedSession()?.id;
        if (!sessionId) return;
        get().setActiveWork(sessionId, item);
        const current = getSessionState();
        if (!current) return;
        const next = activateWorkState(current, item);
        if (next !== current) patchSessionState(next);
    },

    setActiveWork(sessionId, item) {
        set((state) => ({ activeWork: { ...state.activeWork, [sessionId]: item } }));
        if (item?.kind !== 'editor') return;
        set((state) => ({
            recentDocuments: {
                ...state.recentDocuments,
                [sessionId]: touch(state.recentDocuments[sessionId], item.path),
            },
        }));
    },

    cacheDocument(sessionId, document) {
        set((state) =>
            withDocuments(
                state,
                sessionId,
                setSessionDocument(state.documents, sessionId, document)[sessionId],
                touch(state.recentDocuments[sessionId], document.path),
            ),
        );
    },

    cacheDocuments(sessionId, documents) {
        if (documents.length === 0) return;
        set((state) => {
            const merged = documents.reduce(
                (current, document) => setSessionDocument(current, sessionId, document),
                state.documents,
            );
            const recent = documents.reduce<string[]>(
                (current, document) => touch(current, document.path),
                state.recentDocuments[sessionId] ?? [],
            );
            return withDocuments(state, sessionId, merged[sessionId], recent);
        });
    },

    updateDocumentContent(sessionId, path, content) {
        const existing = get().documents[sessionId]?.[path];
        if (!existing) return;
        get().cacheDocument(sessionId, { ...existing, content, dirty: true });
    },

    /** Closing a tab releases its content; the tab itself is owned by the persisted Session state. */
    evictDocument(sessionId, path) {
        set((state) => {
            const cached = state.documents[sessionId];
            if (!cached?.[path]) return state;
            const remaining = { ...cached };
            delete remaining[path];
            return {
                documents: { ...state.documents, [sessionId]: remaining },
                recentDocuments: {
                    ...state.recentDocuments,
                    [sessionId]: (state.recentDocuments[sessionId] ?? []).filter(
                        (value) => value !== path,
                    ),
                },
            };
        });
    },

    dropSessions(sessionIds) {
        const removed = new Set(sessionIds);
        if (removed.size === 0) return;
        const without = <T>(record: Record<string, T>): Record<string, T> =>
            Object.fromEntries(Object.entries(record).filter(([key]) => !removed.has(key)));
        set((state) => ({
            activeWork: without(state.activeWork),
            documents: without(state.documents),
            recentDocuments: without(state.recentDocuments),
        }));
    },

    /** Inspector mode is persisted with the Session, so this writes through to the Runtime. */
    setInspectorMode(mode) {
        const current = getSessionState();
        if (current) patchSessionState({ ...current, inspectorMode: mode });
    },
}));

/** Non-React counterpart of {@link useActiveWork}, for command handlers and event listeners. */
export function getResolvedActiveWork(): WorkItem | undefined {
    const sessionId = getSelectedSession()?.id;
    return resolveActiveWork({
        activeWork: sessionId ? useSessionViewStore.getState().activeWork[sessionId] : undefined,
        sessionTerminals: getSessionTerminals(),
        sessionState: getSessionState(),
    });
}

/** Reads the focused WorkItem through the single `resolveActiveWork` fallback ladder. */
export function useActiveWork(): WorkItem | undefined {
    const sessionId = useSelectedSession()?.id;
    const sessionTerminals = useSessionTerminals();
    const sessionState = useSessionState();
    const activeWork = useSessionViewStore((state) =>
        sessionId ? state.activeWork[sessionId] : undefined,
    );
    return useMemo(
        () => resolveActiveWork({ activeWork, sessionTerminals, sessionState }),
        [activeWork, sessionTerminals, sessionState],
    );
}

export function useDocument(
    sessionId: string | undefined,
    path: string | undefined,
): EditorDocument | undefined {
    return useSessionViewStore((state) =>
        sessionId && path ? state.documents[sessionId]?.[path] : undefined,
    );
}
