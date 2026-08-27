import { DirectoryEntries } from './directory-entries';
import { FileConflictDialog } from './file-conflict-dialog';
import { FileTreeRootContextMenu } from './file-tree-root-context-menu';
import { PendingFileOperationStatus } from './pending-file-operation-status';
import { ProjectSearch } from './project-search';
import { ResourceExplorerHeader } from './resource-explorer-header';
import type { ResourceExplorerController } from './use-resource-explorer-controller';

export function ResourceExplorerContent({
    controller,
}: {
    controller: ResourceExplorerController;
}) {
    const tree = (
        <div
            role="tree"
            aria-label="Files"
            className="min-h-0 flex-1 overflow-auto"
            onDragOver={controller.onProjectRootDragOver}
            onDrop={controller.dropIntoProjectRoot}
        >
            <DirectoryEntries
                clearFocusPath={controller.clearFocusPath}
                key={`${controller.scopeId}:${controller.collapseRevision}`}
                directory={controller.session.rootPath}
                editing={controller.editing}
                expandedPaths={controller.expandedPaths}
                operations={controller.projectOperations}
                focusPath={controller.focusPath}
                projectId={controller.projectId}
                projectRoot={controller.session.rootPath}
                selectedPath={controller.selectedPath}
                sessionId={controller.session.id}
                requestFocus={controller.requestFocus}
                setEditing={controller.setEditing}
                setPathExpanded={controller.setPathExpanded}
                setSelectedPath={controller.setSelectedPath}
            />
        </div>
    );

    return (
        <div
            key={controller.scopeId}
            aria-busy={Boolean(controller.pendingOperation)}
            className="secondary-sidebar-content flex min-h-0 flex-1 flex-col overflow-hidden"
        >
            <ResourceExplorerHeader controller={controller} />
            {controller.pendingOperation && (
                <PendingFileOperationStatus
                    isCancelRevealed={controller.isCancelRevealed}
                    operation={controller.pendingOperation}
                    onCancel={controller.cancelPendingOperation}
                />
            )}
            {controller.isSearchVisible ? (
                <ProjectSearch
                    key={controller.scopeId}
                    focusRevision={controller.searchFocusRevision}
                    sessionId={controller.session.id}
                    scopeId={controller.scopeId}
                />
            ) : (
                <FileTreeRootContextMenu controller={controller}>{tree}</FileTreeRootContextMenu>
            )}
            <FileConflictDialog />
        </div>
    );
}
