import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { ControlledViewPresentation, ViewActionDescriptor } from '@shared/views';

import { useSelectedSession } from '../../stores/selectors';
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
    const session = useSelectedSession();
    const sessionId = session?.id;
    const workbenchProjectId = session?.workbenchProjectId;
    const value = useMemo<ControlledViewContextValue>(() => {
        const context =
            sessionId && workbenchProjectId
                ? { kind: 'session' as const, sessionId, workbenchProjectId }
                : { kind: 'no-session' as const };
        return {
            actions,
            configurationDependencies: configDependencies,
            providerGeneration,
            presentation,
            viewId,
            ...(kind === 'resource-explorer'
                ? { resourceExplorer: createResourceExplorerClient(viewId, sessionId) }
                : { sourceControl: createSourceControlClient(viewId, context) }),
        };
    }, [
        actions,
        configDependencies,
        kind,
        presentation,
        providerGeneration,
        sessionId,
        viewId,
        workbenchProjectId,
    ]);
    return <ControlledViewContext value={value}>{children}</ControlledViewContext>;
}
