import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { ControlledViewPresentation, ViewActionDescriptor } from '@caxri/protocol';

import type { ControlledViewContextValue } from './controlled-view-context';
import { ControlledViewContext } from './controlled-view-context';
import { createResourceExplorerClient } from './resource-explorer/resource-explorer-client';
import { createSourceControlClient } from './view-operation-client';

const emptyActions: readonly ViewActionDescriptor[] = [];
const emptyConfigDependencies: readonly string[] = [];

export function ControlledViewProvider({
    actions = emptyActions,
    configurationDependencies: configDependencies = emptyConfigDependencies,
    children,
    providerGeneration,
    kind,
    presentation,
    viewId,
}: {
    actions?: readonly ViewActionDescriptor[];
    configurationDependencies?: readonly string[];
    children: ReactNode;
    providerGeneration: number;
    kind: 'resource-explorer' | 'source-control';
    presentation?: ControlledViewPresentation;
    viewId: string;
}) {
    /**
     * Deliberately independent of the selected Session. A context value that changed identity on every switch
     * re-rendered every consumer beneath it, which for the Files view is all 49 visible rows and their context-menu
     * wrappers, roughly 550 of the 699 component updates one Session switch used to cost. Both clients resolve the
     * current Session when a request is actually made instead, so nothing here has to move.
     */
    const value = useMemo<ControlledViewContextValue>(
        () => ({
            actions,
            configurationDependencies: configDependencies,
            providerGeneration,
            presentation,
            viewId,
            ...(kind === 'resource-explorer'
                ? { resourceExplorer: createResourceExplorerClient(viewId) }
                : { sourceControl: createSourceControlClient(viewId) }),
        }),
        [actions, configDependencies, kind, presentation, providerGeneration, viewId],
    );
    return <ControlledViewContext value={value}>{children}</ControlledViewContext>;
}
