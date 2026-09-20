import { DirectoryEntries } from './directory-entries';
import { FileConflictDialog } from './file-conflict-dialog';
import { FileTreeRootContextMenu } from './file-tree-root-context-menu';
import { PendingFileOperationStatus } from './pending-file-operation-status';
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
                // Keyed by Project, not Session: switching between Sessions of one Project keeps the mounted tree
                // (each Session's expansion/selection lives in the scope store), while another Project gets a fresh one.
                key={`${controller.projectId}:${controller.collapseRevision}`}
                directory={controller.session.rootPath}
                editing={controller.editing}
                projectId={controller.projectId}
                projectRoot={controller.session.rootPath}
                scopeId={controller.scopeId}
                sessionId={controller.session.id}
                requestFocus={controller.requestFocus}
                setEditing={controller.setEditing}
            />
        </div>
    );

    return (
        <div
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
            <FileTreeRootContextMenu controller={controller}>{tree}</FileTreeRootContextMenu>
            <FileConflictDialog />
        </div>
    );
}
