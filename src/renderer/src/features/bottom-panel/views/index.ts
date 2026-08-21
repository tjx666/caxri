import type { BottomPanelView } from '@shared/bottom-panel';
import { bottomPanelViewRegistrations } from '@shared/bottom-panel';

import { infoView } from './info';
import { logsView } from './logs';
import type { AnyBottomPanelViewDefinition, BottomPanelViewDefinition } from './types';

/**
 * Compile-time check that every registered view has a Renderer component with the matching command. Adding a shared
 * registration without its Renderer implementation, or mismatching either id, fails build.
 */
const bottomPanelViewsById = {
    logs: logsView,
    info: infoView,
} satisfies { [View in BottomPanelView]: BottomPanelViewDefinition<View> };

/**
 * Tab order follows the shared Bottom Panel registration.
 */
export const bottomPanelViews: AnyBottomPanelViewDefinition[] = bottomPanelViewRegistrations.map(
    ({ view }) => bottomPanelViewsById[view],
);

export function getBottomPanelView(view: BottomPanelView): AnyBottomPanelViewDefinition {
    return bottomPanelViewsById[view];
}
