import { lazy, Suspense, useEffect } from 'react';

import { editorModelPath } from '@shared/editor-state';

import { useSelectedSession, useTheme } from '../../state/selectors';
import { useDocument } from '../../state/session-view';
import { cacheDocument, changeDocument } from './document-actions';

const CodeEditor = lazy(() => import('./CodeEditor'));

/**
 * Renders the focused editor tab. A tab whose content is not cached — restored from a previous run,
 * or evicted by the document cache cap — reads it on demand instead of being closed.
 */
export function EditorSurface({ path }: { path: string }) {
    const sessionId = useSelectedSession()?.id;
    const theme = useTheme();
    const document = useDocument(sessionId, path);

    useEffect(() => {
        if (!sessionId || document) return;
        void cacheDocument(sessionId, path);
    }, [document, path, sessionId]);

    if (!sessionId || !theme) return null;
    if (!document) return <div className="empty-work">Loading file…</div>;
    return (
        <Suspense fallback={<div className="empty-work">Loading editor…</div>}>
            <CodeEditor
                path={editorModelPath(sessionId, path)}
                value={document.content}
                theme={theme}
                onChange={(content) => changeDocument(path, content ?? '')}
            />
        </Suspense>
    );
}
