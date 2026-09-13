import { useState } from 'react';

import type { ViewContainerId } from '@caxri/protocol';

import { useSessionState } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { ViewContainerSurface } from '../view-containers/view-container-surface';

export function SecondarySidebar() {
    const sessionState = useSessionState();
    const [unscopedDesiredId, setUnscopedDesiredId] = useState<ViewContainerId>();
    const desiredId = sessionState
        ? sessionState.desiredSecondarySidebarViewContainerId
        : unscopedDesiredId;
    return (
        <aside
            aria-label="Secondary Side Bar"
            className="secondary-sidebar flex min-h-0 min-w-0 flex-col bg-surface"
        >
            <ViewContainerSurface
                ariaLabel="Secondary Side Bar"
                desiredId={desiredId}
                location="secondarySidebar"
                onSelect={(id) => {
                    if (sessionState)
                        useSessionViewStore
                            .getState()
                            .setDesiredSecondarySidebarViewContainerId(id);
                    else setUnscopedDesiredId(id);
                }}
            />
        </aside>
    );
}
