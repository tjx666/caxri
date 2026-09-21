import type { ComponentType } from 'react';

import type { ViewDescriptor } from '@caxri/protocol';

import { AgentActivityView } from '../agent-activity/agent-activity-view';
import { TerminalInfoPanel } from '../panel/views/info/terminal-info-panel';
import { LogViewerPanel } from '../panel/views/logs/log-viewer-panel';

/**
 * Component dispatch only; titles, order, commands, locations, and lifecycle come exclusively from the Server catalog.
 */
const builtinComponents = {
    activity: AgentActivityView,
    info: TerminalInfoPanel,
    logs: LogViewerPanel,
} satisfies Record<
    Extract<ViewDescriptor['viewKind'], { kind: 'builtin-react' }>['component'],
    ComponentType
>;

export function getBuiltinViewComponent(
    component: Extract<ViewDescriptor['viewKind'], { kind: 'builtin-react' }>['component'],
): ComponentType {
    return builtinComponents[component];
}
