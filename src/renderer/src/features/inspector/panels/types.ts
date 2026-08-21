import type { ComponentType } from 'react';

import type { InspectorCommandIdFor, InspectorMode } from '@shared/inspector';
import type { LucideIcon } from 'lucide-react';

/**
 * One entry in the Inspector's panel registry, covering both the tab bar and the panel content.
 */
export interface InspectorPanelDefinition<Mode extends InspectorMode> {
    id: Mode;
    title: string;
    icon: LucideIcon;
    Component: ComponentType;
    commandId: InspectorCommandIdFor<Mode>;
    /**
     * When true, the panel is mounted with `key={sessionId}` so it fully remounts whenever the selected Session
     * changes, per the project-architecture Session-isolation contract. Git and Status keep repository/diff selection
     * and expansion state that must not leak across Sessions. Files already scopes its state to the selected Session
     * internally, so it stays mounted.
     */
    resetOnSessionChange: boolean;
}

export type AnyInspectorPanelDefinition = {
    [Mode in InspectorMode]: InspectorPanelDefinition<Mode>;
}[InspectorMode];
