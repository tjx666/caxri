import type { SourceControlHistoryDescriptor } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';

import { useSelectedSession } from '../../../../stores/selectors';
import { useControlledView, useSourceControlClient } from '../../controlled-view-context';
import {
    isViewContainerQueryEnabled,
    useCancelViewContainerQueryWhenHidden,
    useIsViewContainerActive,
} from '../../view-container-activity';
import { controlledViewQueryKey } from '../../view-operation-client';

export function useSourceControlHistoryDetails(
    descriptor: SourceControlHistoryDescriptor,
    itemId: string,
    path: string | undefined,
) {
    const { viewId } = useControlledView();
    const client = useSourceControlClient();
    const session = useSelectedSession();
    const isContainerActive = useIsViewContainerActive();
    const request = {
        historyId: descriptor.id,
        itemId,
        revision: descriptor.revision!,
        ...(path && { path }),
    };
    const queryKey = controlledViewQueryKey(
        viewId,
        'source.historyDetails',
        request,
        session ? `${session.id}:${session.workbenchRootProjectId}` : undefined,
    );
    useCancelViewContainerQueryWhenHidden(queryKey, isContainerActive);
    return useQuery({
        queryKey,
        queryFn: ({ signal }) => client.historyDetails(request, signal),
        enabled: isViewContainerQueryEnabled(isContainerActive, Boolean(descriptor.revision)),
        staleTime: Infinity,
    });
}
