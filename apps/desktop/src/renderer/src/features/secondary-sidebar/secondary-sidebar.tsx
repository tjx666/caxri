import { useSessionState } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { ViewContainerSurface } from '../view-containers/view-container-surface';

export function SecondarySidebar() {
    const sessionState = useSessionState();
    const desiredId = sessionState?.desiredSecondarySidebarViewContainerId;
    return (
        <aside
            aria-label="Secondary Side Bar"
            className="secondary-sidebar flex min-h-0 min-w-0 flex-col bg-surface"
        >
            <ViewContainerSurface
                ariaLabel="Secondary Side Bar"
                desiredId={desiredId}
                location="secondarySidebar"
                hasUnscopedSelection={!sessionState}
                onSelect={(id) =>
                    useSessionViewStore.getState().setDesiredSecondarySidebarViewContainerId(id)
                }
            />
        </aside>
    );
}
