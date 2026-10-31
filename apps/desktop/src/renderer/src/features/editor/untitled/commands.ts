import { untitledEditorTabPath } from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';

import { translate } from '../../../i18n';
import { getSelectedSession } from '../../../stores/selectors';
import {
    getSessionDocuments,
    sessionViewScope,
    useSessionViewStore,
} from '../../../stores/session-view';
import { pushToast } from '../../../stores/toasts';
import { revealSelectedSessionWorkbench } from '../../settings/settings-page-commands';
import { didOpenEditorTabForSession } from '../document-commands';
import { layoutDocumentPaths } from '../document-layout-paths';
import { focusEditor } from '../editor-reveal';
import { sessionStateOf } from '../session-pane-state';
import { emptyUntitledDocument, nextUntitledIndex } from './names';

/**
 * Opens a new `Untitled-N` buffer in the active pane of the selected Session and focuses it (VS Code's New Untitled
 * Text File). The buffer lives only in this Renderer until it is saved; it is pinned at once, because a preview slot
 * would discard it on the next file opened.
 */
export function openUntitledEditor(): void {
    const session = getSelectedSession();
    const state = session ? sessionStateOf(session.id) : undefined;
    if (!session || !state) return;
    revealSelectedSessionWorkbench(session.id);
    const workbenchRootProjectId = state.workbenchRootProjectId;
    const cachedPaths = Object.keys(getSessionDocuments(session.id, workbenchRootProjectId) ?? {});
    const path = untitledEditorTabPath(
        nextUntitledIndex([...layoutDocumentPaths(state.paneLayout), ...cachedPaths]),
    );
    const view = useSessionViewStore.getState();
    const isCached = view.cacheDocument(
        session.id,
        emptyUntitledDocument(path),
        workbenchRootProjectId,
    );
    if (!isCached || !didOpenEditorTabForSession(session.id, path)) {
        view.evictDocument(session.id, path, workbenchRootProjectId);
        pushToast('error', translate('editor.untitled.openFailed'));
        return;
    }
    focusEditor(editorModelPath(sessionViewScope(session.id, workbenchRootProjectId), path));
}
