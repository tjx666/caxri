import type { InspectorMode } from '@shared/types';

import { filesPanel } from './files';
import { gitPanel } from './git';
import { infoPanel } from './info';
import { statusPanel } from './status';
import type { InspectorPanelDefinition } from './types';

export type { InspectorPanelDefinition } from './types';

/** Tab order in the Inspector shell follows this array's order. */
export const inspectorPanels: InspectorPanelDefinition[] = [
    filesPanel,
    gitPanel,
    statusPanel,
    infoPanel,
];

/**
 * Compile-time check that `inspectorPanels` covers every `InspectorMode` exactly once. Adding a
 * new mode to the shared schema without registering a matching panel here fails the build.
 */
const inspectorPanelsByMode = {
    files: filesPanel,
    git: gitPanel,
    status: statusPanel,
    info: infoPanel,
} satisfies Record<InspectorMode, InspectorPanelDefinition>;

export function getInspectorPanel(mode: InspectorMode): InspectorPanelDefinition {
    return inspectorPanelsByMode[mode];
}
