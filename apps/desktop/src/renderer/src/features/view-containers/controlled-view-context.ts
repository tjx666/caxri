import { createContext, useContext } from 'react';

import type {
    ControlledViewPresentation,
    ExtensionViewActionRole,
    ViewActionDescriptor,
} from '@caxri/protocol';

import type { ResourceExplorerClient } from './resource-explorer/resource-explorer-client';
import type { SourceControlClient } from './view-operation-client';

export interface ControlledViewContextValue {
    actions: readonly ViewActionDescriptor[];
    configurationDependencies: readonly string[];
    providerGeneration: number;
    presentation?: ControlledViewPresentation;
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
