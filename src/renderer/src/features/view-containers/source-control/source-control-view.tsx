import { SourceControlContent } from './source-control-content';
import { useSourceControlController } from './use-source-control-controller';

/**
 * Mounted with `key={session.id}` by the SecondarySidebar shell. The controller retains navigation per Workbench Root
 * so switching roots clears stale selection while a later return restores it.
 */
export function SourceControlView() {
    const controller = useSourceControlController();
    return <SourceControlContent controller={controller} />;
}
