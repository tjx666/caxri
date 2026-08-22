import type { ComponentType } from 'react';

import type { ViewDescriptor } from '@shared/views';

import { TerminalInfoPanel } from '../panel/views/info/terminal-info-panel';
import { LogViewerPanel } from '../panel/views/logs/log-viewer-panel';
import { FileTreePanel } from '../secondary-sidebar/panels/files/file-tree-panel';
import { GitPanel } from '../secondary-sidebar/panels/git/git-panel';

/**
 * Component dispatch only; titles, order, commands, locations, and lifecycle come exclusively from the Host catalog.
 */
const builtinComponents = {
    files: FileTreePanel,
    git: GitPanel,
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
