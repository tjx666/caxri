import { externalEditorTabPath, isPathAtOrBelow, remapPaneLayoutPaths } from '@caxri/protocol';
import type { EditorDocument } from '@desktop-shared/editor-state';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { getBootstrap } from '../../../stores/selectors';
import {
    getSessionDocuments,
    sessionViewScope,
    useSessionViewStore,
} from '../../../stores/session-view';
import { patchSessionState } from '../../../stores/workbench';
import { sessionStateOf } from '../session-pane-state';
import { forgetUntitledLanguage } from './language-detection-client';
import { untitledLanguageKey, useUntitledLanguageStore } from './language-store';
import { untitledSaveAsBaseName, untitledSuggestedFileName } from './names';

export type UntitledSaveOutcome = 'canceled' | 'saved' | 'unavailable';

/**
 * Save As for one untitled buffer: Main asks where to save and writes the file, then the tab is replaced in place by
 * the saved file, keeping its pane, position, and tab ID. A file saved inside the Session's Project reopens as a
 * Project file; anywhere else it becomes an external document (ADR 0013).
 *
 * Rejects when Main could not write the file, so the caller's save toast reports the reason.
 */
export async function saveUntitledDocument(
    sessionId: string,
    path: string,
): Promise<UntitledSaveOutcome> {
    const session = getBootstrap()?.sessions.find((candidate) => candidate.id === sessionId);
    const document = getSessionDocuments(sessionId)?.[path];
    if (!session || !document) return 'unavailable';
    const scope = sessionViewScope(sessionId, session.workbenchProjectId);
    const languageKey = untitledLanguageKey(scope, path);
    const extension = useUntitledLanguageStore.getState().candidates[languageKey]?.[0];
    const fileName = untitledSuggestedFileName(
        untitledSaveAsBaseName(path, document.content),
        extension,
    );
    const result = await caxri.request('editor.saveUntitled', {
        defaultPath: `${session.rootPath.replace(/\/$/, '')}/${fileName}`,
        content: document.content,
    });
    if ('canceled' in result) return 'canceled';
    const saved = result.document;
    const isProjectFile = isPathAtOrBelow(saved.displayPath, session.rootPath);
    const nextPath = isProjectFile
        ? saved.displayPath
        : externalEditorTabPath(saved.id, saved.name);
    const current = getSessionDocuments(sessionId, session.workbenchProjectId)?.[path];
    const nextDocument: EditorDocument = {
        path: nextPath,
        content: current?.content ?? saved.content,
        mtimeMs: saved.mtimeMs,
        size: saved.size,
        // Typing that arrived while the dialog was open is newer than what Main wrote.
        dirty: current !== undefined && current.content !== saved.content,
        ...(!isProjectFile && { ephemeral: true, displayPath: saved.displayPath }),
    };
    const view = useSessionViewStore.getState();
    // An external document over the ephemeral budget cannot be cached; keep the untitled buffer rather than lose it.
    if (!view.cacheDocument(sessionId, nextDocument, session.workbenchProjectId))
        throw new Error(
            translate('editor.untitled.savedButNotReopened', { path: saved.displayPath }),
        );
    view.evictDocument(sessionId, path, session.workbenchProjectId);
    forgetUntitledLanguage(languageKey);
    const state = sessionStateOf(sessionId);
    if (state?.workbenchProjectId === session.workbenchProjectId)
        patchSessionState({
            ...state,
            paneLayout: remapPaneLayoutPaths(state.paneLayout, (tabPath) =>
                tabPath === path ? nextPath : tabPath,
            ),
        });
    return 'saved';
}
