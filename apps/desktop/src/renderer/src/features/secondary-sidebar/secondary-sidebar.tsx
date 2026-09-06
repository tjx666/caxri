import { useCaxriQuery } from '../../queries/client';
import { useSelectedSession, useSessionState } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { ViewContainerSurface } from '../view-containers/view-container-surface';
import { statusBadge } from './status-badge';

export function SecondarySidebar() {
    const desiredId = useSessionState()?.desiredSecondarySidebarViewContainerId;
    const session = useSelectedSession();
    const status = useCaxriQuery(
        'projectStatus.summary',
        { sessionId: session?.id ?? '' },
        { enabled: Boolean(session) },
    );
    const badge = status.isError ? undefined : statusBadge(status.data);
    return (
        <aside
            aria-label="Secondary Side Bar"
            className="secondary-sidebar flex min-h-0 min-w-0 flex-col bg-surface"
        >
            <ViewContainerSurface
                ariaLabel="Secondary Side Bar"
                badges={{ 'caxri.project-status': badge }}
                desiredId={desiredId}
                location="secondarySidebar"
                onSelect={(id) =>
                    useSessionViewStore.getState().setDesiredSecondarySidebarViewContainerId(id)
                }
            />
        </aside>
    );
}
