import type { ViewContainerId } from '@caxri/protocol';
import { isPathAtOrBelow } from '@caxri/protocol';
import type { EditorDocument, SessionDocuments } from '@desktop-shared/editor-state';
import { setSessionDocument } from '@desktop-shared/editor-state';
import { omit, omitBy } from 'es-toolkit';

import { dropExternalEditorSessions } from '../features/editor/external-editor-state';
import { remapPath } from '../lib/file-path';
import { createStore } from '../lib/store';
import { getBootstrap, getSessionState } from './selectors';
import { patchSessionState } from './workbench';

/**
 * Upper bound on cached file contents per Session. Closing a tab evicts its document immediately, so this cap only
 * matters for a Session with an unusually large open-tab set. Twenty documents keep every realistically reachable tab
 * warm while bounding renderer memory; the evicted tab stays open and re-reads from disk when it is selected again.
 */
export const MAX_CACHED_DOCUMENTS_PER_SESSION = 20;
export const MAX_CACHED_DOCUMENT_BYTES_GLOBAL = 32 * 1024 * 1024;

interface SessionViewState {
    documents: SessionDocuments;
    /**
     * Least-recently-used order per Session, most recent last. Drives {@link evictExcess}.
     */
    recentDocuments: Record<string, string[]>;
    /**
     * Records a document as most recently used without caching content, so selecting an already open tab keeps its
     * buffer ahead of the eviction line.
     */
    touchDocument(sessionId: string, path: string, workbenchProjectId?: string): void;
    cacheDocument(
        sessionId: string,
        document: EditorDocument,
        workbenchProjectId?: string,
    ): boolean;
    cacheDocuments(
        sessionId: string,
        documents: readonly EditorDocument[],
        workbenchProjectId?: string,
    ): void;
    updateDocumentContent(
        sessionId: string,
        path: string,
        content: string,
        workbenchProjectId: string,
    ): void;
    evictDocument(sessionId: string, path: string, workbenchProjectId?: string): void;
    evictDocumentsUnderPath(sessionId: string, path: string, workbenchProjectId?: string): void;
    remapDocuments(
        sessionId: string,
        previousPath: string,
        nextPath: string,
        workbenchProjectId?: string,
    ): void;
    dropSessions(sessionIds: readonly string[]): void;
    setDesiredSecondarySidebarViewContainerId(id: ViewContainerId): void;
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
 * Drops the least recently used reloadable documents once a Session exceeds the cache cap. Dirty buffers cannot be
 * discarded without data loss, while ephemeral external documents cannot be re-read after Main closes their one-shot
 * authority. Admission checks below bound those non-evictable exceptions instead.
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
        if (excess > 0 && !documents[path].dirty && !documents[path].ephemeral) {
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

function canRetainEphemeralDocument(
    documents: SessionDocuments,
    scope: string,
    document: EditorDocument,
): boolean {
    const scopedDocuments = readScopedDocuments(documents, scope);
    const existing = scopedDocuments?.[document.path];
    const existingEphemeralCount = Object.values(scopedDocuments ?? {}).filter(
        (candidate) => candidate.ephemeral,
    ).length;
    if (existing?.ephemeral !== true && existingEphemeralCount >= MAX_CACHED_DOCUMENTS_PER_SESSION)
        return false;
    let protectedBytes = 0;
    for (const [sessionId, sessionDocuments] of Object.entries(documents))
        for (const [path, candidate] of Object.entries(sessionDocuments))
            if (
                (candidate.dirty || candidate.ephemeral) &&
                !(sessionId === scope && path === document.path)
            )
                protectedBytes += retainedBytes(candidate);
    return protectedBytes + retainedBytes(document) <= MAX_CACHED_DOCUMENT_BYTES_GLOBAL;
}

/**
 * Applies one process-wide content budget after the per-Session count cap. Dirty buffers may exceed it because
 * reclaiming them would destroy unsaved work. Ephemeral external documents are admitted only while the protected total
 * remains within the budget, then displace every eligible reloadable buffer here.
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
            if (!document.dirty && !document.ephemeral)
                cleanCandidates.push({ sessionId, path, bytes });
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

export const useSessionViewStore = createStore<SessionViewState>('session-view', (set, get) => ({
    documents: {},
    recentDocuments: {},

    touchDocument(sessionId, path, workbenchProjectId) {
        const scope = sessionViewScope(sessionId, workbenchProjectId);
        set((state) => ({
            recentDocuments: {
                ...state.recentDocuments,
                [scope]: touch(state.recentDocuments[scope], path),
            },
        }));
    },

    cacheDocument(sessionId, document, workbenchProjectId) {
        const scope = sessionViewScope(sessionId, workbenchProjectId);
        let didCache = false;
        set((state) => {
            if (document.ephemeral && !canRetainEphemeralDocument(state.documents, scope, document))
                return state;
            didCache = true;
            return withDocuments(
                state,
                scope,
                setSessionDocument(state.documents, scope, document)[scope],
                touch(state.recentDocuments[scope], document.path),
            );
        });
        return didCache;
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

    updateDocumentContent(sessionId, path, content, workbenchProjectId) {
        const existing = getSessionDocuments(sessionId, workbenchProjectId)?.[path];
        if (!existing || existing.readOnly) return;
        get().cacheDocument(sessionId, { ...existing, content, dirty: true }, workbenchProjectId);
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

    evictDocumentsUnderPath(sessionId, path, workbenchProjectId) {
        const scope = sessionViewScope(sessionId, workbenchProjectId);
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
        dropExternalEditorSessions(sessionIds);
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
            documents: without(state.documents),
            recentDocuments: without(state.recentDocuments),
        }));
    },

    /**
     * The desired ViewContainer is Session-owned intent; catalog availability never rewrites it.
     */
    setDesiredSecondarySidebarViewContainerId(id) {
        const current = getSessionState();
        if (current) patchSessionState({ ...current, desiredSecondarySidebarViewContainerId: id });
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
