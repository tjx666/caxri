import { createContext, useContext } from 'react';

import type { ExtensionViewActionRole, ViewActionDescriptor } from '@shared/views';

import type { ResourceExplorerClient, SourceControlClient } from './view-operation-client';

export interface ControlledViewContextValue {
    actions: readonly ViewActionDescriptor[];
    extensionGeneration: number;
    resourceExplorer?: ResourceExplorerClient;
    sourceControl?: SourceControlClient;
    viewId: string;
}

export const ControlledViewContext = createContext<ControlledViewContextValue | undefined>(
    undefined,
);

export function useControlledView(): ControlledViewContextValue {
    const value = useContext(ControlledViewContext);
    if (!value) throw new Error('Controlled view context is unavailable');
    return value;
}

export function useControlledViewActionCommand(role: ExtensionViewActionRole): string | undefined {
    return useControlledView().actions.find((action) => action.role === role)?.commandId;
}

export function useResourceExplorerClient(): ResourceExplorerClient {
    const client = useControlledView().resourceExplorer;
    if (!client) throw new Error('Resource Explorer client is unavailable');
    return client;
}

export function useSourceControlClient(): SourceControlClient {
    const client = useControlledView().sourceControl;
    if (!client) throw new Error('Source Control client is unavailable');
    return client;
}
