import { GitPanelView } from './git-panel-view';
import { useGitPanelController } from './use-git-panel-controller';

/**
 * Mounted with `key={session.id}` by the SecondarySidebar shell. The controller retains navigation per Workbench Root
 * so switching roots clears stale selection while a later return restores it.
 */
export function GitPanel() {
    const controller = useGitPanelController();
    return <GitPanelView controller={controller} />;
}
