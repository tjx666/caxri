import { inspectorModeRegistrations, type InspectorMode } from '@shared/inspector';

import { filesPanel } from './files';
import { gitPanel } from './git';
import { infoPanel } from './info';
import { statusPanel } from './status';
import type { AnyInspectorPanelDefinition, InspectorPanelDefinition } from './types';

/**
 * Compile-time check that every registered mode has a panel with the matching command. Adding a
 * shared registration without its Renderer implementation, or mismatching either id, fails build.
 */
const inspectorPanelsByMode = {
    files: filesPanel,
    git: gitPanel,
    status: statusPanel,
    info: infoPanel,
} satisfies { [Mode in InspectorMode]: InspectorPanelDefinition<Mode> };

/** Tab order follows the shared Inspector registration. */
export const inspectorPanels: AnyInspectorPanelDefinition[] = inspectorModeRegistrations.map(
    ({ mode }) => inspectorPanelsByMode[mode],
);

export function getInspectorPanel(mode: InspectorMode): AnyInspectorPanelDefinition {
    return inspectorPanelsByMode[mode];
}
