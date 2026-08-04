import { useEffect, useEffectEvent, useRef, type Dispatch, type SetStateAction } from 'react';

import {
    markTabsClean,
    replaceWithExternalDocument,
    setSessionDocument,
    type SessionDocuments,
} from '@shared/editor-state';
import type { FileDocument, SessionState } from '@shared/types';

const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

interface ExternalDocumentSyncOptions {
    documents: Record<string, FileDocument & { dirty: boolean }>;
    documentsBySession: SessionDocuments;
    persistSessionState: (state: SessionState, errorMessage?: string) => void;
    selectedSessionId?: string;
    sessionState?: SessionState;
    setDocumentsBySession: Dispatch<SetStateAction<SessionDocuments>>;
    showMessage: (message: string) => void;
}

function changedOnDisk(cached: FileDocument, current: FileDocument): boolean {
    return cached.mtimeMs !== current.mtimeMs || cached.size !== current.size;
}

export function useExternalDocumentSync({
    documents,
    documentsBySession,
    persistSessionState,
    selectedSessionId,
    sessionState,
    setDocumentsBySession,
    showMessage,
}: ExternalDocumentSyncOptions): void {
    const documentsRef = useRef(documents);
    const allDocumentsRef = useRef(documentsBySession);
    const sessionStateRef = useRef(sessionState);
    useEffect(() => {
        documentsRef.current = documents;
    }, [documents]);
    useEffect(() => {
        allDocumentsRef.current = documentsBySession;
    }, [documentsBySession]);
    useEffect(() => {
        sessionStateRef.current = sessionState;
    }, [sessionState]);

    const applyExternalDocuments = useEffectEvent((reloaded: FileDocument[]): void => {
        if (!selectedSessionId || reloaded.length === 0) return;
        setDocumentsBySession((current) =>
            reloaded.reduce(
                (next, document) =>
                    setSessionDocument(
                        next,
                        selectedSessionId,
                        replaceWithExternalDocument(document),
                    ),
                current,
            ),
        );
        const latestState = sessionStateRef.current;
        if (latestState?.sessionId === selectedSessionId) {
            persistSessionState(
                markTabsClean(
                    latestState,
                    reloaded.map((document) => document.path),
                ),
                'External editor state could not be saved',
            );
        }
        showMessage(
            reloaded.length === 1
                ? `${fileName(reloaded[0].path)} reloaded from disk; external changes take precedence.`
                : `${reloaded.length} open files reloaded from disk; external changes take precedence.`,
        );
    });

    useEffect(() => {
        const unsubscribe = window.caxri.onEvent((event) => {
            if (event.event !== 'files.changed' || event.payload.sessionId !== selectedSessionId)
                return;
            const changedPaths = event.payload.overflow
                ? (sessionStateRef.current?.openTabs.map((tab) => tab.path) ?? [])
                : event.payload.changes
                      .filter(
                          (change) => change.kind !== 'delete' && documentsRef.current[change.path],
                      )
                      .map((change) => change.path);
            const uniquePaths = [...new Set(changedPaths)];
            if (uniquePaths.length === 0) return;
            void Promise.allSettled(
                uniquePaths.map((path) =>
                    window.caxri.request<FileDocument>('files.read', {
                        sessionId: selectedSessionId,
                        path,
                    }),
                ),
            ).then((results) =>
                applyExternalDocuments(
                    results.flatMap((result) =>
                        result.status === 'fulfilled' ? [result.value] : [],
                    ),
                ),
            );
        });
        return unsubscribe;
    }, [selectedSessionId]);

    const previousSessionId = useRef<string | undefined>(undefined);
    useEffect(() => {
        const previous = previousSessionId.current;
        previousSessionId.current = selectedSessionId;
        if (!selectedSessionId || !previous || previous === selectedSessionId) return;
        const cached = allDocumentsRef.current[selectedSessionId] ?? {};
        const paths = (sessionStateRef.current?.openTabs ?? [])
            .map((tab) => tab.path)
            .filter((path) => cached[path]);
        if (paths.length === 0) return;
        let canceled = false;
        void Promise.allSettled(
            paths.map((path) =>
                window.caxri.request<FileDocument>('files.read', {
                    sessionId: selectedSessionId,
                    path,
                }),
            ),
        ).then((results) => {
            if (canceled) return;
            const changed = results.flatMap((result, index) => {
                if (result.status !== 'fulfilled') return [];
                const previousDocument = cached[paths[index]];
                return previousDocument && changedOnDisk(previousDocument, result.value)
                    ? [result.value]
                    : [];
            });
            applyExternalDocuments(changed);
        });
        return () => {
            canceled = true;
        };
    }, [selectedSessionId]);
}
