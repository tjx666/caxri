import { useEffect } from 'react';

import { useActivePaneTab } from '../../workbench/pane-actions';
import { useIsViewContainerActive } from '../view-container-activity';
import { useResourceExplorerController } from './hooks/use-resource-explorer-controller';
import { ResourceExplorerContent } from './resource-explorer-content';
import { clearScopeRevealPath, followEditorFileInScope } from './resource-explorer-scope-store';
import { paneTabFilePath } from './resource-explorer-state';

export function ResourceExplorerView() {
    const controller = useResourceExplorerController();
    const isContainerActive = useIsViewContainerActive();

    if (!controller)
        return (
            <div className="empty-panel px-3 py-4 text-center text-muted">
                Create a Session to browse files.
            </div>
        );

    return (
        <>
            {isContainerActive && (
                <ResourceExplorerEditorFollower
                    projectRoot={controller.session.rootPath}
                    scopeId={controller.scopeId}
                />
            )}
            <ResourceExplorerContent controller={controller} />
        </>
    );
}

/**
 * Reveals the active work tab's file in the tree. It is the only Files subscriber to the pane layout, which moves on
 * every work-tab switch, and it mounts only while the container is visible: the kept-alive hidden view then renders
 * nothing at all for a tab switch, and the visible one re-renders this empty leaf instead of the whole tree (issue
 * #1716). Mounting again when the container is revealed follows the tab that is active by then.
 */
function ResourceExplorerEditorFollower({
    projectRoot,
    scopeId,
}: {
    projectRoot: string;
    scopeId: string;
}) {
    const activeFilePath = paneTabFilePath(useActivePaneTab());
    useEffect(() => {
        followEditorFileInScope(scopeId, projectRoot, activeFilePath);
    }, [activeFilePath, projectRoot, scopeId]);
    // Hiding the container unmounts the follower, and a reveal requested for a tree nobody sees must not fire later.
    useEffect(() => () => clearScopeRevealPath(scopeId), [scopeId]);
    return null;
}
