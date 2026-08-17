import { useMemo } from 'react';

import type { EditorDocument, SessionDocuments } from '@shared/editor-state';
import { setSessionDocument } from '@shared/editor-state';
import type { InspectorMode } from '@shared/types';
import type { WorkItem } from '@shared/work-item';
import { activateWorkState, resolveActiveWork } from '@shared/work-item';
import { omit, omitBy } from 'es-toolkit';
import { create } from 'zustand';

import { isPathAtOrBelow, remapPath } from '../lib/file-path';
import {
    getBootstrap,
    getSelectedSession,
    getSessionState,
    getSessionTerminals,
    useSelectedSession,
    useSessionState,
    useSessionTerminals,
} from './selectors';
import { patchSessionState } from './workbench';

/**
 * Upper bound on cached file contents per Session. Closing a tab evicts its document immediately, so this cap only
 * matters for a Session with an unusually large open-tab set (`openTabs` allows 100). Twenty documents keep every
 * realistically reachable tab warm while bounding renderer memory; the evicted tab stays open and re-reads from disk
 * when it is selected again.
 */
export const MAX_CACHED_DOCUMENTS_PER_SESSION = 20;
export const MAX_CACHED_DOCUMENT_BYTES_GLOBAL = 32 * 1024 * 1024;

interface SessionViewState {
    /**
     * Locally focused WorkItem per Session; the persisted `activeTab` is the durable fallback.
     */
    activeWork: Record<string, WorkItem | undefined>;
    documents: SessionDocuments;
    /**
     * Least-recently-used order per Session, most recent last. Drives {@link evictExcess}.
     */
    recentDocuments: Record<string, string[]>;
    activateWork(item: WorkItem, options?: { editorGroupId?: string }): void;
    setActiveWork(sessionId: string, item?: WorkItem, workbenchProjectId?: string): void;
    cacheDocument(sessionId: string, document: EditorDocument, workbenchProjectId?: string): void;
    cacheDocuments(
        sessionId: string,
        documents: readonly EditorDocument[],
        workbenchProjectId?: string,
    ): void;
    updateDocumentContent(sessionId: string, path: string, content: string): void;
    evictDocument(sessionId: string, path: string, workbenchProjectId?: string): void;
    evictDocumentsUnderPath(sessionId: string, path: string): void;
    remapDocuments(
        sessionId: string,
        previousPath: string,
        nextPath: string,
        workbenchProjectId?: string,
    ): void;
    dropSessions(sessionIds: readonly string[]): void;
    setInspectorMode(mode: InspectorMode): void;
}

/**
 * Owner-root state keeps its historical Session key; alternate roots add the independently authorized Project ID so
 * dirty buffers with the same path can never collide.
 */
export function sessionViewScope(sessionId: string, workbenchProjectId?: string): string {
    const session = getBootstrap()?.sessions.find((candidate) => candidate.id === sessionId);
    const rootProjectId = workbenchProjectId ?? session?.workbenchProjectId;
    if (!rootProjectId || !session || rootProjectId === session.projectId) return sessionId;
    return `${sessionId}\0${rootProjectId}`;
}

function touch(recent: readonly string[] | undefined, path: string): string[] {
    return [...(recent ?? []).filter((value) => value !== path), path];
}

/**
 * Reads a scoped document map, surfacing `undefined` for a Session that has never cached a document. `SessionDocuments`
 * indexes with a plain `Record`, so TypeScript does not model the missing-key case; `Object.hasOwn` recovers it
 * explicitly instead of relying on an index access the type system treats as always-defined.
 */
function readScopedDocuments(
    documents: SessionDocuments,
    scope: string,
): Record<string, EditorDocument> | undefined {
    return Object.hasOwn(documents, scope) ? documents[scope] : undefined;
}

/**
 * Drops the least recently used clean documents once a Session exceeds the cache cap. A dirty buffer is never evicted
 * implicitly: unlike the external-change rule, which replaces a dirty buffer with a newer disk state the user can see,
 * silent eviction would simply lose unsaved edits.
 */
function evictExcess(
    documents: Record<string, EditorDocument>,
    recent: readonly string[],
): { documents: Record<string, EditorDocument>; recent: string[] } {
    const tracked = new Set(recent);
    const cached = [
        ...Object.keys(documents).filter((path) => !tracked.has(path)),
        ...recent.filter((path) => Object.hasOwn(documents, path)),
    ];
    if (cached.length <= MAX_CACHED_DOCUMENTS_PER_SESSION) return { documents, recent: cached };
    const dropped: string[] = [];
    const kept: string[] = [];
    let excess = cached.length - MAX_CACHED_DOCUMENTS_PER_SESSION;
    for (const path of cached) {
        if (excess > 0 && !documents[path].dirty) {
            dropped.push(path);
            excess -= 1;
            continue;
        }
        kept.push(path);
    }
    return { documents: omit(documents, dropped), recent: kept };
}

function retainedBytes(document: EditorDocument): number {
    return Math.max(document.size, document.content.length * 2);
}

/**
 * Applies one process-wide content budget after the per-Session count cap. Dirty buffers are the only exception because
 * reclaiming them would destroy unsaved work; they still displace every eligible clean buffer before the cache is
 * allowed to exceed the budget.
 */
function evictToGlobalBudget(
    documents: SessionDocuments,
    recentDocuments: Record<string, string[]>,
): { documents: SessionDocuments; recentDocuments: Record<string, string[]> } {
    let total = 0;
    const cleanCandidates: Array<{ sessionId: string; path: string; bytes: number }> = [];
    for (const [sessionId, sessionDocuments] of Object.entries(documents)) {
        const recent = recentDocuments[sessionId] ?? [];
        const tracked = new Set(recent);
        const ordered = [
            ...Object.keys(sessionDocuments).filter((path) => !tracked.has(path)),
            ...recent.filter((path) => Object.hasOwn(sessionDocuments, path)),
        ];
        for (const path of ordered) {
            const document = sessionDocuments[path];
            const bytes = retainedBytes(document);
            total += bytes;
            if (!document.dirty) cleanCandidates.push({ sessionId, path, bytes });
        }
    }
    if (total <= MAX_CACHED_DOCUMENT_BYTES_GLOBAL) return { documents, recentDocuments };

    const nextDocuments = { ...documents };
    const nextRecent = { ...recentDocuments };
    for (const candidate of cleanCandidates) {
        if (total <= MAX_CACHED_DOCUMENT_BYTES_GLOBAL) break;
        nextDocuments[candidate.sessionId] = omit(nextDocuments[candidate.sessionId], [
            candidate.path,
        ]);
        nextRecent[candidate.sessionId] = (nextRecent[candidate.sessionId] ?? []).filter(
            (path) => path !== candidate.path,
        );
        total -= candidate.bytes;
    }
    return { documents: nextDocuments, recentDocuments: nextRecent };
}

function withDocuments(
    state: SessionViewState,
    sessionId: string,
    documents: Record<string, EditorDocument>,
    recent: readonly string[],
): Pick<SessionViewState, 'documents' | 'recentDocuments'> {
    const trimmed = evictExcess(documents, recent);
    return evictToGlobalBudget(
        { ...state.documents, [sessionId]: trimmed.documents },
        { ...state.recentDocuments, [sessionId]: trimmed.recent },
    );
}

export const useSessionViewStore = create<SessionViewState>((set, get) => ({
    activeWork: {},
    documents: {},
    recentDocuments: {},

    /**
     * The single write path for "what is focused in the center pane": updates the Session-scoped `activeWork` plus the
     * persisted `sessionState.activeTab` (and, for a Terminal, the layout's active group) in one update.
     * `resolveActiveWork` is the corresponding single read path.
     */
    activateWork(item, options) {
        const sessionId = getSelectedSession()?.id;
        if (!sessionId) return;
        get().setActiveWork(sessionId, item);
        const current = getSessionState();
        if (!current) return;
        const next = activateWorkState(current, item, options?.editorGroupId);
        if (next !== current) patchSessionState(next);
    },

    setActiveWork(sessionId, item, workbenchProjectId) {
        const scope = sessionViewScope(sessionId, workbenchProjectId);
        set((state) => ({ activeWork: { ...state.activeWork, [scope]: item } }));
        if (item?.kind !== 'editor') return;
        set((state) => ({
            recentDocuments: {
                ...state.recentDocuments,
                [scope]: touch(state.recentDocuments[scope], item.path),
            },
        }));
    },

    cacheDocument(sessionId, document, workbenchProjectId) {
        const scope = sessionViewScope(sessionId, workbenchProjectId);
        set((state) =>
            withDocuments(
                state,
                scope,
                setSessionDocument(state.documents, scope, document)[scope],
                touch(state.recentDocuments[scope], document.path),
            ),
        );
    },

    cacheDocuments(sessionId, documents, workbenchProjectId) {
        if (documents.length === 0) return;
        const scope = sessionViewScope(sessionId, workbenchProjectId);
        set((state) => {
            const merged = documents.reduce(
                (current, document) => setSessionDocument(current, scope, document),
                state.documents,
            );
            const recent = documents.reduce<string[]>(
                (current, document) => touch(current, document.path),
                state.recentDocuments[scope] ?? [],
            );
            return withDocuments(state, scope, merged[scope], recent);
        });
    },

    updateDocumentContent(sessionId, path, content) {
        const existing = getSessionDocuments(sessionId)?.[path];
        if (!existing) return;
        get().cacheDocument(sessionId, { ...existing, content, dirty: true });
    },

    /**
     * Closing a tab releases its content; the tab itself is owned by the persisted Session state.
     */
    evictDocument(sessionId, path, workbenchProjectId) {
        const scope = sessionViewScope(sessionId, workbenchProjectId);
        set((state) => {
            const cached = readScopedDocuments(state.documents, scope);
            if (!cached || !Object.hasOwn(cached, path)) return state;
            const remaining = omit(cached, [path]);
            return {
                documents: { ...state.documents, [scope]: remaining },
                recentDocuments: {
                    ...state.recentDocuments,
                    [scope]: (state.recentDocuments[scope] ?? []).filter((value) => value !== path),
                },
            };
        });
    },

    evictDocumentsUnderPath(sessionId, path) {
        const scope = sessionViewScope(sessionId);
        set((state) => {
            const cached = readScopedDocuments(state.documents, scope);
            if (!cached || Object.keys(cached).every((value) => !isPathAtOrBelow(value, path)))
                return state;
            // `omitBy`'s type signature returns `Partial<T>` even though it only ever removes keys
            // and never introduces `undefined` values, so the result is safe to narrow back to `T`.
            const remaining = omitBy(cached, (_value, key) => isPathAtOrBelow(key, path)) as Record<
                string,
                EditorDocument
            >;
            return {
                documents: { ...state.documents, [scope]: remaining },
                recentDocuments: {
                    ...state.recentDocuments,
                    [scope]: (state.recentDocuments[scope] ?? []).filter(
                        (value) => !isPathAtOrBelow(value, path),
                    ),
                },
            };
        });
    },

    remapDocuments(sessionId, previousPath, nextPath, workbenchProjectId) {
        const scope = sessionViewScope(sessionId, workbenchProjectId);
        set((state) => {
            const cached = readScopedDocuments(state.documents, scope);
            if (
                !cached ||
                Object.keys(cached).every((path) => !isPathAtOrBelow(path, previousPath))
            )
                return state;
            const remapped = Object.fromEntries(
                Object.entries(cached).map(([path, document]) => {
                    const nextDocumentPath = remapPath(path, previousPath, nextPath);
                    return [nextDocumentPath, { ...document, path: nextDocumentPath }];
                }),
            );
            return {
                documents: { ...state.documents, [scope]: remapped },
                recentDocuments: {
                    ...state.recentDocuments,
                    [scope]: (state.recentDocuments[scope] ?? []).map((path) =>
                        remapPath(path, previousPath, nextPath),
                    ),
                },
            };
        });
    },

    dropSessions(sessionIds) {
        const removed = new Set(sessionIds);
        if (removed.size === 0) return;
        /**
         * `omitBy`'s type signature returns `Partial<T>` even though it only ever removes keys and never introduces
         * `undefined` values, so the result is safe to narrow back to `Record<string, T>`.
         */
        const without = <T>(record: Record<string, T>): Record<string, T> =>
            omitBy(record, (_value, key) =>
                [...removed].some(
                    (sessionId) => key === sessionId || key.startsWith(`${sessionId}\0`),
                ),
            ) as Record<string, T>;
        set((state) => ({
            activeWork: without(state.activeWork),
            documents: without(state.documents),
            recentDocuments: without(state.recentDocuments),
        }));
    },

    /**
     * Inspector mode is persisted with the Session, so this writes through to the Runtime.
     */
    setInspectorMode(mode) {
        const current = getSessionState();
        if (current) patchSessionState({ ...current, inspectorMode: mode });
    },
}));

export function getSessionDocuments(
    sessionId: string,
    workbenchProjectId?: string,
): Record<string, EditorDocument> | undefined {
    return useSessionViewStore.getState().documents[
        sessionViewScope(sessionId, workbenchProjectId)
    ];
}

export function getSessionActiveWork(
    sessionId: string,
    workbenchProjectId?: string,
): WorkItem | undefined {
    return useSessionViewStore.getState().activeWork[
        sessionViewScope(sessionId, workbenchProjectId)
    ];
}

/**
 * Non-React counterpart of {@link useActiveWork}, for command handlers and event listeners.
 */
export function getResolvedActiveWork(): WorkItem | undefined {
    const sessionId = getSelectedSession()?.id;
    return resolveActiveWork({
        activeWork: sessionId ? getSessionActiveWork(sessionId) : undefined,
        sessionTerminals: getSessionTerminals(),
        sessionState: getSessionState(),
    });
}

/**
 * Reads the focused WorkItem through the single `resolveActiveWork` fallback ladder.
 */
export function useActiveWork(): WorkItem | undefined {
    const session = useSelectedSession();
    const sessionTerminals = useSessionTerminals();
    const sessionState = useSessionState();
    /**
     * Keep the Workbench Project in the reactive input set. React Compiler cannot observe the store read hidden inside
     * `sessionViewScope(sessionId)` when the Session ID itself is stable.
     */
    const scope = session ? sessionViewScope(session.id, session.workbenchProjectId) : undefined;
    const activeWork = useSessionViewStore((state) =>
        scope ? state.activeWork[scope] : undefined,
    );
    return useMemo(
        () => resolveActiveWork({ activeWork, sessionTerminals, sessionState }),
        [activeWork, sessionTerminals, sessionState],
    );
}

export function useDocument(
    sessionId: string | undefined,
    path: string | undefined,
    workbenchProjectId?: string,
): EditorDocument | undefined {
    return useSessionViewStore((state) =>
        sessionId && path
            ? state.documents[sessionViewScope(sessionId, workbenchProjectId)]?.[path]
            : undefined,
    );
}
