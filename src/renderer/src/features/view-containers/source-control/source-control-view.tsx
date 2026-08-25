import { useSourceControlController } from './hooks/use-source-control-controller';
import { SourceControlContent } from './source-control-content';

/**
 * Mounted with `key={session.id}` by the SecondarySidebar shell. The controller retains navigation per Workbench Root
 * so switching roots clears stale selection while a later return restores it.
 */
export function SourceControlView() {
    const controller = useSourceControlController();
    return <SourceControlContent controller={controller} />;
}
