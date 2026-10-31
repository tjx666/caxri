import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MobileDesktopUpdateResult } from '@caxri/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';

import { useMobileClient } from '../connection/mobile-client-provider';
import type { DesktopUpdatePhase } from './desktop-update-model';
import { isDesktopUpdateMoving } from './desktop-update-model';

/**
 * How often Settings re-reads while a check or download is moving on the computer.
 */
const MOVING_POLL_MS = 2_000;

const desktopUpdateQueryKey = (scope: string) => ['mobile', 'desktop-update', scope] as const;

/**
 * The paired computer's app update for a control device. Read when Settings opens, and re-read every
 * {@link MOVING_POLL_MS} only while a check or download is still moving there. A restart the computer accepted stays
 * `restarting` until the first read over a later connection, whichever version that reports: a restart that failed
 * comes back on the old one.
 */
export const useDesktopUpdate = (isControl: boolean) => {
    const { connectionEpoch, connectionScopeKey, isForeground, request, status } =
        useMobileClient();
    const queryClient = useQueryClient();
    const isFocused = useIsFocused();
    const scope = connectionScopeKey ?? 'unpaired';
    const queryKey = useMemo(() => desktopUpdateQueryKey(scope), [scope]);
    const isObservable =
        isControl && connectionScopeKey !== null && isForeground && status === 'connected';
    const [phase, setPhase] = useState<DesktopUpdatePhase>({ kind: 'idle' });
    /**
     * The connection and clock the accepted restart started on.
     */
    const restartMark = useRef<{ epoch: number; at: number } | undefined>(undefined);
    const query = useQuery({
        enabled: isObservable && isFocused,
        gcTime: 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.desktopUpdate.read', {}),
        queryKey,
        refetchInterval: (current) =>
            isObservable && isFocused && isDesktopUpdateMoving(current.state.data)
                ? MOVING_POLL_MS
                : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    const result = query.data;
    const { dataUpdatedAt } = query;
    useEffect(() => {
        const mark = restartMark.current;
        if (!mark || phase.kind !== 'restarting') return;
        if (dataUpdatedAt > mark.at && connectionEpoch !== mark.epoch) {
            restartMark.current = undefined;
            setPhase({ kind: 'idle' });
        }
    }, [connectionEpoch, dataUpdatedAt, phase]);
    const store = useCallback(
        (next: MobileDesktopUpdateResult) => queryClient.setQueryData(queryKey, next),
        [queryClient, queryKey],
    );
    const check = useCallback(async () => {
        setPhase({ kind: 'idle' });
        store(await request('mobile.desktopUpdate.read', { check: true }));
    }, [request, store]);
    const download = useCallback(async () => {
        setPhase({ kind: 'idle' });
        store(await request('mobile.desktopUpdate.download', {}));
    }, [request, store]);
    const install = useCallback(
        async (version: string) => {
            const answer = await request('mobile.desktopUpdate.install', { version });
            if (answer.outcome === 'restarting')
                restartMark.current = { epoch: connectionEpoch, at: Date.now() };
            setPhase(
                answer.outcome === 'restarting'
                    ? { kind: 'restarting', version: answer.version }
                    : {
                          kind: 'blocked',
                          reason: answer.reason,
                          ...(answer.unsavedEditorCount !== undefined && {
                              unsavedEditorCount: answer.unsavedEditorCount,
                          }),
                      },
            );
            if (answer.outcome === 'blocked') await query.refetch();
        },
        [connectionEpoch, query, request],
    );
    return { check, download, install, isObservable, phase, result };
};
