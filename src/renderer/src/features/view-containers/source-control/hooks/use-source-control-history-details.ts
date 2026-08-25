import type { SourceControlHistoryDescriptor } from '@shared/views';
import { useQuery } from '@tanstack/react-query';

import { useSelectedSession } from '../../../../stores/selectors';
import { useControlledView, useSourceControlClient } from '../../controlled-view-context';
import { controlledViewQueryKey } from '../../view-operation-client';

export function useSourceControlHistoryDetails(
    descriptor: SourceControlHistoryDescriptor,
    itemId: string,
    path: string | undefined,
) {
    const { viewId } = useControlledView();
    const client = useSourceControlClient();
    const session = useSelectedSession();
    const request = {
        historyId: descriptor.id,
        itemId,
        revision: descriptor.revision!,
        ...(path && { path }),
    };
    return useQuery({
        queryKey: controlledViewQueryKey(
            viewId,
            'source.historyDetails',
            request,
            session ? `${session.id}:${session.workbenchProjectId}` : undefined,
        ),
        queryFn: ({ signal }) => client.historyDetails(request, signal),
        enabled: Boolean(descriptor.revision),
        staleTime: Infinity,
    });
}
