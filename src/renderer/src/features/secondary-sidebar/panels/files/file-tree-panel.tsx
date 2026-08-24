import { FileTreePanelView } from './file-tree-panel-view';
import { useFileTreePanelController } from './use-file-tree-panel-controller';

export function FileTreePanel() {
    const controller = useFileTreePanelController();

    if (!controller)
        return (
            <div className="empty-panel px-3 py-4 text-center text-muted">
                Create a Session to browse files.
            </div>
        );

    return <FileTreePanelView controller={controller} />;
}
