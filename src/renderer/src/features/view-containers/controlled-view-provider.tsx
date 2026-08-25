import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { ViewActionDescriptor } from '@shared/views';

import { useSelectedSession } from '../../stores/selectors';
import type { ControlledViewContextValue } from './controlled-view-context';
import { ControlledViewContext } from './controlled-view-context';
import { createResourceExplorerClient, createSourceControlClient } from './view-operation-client';

const emptyActions: readonly ViewActionDescriptor[] = [];

export function ControlledViewProvider({
    actions = emptyActions,
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
            extensionGeneration,
            viewId,
            ...(kind === 'resource-explorer'
                ? { resourceExplorer: createResourceExplorerClient(viewId, context) }
                : { sourceControl: createSourceControlClient(viewId, context) }),
        };
    }, [actions, extensionGeneration, kind, sessionId, viewId, workbenchProjectId]);
    return <ControlledViewContext value={value}>{children}</ControlledViewContext>;
}
