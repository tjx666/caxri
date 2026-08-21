import type { ComponentType } from 'react';

import type { BottomPanelCommandIdFor, BottomPanelView } from '@shared/bottom-panel';
import type { LucideIcon } from 'lucide-react';

/**
 * One entry in the Bottom Panel's view registry, covering both the tab bar and the view content. Mirrors
 * `features/inspector/panels/types.ts`, minus its `resetOnSessionChange` flag: every Bottom Panel view is either
 * process-wide (Logs) or scopes its own state to the selected Session internally (Info), so none of them remount on a
 * Session switch.
 */
export interface BottomPanelViewDefinition<View extends BottomPanelView> {
    id: View;
    title: string;
    icon: LucideIcon;
    Component: ComponentType;
    commandId: BottomPanelCommandIdFor<View>;
}

export type AnyBottomPanelViewDefinition = {
    [View in BottomPanelView]: BottomPanelViewDefinition<View>;
}[BottomPanelView];
