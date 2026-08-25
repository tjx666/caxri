import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { ViewActionDescriptor } from '@shared/views';

import type { ControlledViewContextValue } from './controlled-view-context';
import { ControlledViewContext } from './controlled-view-context';
import { createResourceExplorerClient, createSourceControlClient } from './view-operation-client';

export function ControlledViewProvider({
    actions = [],
    children,
    extensionGeneration,
    kind,
    viewId,
}: {
    actions?: readonly ViewActionDescriptor[];
    children: ReactNode;
    extensionGeneration: number;
    kind: 'resource-explorer' | 'source-control';
    viewId: string;
}) {
    const value = useMemo<ControlledViewContextValue>(
        () => ({
            actions,
            extensionGeneration,
            viewId,
            ...(kind === 'resource-explorer'
                ? { resourceExplorer: createResourceExplorerClient(viewId) }
                : { sourceControl: createSourceControlClient(viewId) }),
        }),
        [actions, extensionGeneration, kind, viewId],
    );
    return <ControlledViewContext value={value}>{children}</ControlledViewContext>;
}
