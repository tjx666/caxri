import { useResourceExplorerController } from './hooks/use-resource-explorer-controller';
import { ResourceExplorerContent } from './resource-explorer-content';

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
