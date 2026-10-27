import { useChromeLayoutStore } from '../../../stores/chrome-layout';
import { getBootstrap } from '../../../stores/selectors';
import { useSessionViewStore } from '../../../stores/session-view';
import { didRevealDirectoryInScope } from './resource-explorer-scope-store';

/**
 * The built-in Files ViewContainer in the Secondary Side Bar.
 */
const FILES_VIEW_CONTAINER_ID = 'caxri.files';

/**
 * Shows the Files explorer of `sessionId` with `path` selected and expanded, opening the Secondary Side Bar on Files
 * when it is hidden or showing another container. This is the same reveal the explorer applies when it follows an
 * editor tab, plus expanding the directory itself, so a clicked directory link lands in the tree rather than in an
 * editor.
 *
 * Call it after the Session is selected: the desired container is Session-owned state, and the tree draws the selected
 * Session. The Session's own root has no row to select, so a request for it only raises the Files view.
 */
export function revealDirectoryInFiles(sessionId: string, path: string): void {
    const session = getBootstrap()?.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    if (!useChromeLayoutStore.getState().secondarySidebarVisible)
        useChromeLayoutStore.getState().setSecondarySidebarVisible(true);
    useSessionViewStore
        .getState()
        .setDesiredSecondarySidebarViewContainerId(FILES_VIEW_CONTAINER_ID);
    didRevealDirectoryInScope(
        `${session.id}:${session.workbenchRootProjectId}`,
        session.rootPath,
        path,
    );
}
