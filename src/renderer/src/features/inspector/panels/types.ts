import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

import type { InspectorCommandIdFor, InspectorMode } from '@shared/inspector';

/** One entry in the Inspector's panel registry, covering both the tab bar and the panel content. */
export interface InspectorPanelDefinition<Mode extends InspectorMode> {
    id: Mode;
    title: string;
    icon: LucideIcon;
    Component: ComponentType;
    commandId: InspectorCommandIdFor<Mode>;
    /**
     * When true, the panel is mounted with `key={sessionId}` so it fully remounts whenever the
     * selected Session changes, per the project-architecture Session-isolation contract. Git and
     * Status keep repository/diff selection and expansion state that must not leak across Sessions.
     * Files and Info already scope their state to the selected Session internally, so they stay
     * mounted.
     */
    resetOnSessionChange: boolean;
}

export type AnyInspectorPanelDefinition = {
    [Mode in InspectorMode]: InspectorPanelDefinition<Mode>;
}[InspectorMode];
