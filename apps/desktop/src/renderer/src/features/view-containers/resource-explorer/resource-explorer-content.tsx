import { FileConflictDialog } from './file-conflict-dialog';
import { FileTree } from './file-tree';
import type { ResourceExplorerController } from './hooks/use-resource-explorer-controller';
import { PendingFileOperationStatus } from './pending-file-operation-status';
import { ResourceExplorerHeader } from './resource-explorer-header';

export function ResourceExplorerContent({
    controller,
}: {
    controller: ResourceExplorerController;
}) {
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
            <FileTree
                // Keyed by Project, not Session: switching between Sessions of one Project keeps the mounted tree
                // (each Session's expansion/selection lives in the scope store), while another Project gets a fresh one.
                key={`${controller.projectId}:${controller.collapseRevision}`}
                controller={controller}
            />
            <FileConflictDialog />
        </div>
    );
}
