import { ResourceExplorerContent } from './resource-explorer-content';
import { useResourceExplorerController } from './use-resource-explorer-controller';

export function ResourceExplorerView() {
    const controller = useResourceExplorerController();

    if (!controller)
        return (
            <div className="empty-panel px-3 py-4 text-center text-muted">
                Create a Session to browse files.
            </div>
        );

    return <ResourceExplorerContent controller={controller} />;
}
